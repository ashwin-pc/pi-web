export const savedTranscriptRecordLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxEmbeddedImageBytes: 256 * 1024,
} as const;

const omissionPrefix = "[omitted saved transcript ";

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function imageMediaType(value: Record<string, unknown>) {
  for (const candidate of [value.mimeType, value.mediaType, value.mime_type]) {
    if (typeof candidate === "string" && candidate.toLowerCase().startsWith("image/")) return candidate;
  }
  return undefined;
}

function omission(label: string, value: string) {
  return `${omissionPrefix}${label}: ${byteLength(value)} bytes]`;
}

function replaceLargeString(owner: Record<string, unknown>, key: string, label: string) {
  const value = owner[key];
  if (typeof value !== "string" || byteLength(value) <= savedTranscriptRecordLimits.maxEmbeddedImageBytes) return;
  owner[key] = omission(label, value);
}

/**
 * Records are parsed only after the bounded reader has retained the complete
 * line. Mutating the parsed copy preserves message structure while shedding
 * known inline image encodings before projection.
 */
export function sanitizeSavedTranscriptRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  const pending: object[] = [record as object];
  while (pending.length) {
    const current = pending.pop()!;
    if (Array.isArray(current)) {
      for (const value of current) if (value && typeof value === "object") pending.push(value);
      continue;
    }
    const value = current as Record<string, unknown>;
    const type = typeof value.type === "string" ? value.type : "";
    const mediaType = imageMediaType(value);
    if (type === "image" || mediaType) {
      replaceLargeString(value, "data", `${mediaType || "image"} base64 image data`);
    }
    if (type === "image_url" && value.image_url && typeof value.image_url === "object" && !Array.isArray(value.image_url)) {
      const imageUrl = value.image_url as Record<string, unknown>;
      const url = imageUrl.url;
      if (typeof url === "string" && /^data:image\/[^;,]+;base64,/i.test(url)) {
        replaceLargeString(imageUrl, "url", "inline image data URL");
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child as object);
  }
  return record;
}

export function savedTranscriptOmission(value: unknown): string | undefined {
  if (typeof value === "string" && value.startsWith(omissionPrefix) && value.endsWith("]")) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return savedTranscriptOmission(record.data)
    || savedTranscriptOmission(record.url)
    || savedTranscriptOmission(record.source)
    || savedTranscriptOmission(record.image_url);
}
