import { mountArtifactStream, selectedArtifactUrl } from "./artifactStream.js";

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
  layout?: "inline" | "panel";
  className?: string;
  isCurrent?: () => boolean;
  onFrameReady?: (frame: HTMLIFrameElement, surface: HTMLElement) => void;
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
  return { html: data.html as string, artifactBytes: data.artifactBytes === true,
    derivation: data.artifactDerived === true && typeof data.selection === "string" ? { selection: data.selection as string, key: descriptor.key, sessionId: sessionId() } : undefined, label: typeof data.label === "string" ? data.label : undefined };
}

export async function mountArtifactPreview(
  host: HTMLElement,
  artifact: ArtifactContext,
  options: ArtifactPreviewMountOptions,
) {
  const descriptor = matchingArtifactPreview(artifact.name, artifact.kind);
  if (!descriptor) return false;
  const invokingSession = sessionId();
  const { html, artifactBytes, derivation } = await renderArtifactPreview(descriptor, artifact);
  if (sessionId() !== invokingSession || (options.isCurrent && !options.isCurrent())) return true;
  const frame = document.createElement("iframe");
  if (options.className) frame.className = options.className;
  frame.srcdoc = html;
  frame.title = options.title;
  frame.setAttribute("sandbox", "allow-scripts");
  if (artifactBytes) {
    mountArtifactStream(host, frame, selectedArtifactUrl(artifact.path, invokingSession), requestHeaders,
      () => sessionId() === invokingSession && (!options.isCurrent || options.isCurrent()), options.onFrameReady, options.layout, derivation, () => {
        void mountArtifactPreview(host, artifact, options).catch(() => {
          if (sessionId() === invokingSession && (!options.isCurrent || options.isCurrent())) {
            host.replaceChildren();
            const error = document.createElement("p");
            error.textContent = "Preview could not be reopened. Close and reopen the artifact to try again.";
            host.append(error);
          }
        });
      });
  } else {
    host.replaceChildren(frame);
    options.onFrameReady?.(frame, host);
  }
  return true;
}
