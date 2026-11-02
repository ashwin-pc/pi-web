import type { Role } from "../app/types.js";
import { normalizeRemoteContentHost, normalizeRemoteContentHosts } from "../../server/shared/remoteContentHosts.js";

export type ContentResource = {
  kind: "image" | "preview-request" | "preview-navigation";
  url: string;
  from: { sessionId: string; role: Role };
};

export type ContentPolicyVerdict = {
  action: "allow" | "ask" | "block";
  reason?: string;
  by: string;
};

let allowedHosts = new Set<string>();
let apiHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });

function parsedUrl(value: string): URL | undefined {
  try { return new URL(value, window.location.origin); } catch { return; }
}

export async function decideContent(resource: ContentResource): Promise<ContentPolicyVerdict> {
  const url = parsedUrl(resource.url);
  if (!url) return { action: "block", reason: "Invalid URL", by: "core" };
  if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === window.location.origin) return { action: "allow", by: "core" };
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { action: "block", reason: "Unsupported URL", by: "core" };
  if (allowedHosts.has(url.host.toLowerCase())) return { action: "allow", by: "user-host-allowlist" };
  return { action: "ask", by: "default" };
}

export function configureContentPolicy(options: { headers: () => HeadersInit }) {
  apiHeaders = options.headers;
}

export function applyContentPolicySettings(settings: { security?: { remoteContentHosts?: string[] } }) {
  allowedHosts = new Set(normalizeRemoteContentHosts(settings.security?.remoteContentHosts));
  document.dispatchEvent(new Event("pi-web-content-policy-changed"));
}

export async function alwaysAllowHost(host: string) {
  const normalized = normalizeRemoteContentHost(host);
  if (!normalized) throw new Error("Enter a valid host, optionally with a port");
  const next = [...new Set([...allowedHosts, normalized])].sort();
  const response = await fetch("/api/settings", {
    method: "PATCH",
    headers: apiHeaders(),
    body: JSON.stringify({ security: { remoteContentHosts: next } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Unable to save host (${response.status})`);
  applyContentPolicySettings(data.settings || { security: { remoteContentHosts: next } });
  return data.settings;
}

export function contentPolicyAllowedHosts() {
  return [...allowedHosts];
}
