import type { PiWebPanelEvent } from "../extensions.js";

export type PanelDeepLink = {
  key: string;
  payload: Record<string, string>;
};

type PanelDescriptor = {
  key: string;
  title: string;
  deepLinks?: { allowedKeys: string[]; requiredKeys?: string[]; hasDescribe?: boolean };
};

const controlCharacters = /[\u0000-\u001F\u007F-\u009F]/;
let panels = new Map<string, PanelDescriptor>();
let registryReady = false;
let apiHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });
let sessionId = () => "";

export function parsePanelDeepLink(href: string): PanelDeepLink | undefined {
  if (!href.startsWith("#panel:")) return;
  const target = href.slice("#panel:".length);
  const separator = target.indexOf(":");
  const key = (separator < 0 ? target : target.slice(0, separator)).trim();
  const query = separator < 0 ? "" : target.slice(separator + 1);
  if (!key || key.length > 80 || controlCharacters.test(key) || query.length > 8_192) return;
  const params = new URLSearchParams(query);
  if (Array.from(params).length > 64) return;
  const payload: Record<string, string> = {};
  for (const [name, value] of params) {
    if (name.length > 64 || value.length > 2_000 || controlCharacters.test(name) || controlCharacters.test(value)) return;
    payload[name] = value;
  }
  return { key, payload };
}

export function configurePanelDeepLinks(options: {
  headers: () => HeadersInit;
  getSessionId: () => string;
}) {
  apiHeaders = options.headers;
  sessionId = options.getSessionId;
}

export function setPanelDeepLinkDescriptors(value: PanelDescriptor[]) {
  panels = new Map(value.map((panel) => [panel.key, panel]));
  registryReady = true;
  if (typeof document !== "undefined") queueMicrotask(() => enhancePanelDeepLinks(document));
}

export function validatedPanelDeepLink(link: PanelDeepLink) {
  const panel = panels.get(link.key);
  if (!panel) return;
  if (!panel.deepLinks) return { panel, payload: link.payload };
  const allowed = new Set(panel.deepLinks.allowedKeys);
  const payload = Object.fromEntries(Object.entries(link.payload).filter(([key]) => allowed.has(key)));
  if ((panel.deepLinks.requiredKeys || []).some((key) => !payload[key])) return;
  return { panel, payload };
}

async function describe(panel: PanelDescriptor, payload: Record<string, string>) {
  if (!panel.deepLinks?.hasDescribe) return;
  const response = await fetch("/api/web-contributions/invoke", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      sessionId: sessionId(),
      slot: "panel",
      key: panel.key,
      event: { action: "__pi_web_describe_deep_link", payload },
    }),
  });
  const data = await response.json().catch(() => ({}));
  return response.ok && data.ok !== false && typeof data.description === "string" ? data.description : undefined;
}

export function enhancePanelDeepLinks(root: ParentNode) {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href^="#panel:"]')) {
    const parsed = parsePanelDeepLink(anchor.getAttribute("href") || "");
    if (parsed && !panels.has(parsed.key) && !registryReady) continue;
    const valid = parsed && validatedPanelDeepLink(parsed);
    if (!valid) {
      const text = document.createElement("span");
      text.className = "panelDeepLinkInvalid";
      text.textContent = anchor.textContent || "";
      anchor.replaceWith(text);
      continue;
    }
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.dataset.panelDeepLink = valid.panel.key;
    anchor.dataset.panelPayload = JSON.stringify(valid.payload);
    anchor.title = `${valid.panel.title} › ${Object.values(valid.payload).join(" › ") || "open"}`;
    if (valid.panel.deepLinks?.hasDescribe) {
      void describe(valid.panel, valid.payload).then((label) => {
        if (!label || !anchor.isConnected) return;
        anchor.classList.add("panelDeepLinkChip");
        anchor.textContent = label;
        anchor.title = `${valid.panel.title} › ${label}`;
      });
    }
  }
}

export function panelDeepLinkEvent(anchor: HTMLAnchorElement): { key: string; event: PiWebPanelEvent } | undefined {
  const key = anchor.dataset.panelDeepLink;
  if (!key) return;
  try {
    const payload = JSON.parse(anchor.dataset.panelPayload || "{}") as Record<string, string>;
    return { key, event: { action: "deep-link", payload, source: "message" } };
  } catch { return; }
}
