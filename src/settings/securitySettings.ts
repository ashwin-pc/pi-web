import type { ApiClient } from "../app/api.js";
import { createQrSvg } from "../token/qr.js";

export type AuthMode = "none" | "legacy" | "passkey" | "external";
type Identity = { id: string; displayName?: string };
type SecurityState = {
  mode: AuthMode; identity: Identity;
  passkeys: Array<{ id: string; name: string; createdAt: number }>;
  sessions: Array<{ id: string; identity: Identity; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }>;
  apiTokens: Array<{ id: string; name: string; createdAt: number; expiresAt: number }>;
  deviceGrants: Array<{ id: string; createdAt: number; expiresAt: number; createdBy: Identity }>;
};

type Options = { container: HTMLElement; api: ApiClient; setStatus: (message: string, error?: boolean) => void };
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createSecuritySettings({ container, api, setStatus }: Options) {
  let current: SecurityState | undefined;
  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(path, { ...init, credentials: "same-origin", headers: { ...api.headers(), ...(init.headers || {}) } });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
    return value as T;
  }
  function button(label: string, action: () => Promise<void>, danger = false) {
    const element = document.createElement("button"); element.type = "button"; element.textContent = label; if (danger) element.className = "danger";
    element.addEventListener("click", () => { element.disabled = true; action().catch(e => setStatus(e instanceof Error ? e.message : String(e), true)).finally(() => { element.disabled = false; }); }); return element;
  }
  function section(title: string, hint?: string) { const el = document.createElement("section"); el.className = "settingsSection securitySection"; const h = document.createElement("h4"); h.textContent = title; el.append(h); if (hint) { const p = document.createElement("p"); p.className = "settingsHint"; p.textContent = hint; el.append(p); } return el; }
  function row(title: string, detail: string, action?: HTMLElement) { const el = document.createElement("div"); el.className = "securityRow"; const copy = document.createElement("div"), strong = document.createElement("strong"), small = document.createElement("small"); strong.textContent = title; small.textContent = detail; copy.append(strong, small); el.append(copy); if (action) el.append(action); return el; }
  function date(value: number) { return new Date(value).toLocaleString(); }

  function render(state: SecurityState) {
    current = state; container.replaceChildren();
    const modeHints: Record<AuthMode, string> = { legacy: "PI_WEB_TOKEN authenticates the first browser request; devices then use revocable sessions. To cut over, configure a stable WebAuthn origin and PI_WEB_AUTH_MODE=passkey.", passkey: "Passkeys authenticate browsers. Keep at least two credentials for recovery.", external: "Your trusted reverse proxy authenticates requests.", none: "Warning: this instance has no authentication." };
    const mode = section("Authentication mode", modeHints[state.mode]); mode.dataset.mode = state.mode;
    mode.append(row(state.mode, state.identity.displayName || state.identity.id)); container.append(mode);

    if (state.mode === "passkey") {
      const keys = section("Passkeys", "Adding a passkey requires this authenticated browser session. Revoking any passkey signs out all devices.");
      for (const key of state.passkeys) keys.append(row(key.name, `Added ${date(key.createdAt)}`, button("Revoke", async () => { if (!confirm(`Revoke ${key.name} and sign out all devices?`)) return; await request(`/api/auth/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE" }); location.reload(); }, true)));
      const name = document.createElement("input"); name.placeholder = "Passkey name"; name.value = "Passkey";
      keys.append(name, button("Add passkey", async () => {
        const options = await request<any>("/api/auth/passkeys/options", { method: "POST", body: JSON.stringify({ name: name.value }) }); options.challenge = decode(options.challenge); options.user.id = decode(options.user.id); options.excludeCredentials?.forEach((item: any) => item.id = decode(item.id));
        const credential = await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential | null; if (!credential) throw new Error("Passkey creation cancelled"); const response = credential.response as AuthenticatorAttestationResponse;
        await request("/api/auth/passkeys/verify", { method: "POST", body: JSON.stringify({ response: { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject) }, clientExtensionResults: credential.getClientExtensionResults() } }) }); await refresh(); setStatus("Passkey added");
      })); container.append(keys);
    }

    if (state.mode === "legacy" || state.mode === "passkey") {
      const devices = section("Devices & sessions", "Revoke a browser without affecting other devices.");
      for (const session of state.sessions) devices.append(row(session.identity.displayName || session.identity.id, `${session.current ? "This device · " : ""}Last seen ${date(session.lastSeenAt)}`, button("Revoke", async () => { await request(`/api/auth/sessions/${session.id}`, { method: "DELETE" }); if (session.current) location.reload(); else await refresh(); }, true)));
      if (!state.sessions.length) devices.append(row("No active devices", "Sign in from a browser to create a session.")); container.append(devices);
    }

    const tokens = section("API tokens", "Tokens are for automation. The secret is displayed once and cannot be recovered.");
    for (const token of state.apiTokens) tokens.append(row(token.name, `Expires ${date(token.expiresAt)}`, button("Revoke", async () => { await request(`/api/auth/tokens/${token.id}`, { method: "DELETE" }); await refresh(); }, true)));
    const tokenName = document.createElement("input"); tokenName.placeholder = "Token name"; const days = document.createElement("input"); days.type = "number"; days.min = "1"; days.max = "365"; days.value = "30"; days.setAttribute("aria-label", "Token lifetime in days");
    const secret = document.createElement("div"); secret.className = "securitySecret"; secret.hidden = true;
    tokens.append(tokenName, days, button("Create API token", async () => { const value = await request<{ secret: string }>("/api/auth/tokens", { method: "POST", body: JSON.stringify({ name: tokenName.value, days: Number(days.value) }) }); secret.replaceChildren(); const warning = document.createElement("strong"); warning.textContent = "Copy this secret now — it is shown once:"; const code = document.createElement("code"); code.textContent = value.secret; secret.append(warning, code, button("Copy secret", async () => { await navigator.clipboard.writeText(value.secret); setStatus("API token copied"); })); secret.hidden = false; await refresh(false); }, false), secret); container.append(tokens);

    if (state.mode === "legacy" || state.mode === "passkey") {
      const grants = section("Add device", "Create a cancellable, single-use link valid for two minutes. It never shares the permanent server token.");
      const output = document.createElement("div"); output.className = "deviceGrantOutput";
      grants.append(button("Create add-device link", async () => { const grant = await request<{ id: string; url: string; expiresAt: number }>("/api/auth/device-grants", { method: "POST", body: "{}" }); output.replaceChildren(); const status = document.createElement("p"); status.textContent = `Pending until ${date(grant.expiresAt)}`; const link = document.createElement("input"); link.readOnly = true; link.value = grant.url; link.setAttribute("aria-label", "Add-device link"); const qr = document.createElement("div"); qr.className = "deviceGrantQr"; qr.append(createQrSvg(grant.url, "Add device QR code")); output.append(status, qr, link, button("Copy link", async () => navigator.clipboard.writeText(grant.url)), button("Cancel grant", async () => { await request(`/api/auth/device-grants/${grant.id}`, { method: "DELETE" }); await refresh(); setStatus("Add-device grant cancelled"); }, true)); await refresh(false); }), output);
      for (const grant of state.deviceGrants) grants.append(row("Pending grant", `Created by ${grant.createdBy.displayName || grant.createdBy.id} · expires ${date(grant.expiresAt)}`, button("Cancel", async () => { await request(`/api/auth/device-grants/${grant.id}`, { method: "DELETE" }); await refresh(); }, true)));
      container.append(grants);
    }
  }
  async function refresh(renderResult = true) { const state = await request<SecurityState>("/api/auth/security"); if (renderResult) render(state); else current = state; }
  return { refresh, render: () => current && render(current) };
}
