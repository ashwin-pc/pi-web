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
const descriptionCache = new Map<string, {
  declaration: string;
  values: Map<string, Promise<string | undefined>>;
}>();
let apiHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });
let sessionId = () => "";

function panelDeclaration(panel: PanelDescriptor) {
  return JSON.stringify(panel);
}

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
  const nextPanels = new Map(value.map((panel) => [panel.key, panel]));
  for (const [key, cached] of descriptionCache) {
    const panel = nextPanels.get(key);
    if (!panel || panelDeclaration(panel) !== cached.declaration) descriptionCache.delete(key);
  }
  panels = nextPanels;
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
  const stablePayload = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)));
  const payloadKey = `${sessionId()}\0${JSON.stringify(stablePayload)}`;
  const declaration = panelDeclaration(panel);
  let cached = descriptionCache.get(panel.key);
  if (!cached || cached.declaration !== declaration) {
    cached = { declaration, values: new Map() };
    descriptionCache.set(panel.key, cached);
  }
  let result = cached.values.get(payloadKey);
  if (!result) {
    result = fetch("/api/web-contributions/invoke", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        sessionId: sessionId(),
        slot: "panel",
        key: panel.key,
        event: { action: "__pi_web_describe_deep_link", payload },
      }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      return response.ok && data.ok !== false && typeof data.description === "string" ? data.description : undefined;
    }).catch(() => undefined);
    cached.values.set(payloadKey, result);
  }
  return result;
}

function replaceWithInvalidText(anchor: HTMLAnchorElement) {
  const text = document.createElement("span");
  text.className = "panelDeepLinkInvalid";
  text.textContent = anchor.textContent || "";
  anchor.replaceWith(text);
}

export function enhancePanelDeepLinks(root: ParentNode) {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href^="#panel:"]')) {
    if (anchor.dataset.panelDeepLinkEnhanced) continue;
    anchor.dataset.panelDeepLinkEnhanced = "true";
    const parsed = parsePanelDeepLink(anchor.getAttribute("href") || "");
    if (!parsed) {
      replaceWithInvalidText(anchor);
      continue;
    }
    if (!panels.has(parsed.key)) {
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
      anchor.classList.add("panelDeepLinkPending");
      continue;
    }
    const valid = parsed && validatedPanelDeepLink(parsed);
    if (!valid) {
      replaceWithInvalidText(anchor);
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
  const parsed = parsePanelDeepLink(anchor.getAttribute("href") || "");
  if (!parsed || !panels.has(parsed.key)) return;
  const valid = validatedPanelDeepLink(parsed);
  if (!valid) {
    replaceWithInvalidText(anchor);
    return;
  }
  anchor.classList.remove("panelDeepLinkPending");
  return { key: valid.panel.key, event: { action: "deep-link", payload: valid.payload, source: "message" } };
}
