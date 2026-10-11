// Loads an artifact's content for drawing in the VR scene. Everything is
// fetched through the client (same-origin, with the API's auth), so it works
// in token mode as well as with cookies. HTML is never loaded: WebGL cannot
// draw a live page, so views show a card with "Open in 2D" instead.
import type { ClientArtifact, PiWebClient } from "../../client/types.js";

export type ArtifactContent =
  | { kind: "image"; image: ImageBitmap; width: number; height: number }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "video"; video: HTMLVideoElement; release(): void }
  | { kind: "model"; bytes: ArrayBuffer; format: "stl" | "gltf" | "glb" | "obj" | "ply" }
  | { kind: "unavailable"; reason: string };

const MAX_TEXT = 200_000;
const MAX_MODEL = 25 * 1024 * 1024;

export async function loadArtifactContent(client: PiWebClient, artifact: ClientArtifact, signal?: AbortSignal): Promise<ArtifactContent> {
  if (artifact.kind === "html") return { kind: "unavailable", reason: "HTML can't be drawn in VR. Open it in 2D." };
  if (artifact.kind === "audio" || artifact.kind === "other") return { kind: "unavailable", reason: "No preview for this kind. Open it in 2D." };
  const response = await client.files.fetch(artifact.url, { signal });
  if (!response.ok) return { kind: "unavailable", reason: `Could not load it (${response.status}).` };
  switch (artifact.kind) {
    case "image": {
      const image = await createImageBitmap(await response.blob());
      return { kind: "image", image, width: image.width, height: image.height };
    }
    case "markdown":
    case "diff":
    case "diagram": {
      const text = await response.text();
      return { kind: "text", text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
    }
    case "video": {
      const url = URL.createObjectURL(await response.blob());
      const video = document.createElement("video");
      Object.assign(video, { src: url, muted: true, loop: true, playsInline: true, crossOrigin: "anonymous" });
      await video.play().catch(() => undefined);
      return { kind: "video", video, release() { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); } };
    }
    case "model": {
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_MODEL) return { kind: "unavailable", reason: "The model is too large to show in VR." };
      const format = (artifact.path.split(".").pop() || "").toLowerCase() as "stl" | "gltf" | "glb" | "obj" | "ply";
      return { kind: "model", bytes: await response.arrayBuffer(), format };
    }
  }
  return { kind: "unavailable", reason: "No preview for this kind." };
}
