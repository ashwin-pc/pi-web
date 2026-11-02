import type { Role } from "../app/types.js";

export type ContentResource = {
  kind: "image" | "preview-request" | "preview-navigation" | "link";
  url: string;
  from: { sessionId: string; role: Role };
};

export type ContentPolicyVerdict = {
  action: "allow" | "warn" | "ask" | "block";
  reason?: string;
  by: string;
};

type ContentPolicy = (resource: ContentResource) => ContentPolicyVerdict | undefined | Promise<ContentPolicyVerdict | undefined>;

const policies: ContentPolicy[] = [];
const verdictCache = new Map<string, ContentPolicyVerdict>();
let allowedHosts = new Set<string>();
let apiHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });
const strictness = { allow: 0, warn: 1, ask: 2, block: 3 } as const;

function parsedUrl(value: string): URL | undefined {
  try { return new URL(value, window.location.origin); } catch { return; }
}

function isValidContentHostname(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return hostname.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-"));
}

export function normalizedContentHost(value: string): string | undefined {
  const text = value.trim().toLowerCase().replace(/\.$/, "");
  if (!text || text.length > 253 || /[/?#@\\\s]/.test(text)) return;
  try {
    const url = new URL(`https://${text}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname.length > 253 || !isValidContentHostname(hostname)) return;
    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch { return; }
}

function cacheKey(resource: ContentResource) {
  const url = parsedUrl(resource.url);
  return `${resource.kind}\0${url?.host.toLowerCase() || resource.url}\0${resource.from.role}\0${resource.from.sessionId}`;
}

function intrinsicVerdict(resource: ContentResource): ContentPolicyVerdict | undefined {
  const url = parsedUrl(resource.url);
  if (!url) return { action: "block", reason: "Invalid URL", by: "core" };
  if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === window.location.origin) return { action: "allow", by: "core" };
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { action: "block", reason: "Unsupported URL", by: "core" };
  if (allowedHosts.has(url.host.toLowerCase())) return { action: "allow", by: "user-host-allowlist" };
  return;
}

async function policyResult(policy: ContentPolicy, resource: ContentResource): Promise<ContentPolicyVerdict | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      Promise.resolve(policy(resource)),
      new Promise<ContentPolicyVerdict>((resolve) => {
        timer = window.setTimeout(() => resolve({ action: "ask", reason: "Policy timed out", by: "policy-timeout" }), 1_500);
      }),
    ]);
  } catch {
    return { action: "ask", reason: "Policy failed", by: "policy-error" };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export async function decideContent(resource: ContentResource): Promise<ContentPolicyVerdict> {
  const intrinsic = intrinsicVerdict(resource);
  if (intrinsic) return intrinsic;
  const key = cacheKey(resource);
  const cached = verdictCache.get(key);
  if (cached) return cached;
  let verdict: ContentPolicyVerdict | undefined;
  for (const policy of policies) {
    const result = await policyResult(policy, resource);
    if (result && (!verdict || strictness[result.action] > strictness[verdict.action])) verdict = result;
  }
  verdict ||= { action: "ask", by: "default" };
  verdictCache.set(key, verdict);
  return verdict;
}

/** Internal-only composition point. Deliberately absent from the extension API. */
export function registerContentPolicy(policy: ContentPolicy) {
  policies.push(policy);
  verdictCache.clear();
  return () => {
    const index = policies.indexOf(policy);
    if (index >= 0) policies.splice(index, 1);
    verdictCache.clear();
  };
}

export function configureContentPolicy(options: { headers: () => HeadersInit }) {
  apiHeaders = options.headers;
}

export function applyContentPolicySettings(settings: { security?: { remoteContentHosts?: string[] } }) {
  allowedHosts = new Set((settings.security?.remoteContentHosts || []).flatMap((host) => {
    const normalized = normalizedContentHost(host);
    return normalized ? [normalized] : [];
  }));
  verdictCache.clear();
  document.dispatchEvent(new Event("pi-web-content-policy-changed"));
}

export async function alwaysAllowHost(host: string) {
  const normalized = normalizedContentHost(host);
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
