export type ArtifactPreviewKind = "image" | "markdown" | "html" | "video" | "audio" | "pdf" | "file";

type ArtifactPreviewDescriptor = {
  key?: unknown;
  title?: unknown;
  label?: unknown;
  match?: { kinds?: unknown; extensions?: unknown };
  kinds?: unknown;
  extensions?: unknown;
};

export type ArtifactContext = { name: string; path: string; kind: ArtifactPreviewKind };

export type ArtifactPreviewMountOptions = {
  title: string;
  className?: string;
  isCurrent?: () => boolean;
};

let descriptors: ArtifactPreviewDescriptor[] = [];
let requestHeaders: () => Record<string, string> = () => ({ "content-type": "application/json" });
let sessionId = () => "";

export function configureArtifactPreviews(options: { headers: () => Record<string, string>; getSessionId: () => string }) {
  requestHeaders = options.headers;
  sessionId = options.getSessionId;
}

export function setArtifactPreviews(value: unknown) {
  descriptors = Array.isArray(value) ? value : [];
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function matchingArtifactPreview(name: string, kind: ArtifactPreviewKind) {
  const lowerName = name.toLowerCase();
  return descriptors.find((raw) => {
    if (typeof raw?.key !== "string" || !raw.key) return false;
    const kinds = stringList(raw.match?.kinds ?? raw.kinds);
    if (kinds.length && !kinds.includes(kind)) return false;
    const extensions = stringList(raw.match?.extensions ?? raw.extensions);
    return !extensions.length || extensions.some((extension) => lowerName.endsWith(extension.toLowerCase()));
  });
}

export async function renderArtifactPreview(descriptor: ArtifactPreviewDescriptor, artifact: ArtifactContext) {
  if (typeof descriptor.key !== "string" || !descriptor.key) throw new Error("Invalid artifact preview contribution");
  const response = await fetch("/api/web-contributions/invoke", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      sessionId: sessionId(),
      slot: "artifact-preview",
      key: descriptor.key,
      event: { context: artifact },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || typeof data.html !== "string") {
    throw new Error(data.error || response.statusText || "Artifact preview failed");
  }
  return { html: data.html as string, label: typeof data.label === "string" ? data.label : undefined };
}

export async function mountArtifactPreview(
  host: HTMLElement,
  artifact: ArtifactContext,
  options: ArtifactPreviewMountOptions,
) {
  const descriptor = matchingArtifactPreview(artifact.name, artifact.kind);
  if (!descriptor) return false;
  const { html } = await renderArtifactPreview(descriptor, artifact);
  if (options.isCurrent && !options.isCurrent()) return true;
  const frame = document.createElement("iframe");
  if (options.className) frame.className = options.className;
  // Inject a strict CSP meta so the extension-authored HTML cannot beacon or
  // open outbound connections from inside the opaque-origin sandbox, even
  // though it already runs with no same-origin / top-navigation / popup
  // ambient authority.
  frame.srcdoc = injectArtifactPreviewCsp(html);
  frame.title = options.title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  host.replaceChildren(frame);
  return true;
}

// Same policy as the agent-authored html-preview fence: keep inline script
// and style working (which the preview feature intentionally supports) but
// prevent any outbound network traffic from the embedded document.
const ARTIFACT_PREVIEW_CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; base-uri 'none';\">";

function injectArtifactPreviewCsp(html: string) {
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + ARTIFACT_PREVIEW_CSP_META + html.slice(insertAt);
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(html);
  if (htmlMatch) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, insertAt) + "<head>" + ARTIFACT_PREVIEW_CSP_META + "</head>" + html.slice(insertAt);
  }
  return `<!doctype html><html><head>${ARTIFACT_PREVIEW_CSP_META}</head><body>${html}</body></html>`;
}
