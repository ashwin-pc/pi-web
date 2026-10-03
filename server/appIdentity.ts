import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { PiWebSettings } from "./settings.js";
import { resolveAvatarBundle } from "./shared/appIdentity.js";

export const maxAvatarBytes = 2 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function avatarFile(settingsFile: string): string { return join(dirname(settingsFile), "pi-web-avatar.png"); }

function validPng(png: Buffer): boolean {
  if (!png.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let sawHeader = false;
  let ended = false;
  const imageData: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return false;
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    // PNG chunk CRC covers the four-byte type and the chunk data.
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) {
      crc ^= png[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== png.readUInt32BE(offset + 8 + length)) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return false;
      sawHeader = true;
    } else if (type === "IDAT") imageData.push(body);
    else if (type === "IEND") { ended = length === 0; offset += 12; break; }
    offset += 12 + length;
  }
  if (!sawHeader || !ended || offset !== png.length || !imageData.length) return false;
  try {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const channels = png[25] === 6 ? 4 : 3;
    const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: 2048 * 2048 * 4 + 2048 });
    const stride = width * channels;
    if (decoded.length !== height * (stride + 1)) return false;
    for (let row = 0; row < height; row++) if (decoded[row * (stride + 1)] > 4) return false;
    return true;
  } catch { return false; }
}
export async function receiveAvatar(req: IncomingMessage, settingsFile: string): Promise<void> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "image/png") throw new Error("Expected image/png");
  if (Number(req.headers["content-length"]) > maxAvatarBytes) throw new Error("Avatar exceeds 2 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxAvatarBytes) throw new Error("Avatar exceeds 2 MB");
    chunks.push(chunk);
  }
  const png = Buffer.concat(chunks);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error("Avatar dimensions must be between 1 and 2048 pixels");
  if (!validPng(png)) throw new Error("Invalid PNG");
  const file = avatarFile(settingsFile);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, png); await rename(tmp, file); }
  catch (error) { await unlink(tmp).catch(() => undefined); throw error; }
}
export async function readAvatar(settingsFile: string): Promise<Buffer | undefined> {
  try { return await readFile(avatarFile(settingsFile)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function publicIdentityAssets(settings: PiWebSettings, uploadedPng?: Buffer) {
  const identity = settings.identity.avatar.type === "custom" && !uploadedPng
    ? { ...settings.identity, avatar: { type: "preset" as const, id: "current-pi" as const } }
    : settings.identity;
  return resolveAvatarBundle(identity);
}

export function identityManifest(settings: PiWebSettings) {
  const { name, shortName } = settings.identity;
  const icon = `/identity/icon.png?v=${settings.identity.revision}`;
  return {
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    name,
    short_name: shortName,
    description: "pi coding agent web UI",
    theme_color: "#1a1a1a",
    background_color: "#1a1a1a",
    // Bundled and normalized custom icons are 512×512. None has a verified
    // maskable safe zone, so don't advertise a smaller size or maskability.
    icons: [{ src: icon, sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
