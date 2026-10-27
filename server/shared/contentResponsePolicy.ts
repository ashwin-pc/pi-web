import { extname } from "node:path";

export type ContentResponseHeaders = Record<string, string>;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
};

const inlineAttachmentTypes = new Set([
  "application/json",
  "application/pdf",
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

const nosniff = { "x-content-type-options": "nosniff" } as const;
const inertDocumentHeaders = {
  ...nosniff,
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

export function contentTypeForPath(path: string) {
  return contentTypes[extname(path).toLowerCase()] || "application/octet-stream";
}

export function artifactResponsePolicy(path: string): ContentResponseHeaders {
  return {
    "content-type": contentTypeForPath(path),
    ...nosniff,
    // Artifact scripts remain useful, but the omitted allow-same-origin token
    // gives direct navigations an opaque origin without blocking their assets.
    "content-security-policy": "sandbox allow-scripts",
  };
}

export function workspaceImageResponsePolicy(mimeType: string): ContentResponseHeaders {
  return { "content-type": mimeType, ...inertDocumentHeaders };
}

function dispositionFilename(name: string, disposition: "inline" | "attachment") {
  const fallback = name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\r\n]/g, "_") || "attachment";
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function attachmentResponsePolicy(name: string): ContentResponseHeaders {
  const mappedType = contentTypeForPath(name);
  const baseType = mappedType.split(";", 1)[0].trim().toLowerCase();
  const inline = inlineAttachmentTypes.has(baseType);
  return {
    "content-type": inline ? mappedType : "application/octet-stream",
    "content-disposition": dispositionFilename(name, inline ? "inline" : "attachment"),
    ...inertDocumentHeaders,
  };
}
