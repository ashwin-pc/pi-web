import { createHash } from "node:crypto";
import type { JsonValue, MessageDto } from "./dto.js";
import { isVisibleTranscriptMessage } from "./projection.js";

interface EmbeddedImage {
  type: "image";
  data: string;
  mimeType: string;
  [key: string]: JsonValue;
}

function embeddedImage(value: unknown): value is EmbeddedImage {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<EmbeddedImage>;
  return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

// Content-addressed references reject stale URLs after branch navigation or edits.
// They are not capabilities: the HTTP endpoint still requires ordinary API auth
// and resolves the requested session before looking up its image.
function imageDigest(image: EmbeddedImage): string {
  return createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
}

/** Copy only modified messages/blocks; never mutate runtime or live event content. */
export function referenceTranscriptImages<T extends MessageDto>(messages: T[], sessionId: string): T[] {
  return messages.map((message, messageIndex) => {
    const raw = message.raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.content)) return message;
    let changed = false;
    const content = raw.content.map((block, contentIndex) => {
      if (!embeddedImage(block)) return block;
      changed = true;
      const { data: _data, ...metadata } = block;
      const imageId = `${messageIndex}.${contentIndex}.${imageDigest(block)}`;
      const query = new URLSearchParams({ sessionId, imageId });
      return { ...metadata, imageUrl: `/api/messages/image?${query}` };
    });
    return changed ? { ...message, raw: { ...raw, content } } as T : message;
  });
}

const imageReferencePattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.([a-f0-9]{64})$/;

export function resolveTranscriptImage(messages: MessageDto[], imageId: string): { data: Buffer; mimeType: string } | undefined {
  const match = imageReferencePattern.exec(imageId);
  if (!match) return undefined;
  const message = messages[Number(match[1])];
  const raw = message?.raw;
  const image = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.content) ? raw.content[Number(match[2])] : undefined;
  return decodeReferencedImage(image, match[3]);
}

/** Resolve only the selected live block, without DTO projection or JSON copies.
 * Visible indices match simplifyMessage, including hidden custom-message gaps.
 */
export function resolveRawTranscriptImage(messages: readonly unknown[], imageId: string): { data: Buffer; mimeType: string } | undefined {
  const match = imageReferencePattern.exec(imageId);
  if (!match) return undefined;
  const requestedIndex = Number(match[1]);
  let visibleIndex = 0;
  for (const message of messages) {
    if (!isVisibleTranscriptMessage(message)) continue;
    if (visibleIndex++ !== requestedIndex) continue;
    const image = Array.isArray(message.content) ? message.content[Number(match[2])] : undefined;
    return decodeReferencedImage(image, match[3]);
  }
  return undefined;
}

function decodeReferencedImage(image: unknown, digest: string): { data: Buffer; mimeType: string } | undefined {
  if (!embeddedImage(image) || imageDigest(image) !== digest) return undefined;
  // Do not serve HTML/SVG or arbitrary MIME types supplied by a tool as active
  // same-origin content. Typical provider-supported images are raster formats.
  if (!/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(image.mimeType)) return undefined;
  return { data: Buffer.from(image.data, "base64"), mimeType: image.mimeType.toLowerCase() };
}
