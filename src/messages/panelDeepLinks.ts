export type PanelDeepLink = {
  key: string;
  payload: Record<string, string>;
};

const controlCharacters = /[\u0000-\u001F\u007F-\u009F]/;

export function parsePanelDeepLink(href: string): PanelDeepLink | undefined {
  if (!href.startsWith("#panel:")) return;
  const target = href.slice("#panel:".length);
  const separator = target.indexOf(":");
  const key = (separator < 0 ? target : target.slice(0, separator)).trim();
  const query = separator < 0 ? "" : target.slice(separator + 1);
  if (!key || key.length > 80 || controlCharacters.test(key) || query.length > 8_192) return;
  const params = new URLSearchParams(query);
  if (Array.from(params).length > 64) return;
  return { key, payload: Object.fromEntries(params) };
}

export function confirmPanelDeepLink(target: PanelDeepLink) {
  const payload = Object.keys(target.payload).length
    ? JSON.stringify(target.payload, null, 2)
    : "(none)";
  return window.confirm(
    `Open extension panel from this message?\n\nTarget: ${target.key}\nPayload:\n${payload}`,
  );
}
