import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStore, hashSecret, randomSecret } from "./kernel.js";
import { resolveAuthConfig } from "./config.js";

const args = process.argv.slice(2);
const command = args.shift();
const store = new AuthStore(process.env.PI_WEB_AUTH_STORE || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "web", "auth.json"));
const value = (flag: string, fallback = "") => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] || fallback : fallback; };
if (command === "bootstrap" || command === "recover") {
  const token = randomSecret(), minutes = Math.max(1, Math.min(30, Number(value("--minutes", "10"))));
  await store.update(s => { s.bootstrap = { hash: hashSecret(token), expiresAt: Date.now() + minutes * 60_000 }; const initial = resolveAuthConfig(process.env); s.config = { policy: "authenticated", methods: [...new Set([...(s.config?.methods || initial.methods), "passkey" as const, "password" as const])] }; });
  const origin = process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${process.env.PORT || "8787"}`;
  const url = new URL("/api/auth/bootstrap", origin); url.searchParams.set("token", token);
  console.log(`${command === "recover" ? "Recovery" : "Enrollment"} URL (single-use, expires in ${minutes}m):\n${url}`);
} else if (command === "token-create") {
  const name = value("--name"); if (!name) throw new Error("--name is required");
  const days = Math.max(1, Math.min(365, Number(value("--days", "30")))), raw = `piw_${randomSecret()}`, id = randomUUID();
  await store.update(s => s.apiTokens.push({ id, name: name.slice(0, 80), hash: hashSecret(raw), createdAt: Date.now(), expiresAt: Date.now() + days * 86_400_000 }));
  console.log(`API token (shown once): ${raw}\nID: ${id}`);
} else if (command === "token-revoke") {
  const id = args[0]; await store.update(s => { const item = s.apiTokens.find(x => x.id === id); if (!item) throw new Error("Token not found"); item.revokedAt = Date.now(); }); console.log("Revoked.");
} else if (command === "list") {
  const s = await store.read(); console.log(JSON.stringify({ credentials: s.credentials.map(({ publicKey, ...x }) => x), sessions: s.sessions.map(({ hash, ...x }) => x), apiTokens: s.apiTokens.map(({ hash, ...x }) => x) }, null, 2));
} else if (command === "credential-revoke") {
  const id = args[0]; await store.update(s => { const item = s.credentials.find(x => x.id === id); if (!item) throw new Error("Credential not found"); item.revokedAt = Date.now(); s.sessions.forEach(x => { if (!x.revokedAt) x.revokedAt = Date.now(); }); }); console.log("Credential and all sessions revoked.");
} else if (command === "sessions-revoke-all") {
  await store.update(s => s.sessions.forEach(x => { if (!x.revokedAt) x.revokedAt = Date.now(); })); console.log("All sessions revoked.");
} else {
  console.error("Usage: pi-web auth <bootstrap|recover|list|token-create|token-revoke|credential-revoke|sessions-revoke-all> [options]"); process.exitCode = 2;
}
