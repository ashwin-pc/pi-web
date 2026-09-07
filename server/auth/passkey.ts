import type { IncomingMessage, ServerResponse } from "node:http";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import { AuthKernel, hashSecret, isLoopback, type AuthStore } from "./kernel.js";

const challenges = new Map<string, { challenge: string; expiresAt: number; kind: "register" | "login"; bootstrapHash?: string }>();
const MAX_CHALLENGES = 256;
function rememberChallenge(challenge: string, value: (typeof challenges extends Map<string, infer V> ? V : never)) {
  const now = Date.now();
  for (const [key, pending] of challenges) if (pending.expiresAt <= now) challenges.delete(key);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  challenges.set(challenge, value);
}
function bootstrapRequiresLoopback(config: PasskeyConfig) { return new URL(config.origin).hostname === "localhost"; }
function clientChallenge(response: unknown): string | undefined {
  try {
    const value = (response as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
    if (typeof value !== "string") return undefined;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : undefined;
  } catch { return undefined; }
}
function json(res: ServerResponse, status: number, value: unknown) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }); res.end(body); }
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 1_000_000) throw new Error("Body too large"); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

export type PasskeyConfig = { rpID: string; rpName: string; origin: string };
export async function handlePasskeyRoute(req: IncomingMessage, res: ServerResponse, url: URL, kernel: AuthKernel, store: AuthStore, config: PasskeyConfig): Promise<boolean> {
  if (!url.pathname.startsWith("/api/auth/")) return false;
  if (!url.pathname.includes("bootstrap") && !kernel.methods.has("passkey")) return false;
  if (req.method === "GET" && url.pathname === "/api/auth/challenge") { json(res, 200, { mode: "redirect", url: "/api/auth/login" }); return true; }
  if (req.method === "GET" && (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/passkey-login" || url.pathname === "/api/auth/passkey-bootstrap")) {
    if (url.pathname.endsWith("bootstrap") && bootstrapRequiresLoopback(config) && !isLoopback(req)) { json(res, 403, { ok: false, error: "Bootstrap is localhost-only" }); return true; }
    const bootstrap = url.pathname.endsWith("bootstrap"); const token = bootstrap ? url.searchParams.get("token") || "" : "";
    const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>pi-web ${bootstrap ? "passkey enrollment" : "login"}</title><style>body{font:16px system-ui;max-width:34rem;margin:12vh auto;padding:2rem;background:#111;color:#eee}button,input{font:inherit;padding:.7rem;margin:.4rem 0;width:100%}small{color:#aaa}</style><h1>${bootstrap ? "Enroll a passkey" : "Sign in to pi-web"}</h1><p>${bootstrap ? "Use a synced passkey, then create a second recovery credential with another terminal bootstrap." : "Authenticate with your passkey."}</p>${bootstrap ? '<input id="name" placeholder="Credential name" value="Primary passkey">' : ""}<button id="go">${bootstrap ? "Create passkey" : "Sign in"}</button><p id="status"></p><script>const nameInput=document.getElementById('name'),statusElement=document.getElementById('status'),go=document.getElementById('go');const cv=v=>{let s=v.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}, enc=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); go.onclick=async()=>{try{statusElement.textContent='Waiting for authenticator…';const boot=${JSON.stringify(bootstrap)}, payload=boot?{token:${JSON.stringify(token).replace(/</g, "\\u003c")},name:nameInput?.value||'Passkey'}:{};let o=await fetch(boot?'/api/auth/bootstrap/options':'/api/auth/passkey/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).then(async r=>{if(!r.ok)throw Error((await r.json()).error);return r.json()});o.challenge=cv(o.challenge);if(boot){o.user.id=cv(o.user.id);o.excludeCredentials?.forEach(x=>x.id=cv(x.id))}else{o.allowCredentials?.forEach(x=>x.id=cv(x.id))}const c=boot?await navigator.credentials.create({publicKey:o}):await navigator.credentials.get({publicKey:o});const response={id:c.id,rawId:enc(c.rawId),type:c.type,response:{clientDataJSON:enc(c.response.clientDataJSON),authenticatorData:c.response.authenticatorData&&enc(c.response.authenticatorData),signature:c.response.signature&&enc(c.response.signature),userHandle:c.response.userHandle&&enc(c.response.userHandle),attestationObject:c.response.attestationObject&&enc(c.response.attestationObject)},clientExtensionResults:c.getClientExtensionResults()};const r=await fetch(boot?'/api/auth/bootstrap/verify':'/api/auth/passkey/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(boot?{response,name:nameInput?.value||'Passkey'}:response)});if(!r.ok)throw Error((await r.json()).error);location.href='/'}catch(e){statusElement.textContent=e.message}}</script>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); res.end(html); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/passkey/options") {
    const state = await store.read();
    const options = await generateAuthenticationOptions({ rpID: config.rpID, allowCredentials: state.credentials.filter(c => !c.revokedAt).map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] | undefined })), userVerification: "required" });
    rememberChallenge(options.challenge, { challenge: options.challenge, expiresAt: Date.now() + 120_000, kind: "login" }); json(res, 200, options); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/passkey/verify") {
    const response = await body(req) as AuthenticationResponseJSON; const challenge = clientChallenge(response);
    if (!challenge) { json(res, 400, { ok: false, error: "Malformed authenticator response" }); return true; }
    const pending = challenges.get(challenge);
    if (!pending || pending.kind !== "login" || pending.expiresAt < Date.now() || !challenges.delete(pending.challenge)) { json(res, 400, { ok: false, error: "Expired challenge" }); return true; }
    const state = await store.read(); const record = state.credentials.find(c => c.id === response.id && !c.revokedAt); if (!record) { json(res, 401, { ok: false, error: "Unknown credential" }); return true; }
    const credential: WebAuthnCredential = { id: record.id, publicKey: bytes(record.publicKey), counter: record.counter, transports: record.transports as AuthenticatorTransport[] | undefined };
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, credential, requireUserVerification: true });
    if (!result.verified) { json(res, 401, { ok: false, error: "Verification failed" }); return true; }
    await store.update(s => { const found = s.credentials.find(c => c.id === record.id); if (found) found.counter = result.authenticationInfo.newCounter; }); await kernel.establishSession(res, { id: "owner", displayName: "Owner" }, "passkey", req, true, { passkeyId: record.id }); json(res, 200, { ok: true }); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/bootstrap/options") {
    if (bootstrapRequiresLoopback(config) && !isLoopback(req)) { json(res, 403, { ok: false, error: "Bootstrap requires loopback access for localhost origins" }); return true; }
    const input = await body(req) as { token?: string; name?: string }; const state = await store.read();
    if (!input.token || !state.bootstrap || state.bootstrap.usedAt || state.bootstrap.expiresAt < Date.now() || hashSecret(input.token) !== state.bootstrap.hash) { json(res, 401, { ok: false, error: "Invalid bootstrap token" }); return true; }
    const options = await generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpID, userName: "pi-web-owner", userDisplayName: "Pi Web Owner", attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, excludeCredentials: state.credentials.filter(c => !c.revokedAt).map(c => ({ id: c.id })) });
    rememberChallenge(options.challenge, { challenge: options.challenge, expiresAt: Date.now() + 120_000, kind: "register", bootstrapHash: state.bootstrap.hash }); json(res, 200, options); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/bootstrap/verify") {
    if (bootstrapRequiresLoopback(config) && !isLoopback(req)) { json(res, 403, { ok: false, error: "Bootstrap requires loopback access for localhost origins" }); return true; }
    const input = await body(req) as { response: RegistrationResponseJSON; name?: string }; const challenge = clientChallenge(input.response);
    if (!challenge) { json(res, 400, { ok: false, error: "Malformed authenticator response" }); return true; }
    const pending = challenges.get(challenge);
    if (!pending || pending.kind !== "register" || pending.expiresAt < Date.now() || !pending.bootstrapHash || !challenges.delete(pending.challenge)) { json(res, 400, { ok: false, error: "Expired challenge" }); return true; }
    const result = await verifyRegistrationResponse({ response: input.response, expectedChallenge: pending.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo) { json(res, 401, { ok: false, error: "Verification failed" }); return true; }
    const c = result.registrationInfo.credential;
    await store.update(s => { if (!s.bootstrap || s.bootstrap.hash !== pending.bootstrapHash || s.bootstrap.usedAt || s.bootstrap.expiresAt <= Date.now()) throw new Error("Bootstrap already used"); s.bootstrap.usedAt = Date.now(); s.config = { policy: "authenticated", methods: [...new Set([...(s.config?.methods || kernel.methods), "passkey" as const])] }; s.credentials.push({ id: c.id, publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports, name: input.name?.slice(0, 80) || "Passkey", createdAt: Date.now() }); });
    await kernel.establishSession(res, { id: "owner", displayName: "Owner" }, "passkey", req, true, { passkeyId: c.id }); json(res, 200, { ok: true }); return true;
  }
  return false;
}
