import { sanitizeExtensionHtml } from "./sanitizeExtensionHtml.js";

type PiWebFooterEntry = {
  key?: unknown;
  footer?: unknown;
};

type NormalizedFooter =
  | { kind: "text"; lines: string[] }
  | { kind: "html"; html: string };

function normalizeFooter(value: unknown): NormalizedFooter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const footer = value as Record<string, unknown>;
  if (footer.kind === "text") {
    const lines = Array.isArray(footer.lines) ? footer.lines.map(String).filter(Boolean) : [];
    return lines.length ? { kind: "text", lines } : undefined;
  }
  if (footer.kind === "html" && typeof footer.html === "string" && footer.html) {
    return { kind: "html", html: footer.html };
  }
  return undefined;
}

export function renderWebFooters(container: HTMLElement, value: unknown) {
  const entries = Array.isArray(value) ? value as PiWebFooterEntry[] : [];
  container.textContent = "";

  for (const entry of entries) {
    const footer = normalizeFooter(entry.footer);
    if (!footer) continue;

    const region = document.createElement("div");
    region.className = `webFooterEntry ${footer.kind}`;
    if (typeof entry.key === "string" && entry.key) region.dataset.footerKey = entry.key;

    if (footer.kind === "html") region.replaceChildren(sanitizeExtensionHtml(footer.html));
    else region.textContent = footer.lines.join("\n");

    container.append(region);
  }

  container.hidden = container.childElementCount === 0;
}
