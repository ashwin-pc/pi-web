import type { Role } from "../app/types.js";
import { normalizeRemoteContentHost, normalizeRemoteContentHosts } from "../../server/shared/remoteContentHosts.js";

export type ContentResource = {
  kind: "image" | "preview-request" | "preview-navigation";
  url: string;
  from: { sessionId: string; role: Role };
};

export type ContentPolicyVerdict = {
  action: "allow" | "warn" | "ask" | "block";
  reason?: string;
  by: string;
};

export type ContentPolicy = (
  resource: ContentResource,
) => ContentPolicyVerdict | undefined | Promise<ContentPolicyVerdict | undefined>;

const registeredPolicies: ContentPolicy[] = [];
const blockedHosts = new Set<string>();
const configuredAllowedHosts = new Set<string>();
let allowedHosts = new Set<string>();
let apiHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });
const strictness = { allow: 0, warn: 1, ask: 2, block: 3 } as const;
const policyTimeoutMs = 1_500;

function parsedUrl(value: string): URL | undefined {
  try { return new URL(value, window.location.origin); } catch { return; }
}

function corePolicy(resource: ContentResource): ContentPolicyVerdict | undefined {
  const url = parsedUrl(resource.url);
  if (!url) return { action: "block", reason: "Invalid URL", by: "core" };
  if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === window.location.origin) return { action: "allow", by: "core" };
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { action: "block", reason: "Unsupported URL", by: "core" };
}

function userHostPolicy(resource: ContentResource): ContentPolicyVerdict | undefined {
  const url = parsedUrl(resource.url);
  if (!url || !["http:", "https:"].includes(url.protocol)) return;
  const host = url.host.toLowerCase();
  if (blockedHosts.has(host)) return { action: "block", reason: "Host blocked for this app session", by: "user-session-blocklist" };
  if (allowedHosts.has(url.host.toLowerCase())) return { action: "allow", by: "user-host-allowlist" };
}

async function policyResult(policy: ContentPolicy, resource: ContentResource): Promise<ContentPolicyVerdict | undefined> {
  const name = policy.name || "anonymous";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => policy(resource)),
      new Promise<ContentPolicyVerdict>((resolve) => {
        timer = setTimeout(() => resolve({
          action: "ask",
          reason: `Internal content policy ${name} timed out`,
          by: "internal-policy-timeout",
        }), policyTimeoutMs);
      }),
    ]);
  } catch {
    return {
      action: "ask",
      reason: `Internal content policy ${name} failed`,
      by: "internal-policy-error",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function decideContent(resource: ContentResource): Promise<ContentPolicyVerdict> {
  let verdict: ContentPolicyVerdict | undefined;
  for (const policy of [corePolicy, userHostPolicy, ...registeredPolicies]) {
    const result = await policyResult(policy, resource);
    if (result && (!verdict || strictness[result.action] > strictness[verdict.action])) verdict = result;
  }
  return verdict || { action: "ask", by: "default" };
}

/** Internal composition point; deliberately not wired into extension contributions. */
export function registerContentPolicy(policy: ContentPolicy) {
  registeredPolicies.push(policy);
  return () => {
    const index = registeredPolicies.indexOf(policy);
    if (index >= 0) registeredPolicies.splice(index, 1);
  };
}

export function configureContentPolicy(options: { headers: () => HeadersInit }) {
  apiHeaders = options.headers;
}

export function applyContentPolicySettings(settings: { security?: { remoteContentHosts?: string[] } }) {
  configuredAllowedHosts.clear();
  for (const host of normalizeRemoteContentHosts(settings.security?.remoteContentHosts)) configuredAllowedHosts.add(host);
  allowedHosts = new Set([...configuredAllowedHosts].filter((host) => !blockedHosts.has(host)));
  document.dispatchEvent(new Event("pi-web-content-policy-changed"));
}

export async function alwaysAllowHost(host: string) {
  const normalized = normalizeRemoteContentHost(host);
  if (!normalized) throw new Error("Enter a valid host, optionally with a port");
  const next = [...new Set([...configuredAllowedHosts, normalized])].sort();
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

export function blockContentHost(host: string) {
  const normalized = normalizeRemoteContentHost(host);
  if (!normalized) return false;
  blockedHosts.add(normalized);
  allowedHosts.delete(normalized);
  document.dispatchEvent(new Event("pi-web-content-policy-changed"));
  return true;
}

export function contentPolicyAllowedHosts() {
  return [...allowedHosts];
}
