import { validAvatarAnimation } from "./avatarAnimation.js";
import { maxAvatarAnimationBytes } from "./shared/appIdentity.js";
import { decodeAvatarZip, encodeAvatarZip } from "./avatarZip.js";
import { createHash, randomUUID } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { PiWebSettings } from "./settings.js";
import { isAvatarAssetId, maxAvatarPackageBytes, maxAvatarZipBytes, resolveAvatarBundle } from "./shared/appIdentity.js";
export { maxAvatarPackageBytes } from "./shared/appIdentity.js";

export const maxAvatarBytes = 2 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function avatarFile(settingsFile: string): string { return join(dirname(settingsFile), "pi-web-avatar.png"); }

export function validPng(png: Buffer): boolean {
  if (!png.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let sawHeader = false;
  let ended = false;
  let sawPalette = false;
  const imageData: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return false;
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    // Use the same native, bounded CRC path as animation validation. Package
    // roundtrips validate these assets repeatedly; JS bit loops starve CI I/O.
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return false;
      sawHeader = true;
    } else if (type === "acTL" || type === "IHDR") return false;
    else if (type === "PLTE") {
      if (sawPalette || imageData.length || !length || length > 768 || length % 3) return false;
      sawPalette = true;
    }
    else if (type === "IDAT") imageData.push(body);
    else if (type === "IEND") { ended = length === 0; offset += 12; break; }
    else if (!/^[a-zA-Z]{4}$/.test(type) || type[0] === type[0].toUpperCase()) return false;
    offset += 12 + length;
  }
  if (!sawHeader || !ended || offset !== png.length || !imageData.length) return false;
  try {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 2048 || height > 2048) return false;
    const channels = png[25] === 6 ? 4 : 3;
    const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: 2048 * 2048 * 4 + 2048 });
    const stride = width * channels;
    if (decoded.length !== height * (stride + 1)) return false;
    for (let row = 0; row < height; row++) if (decoded[row * (stride + 1)] > 4) return false;
    return true;
  } catch { return false; }
}
export async function receiveAvatar(req: IncomingMessage, settingsFile: string): Promise<string> {
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
  return createAvatarGeneration(settingsFile, { still: png, icon: png });
}
export function avatarDirectory(settingsFile: string): string {
  return join(dirname(settingsFile), "pi-web-avatars", createHash("sha256").update(resolve(settingsFile)).digest("hex"));
}
export type AvatarPackage = { format: "pi-web-avatar"; version: 1; assets: { still: { mediaType: "image/png"; base64: string }; icon: { mediaType: "image/png"; base64: string }; fab?: { mediaType: "image/png"; base64: string }; newSession?: { mediaType: "image/apng"; base64: string } }; label?: string };
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid avatar package fields");
}
export function parseAvatarPackage(value: unknown): AvatarAssets {
  keys(value, ["format", "version", "assets", "label"]);
  if (value.format !== "pi-web-avatar" || value.version !== 1) throw new Error("Unsupported avatar package format or version");
  keys(value.assets, ["still", "icon", "fab", "newSession"]);
  const decode = (role: string): Buffer => {
    const asset = (value.assets as Record<string, unknown>)[role]; keys(asset, ["mediaType", "base64"]);
    if (asset.mediaType !== (role === "newSession" ? "image/apng" : "image/png") || typeof asset.base64 !== "string" || asset.base64.length > Math.ceil((role === "newSession" ? maxAvatarAnimationBytes : maxAvatarBytes) / 3) * 4) throw new Error("Invalid PNG asset");
    const png = Buffer.from(asset.base64, "base64");
    if (png.toString("base64") !== asset.base64) throw new Error("Assets must be canonical base64 PNGs");
    return png;
  };
  return validateAvatarAssets({ still: decode("still"), icon: decode("icon"), ...(value.assets.newSession !== undefined ? { newSession: decode("newSession") } : {}), ...(value.assets.fab !== undefined ? { fab: decode("fab") } : {}), ...(value.label !== undefined ? { label: value.label as string } : {}) });
}
export type AvatarAssets = { still: Buffer; icon: Buffer; fab?: Buffer; newSession?: Buffer; label?: string };
export function validateAvatarAssets(assets: AvatarAssets): AvatarAssets {
  for (const png of [assets.still, assets.icon, ...(assets.fab ? [assets.fab] : [])]) if (png.length > maxAvatarBytes || !validPng(png)) throw new Error("Invalid static PNG asset");
  if (assets.label !== undefined && (typeof assets.label !== "string" || !assets.label.trim() || assets.label.length > 80 || /[\x00-\x1f\x7f<>]/.test(assets.label))) throw new Error("Invalid avatar label");
  if (assets.newSession && !validAvatarAnimation(assets.newSession)) throw new Error("Invalid single-play RGBA APNG (maximum 512×512, 240 frames, 15 seconds, 8 MB)");
  return { still: assets.still, icon: assets.icon, ...(assets.fab ? { fab: assets.fab } : {}), ...(assets.newSession ? { newSession: assets.newSession } : {}), ...(assets.label !== undefined ? { label: assets.label.trim() } : {}) };
}
export async function parseAvatarZip(bytes: Buffer): Promise<AvatarAssets> {
  const files = await decodeAvatarZip(bytes);
  const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files["manifest.json"]));
  keys(manifest, ["format", "version", "label"]);
  if (manifest.format !== "pi-web-avatar" || manifest.version !== 1) throw new Error("Unsupported avatar package format or version");
  return validateAvatarAssets({ still: files["still.png"], icon: files["icon.png"], ...(files["new-session.apng"] ? { newSession: files["new-session.apng"] } : {}), ...(files["fab.png"] ? { fab: files["fab.png"] } : {}), ...(manifest.label !== undefined ? { label: manifest.label as string } : {}) });
}
export function serializeAvatarZip(assets: AvatarAssets): Buffer {
  const valid = validateAvatarAssets(assets);
  return encodeAvatarZip({ "manifest.json": Buffer.from(JSON.stringify({ format: "pi-web-avatar", version: 1, ...(valid.label ? { label: valid.label } : {}) }, null, 2) + "\n"), "still.png": valid.still, "icon.png": valid.icon, ...(valid.fab ? { "fab.png": valid.fab } : {}), ...(valid.newSession ? { "new-session.apng": valid.newSession } : {}) });
}

export function serializeAvatarPackage(assets: AvatarAssets): string {
  const value: AvatarPackage = { format: "pi-web-avatar", version: 1, assets: { still: { mediaType: "image/png", base64: assets.still.toString("base64") }, icon: { mediaType: "image/png", base64: assets.icon.toString("base64") }, ...(assets.fab ? { fab: { mediaType: "image/png" as const, base64: assets.fab.toString("base64") } } : {}), ...(assets.newSession ? { newSession: { mediaType: "image/apng" as const, base64: assets.newSession.toString("base64") } } : {}) }, ...(assets.label ? { label: assets.label } : {}) };
  parseAvatarPackage(value);
  return JSON.stringify(value, null, 2) + "\n";
}
export async function receiveAvatarPackage(req: IncomingMessage, settingsFile: string): Promise<string> {
  const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  const isZip = type === "application/zip";
  if (!isZip && !["application/json", "application/vnd.pi-web-avatar+json"].includes(type ?? "")) throw new Error("Expected application/zip or application/json");
  const limit = isZip ? maxAvatarZipBytes : maxAvatarPackageBytes;
  if (Number(req.headers["content-length"]) > limit) throw new Error("Avatar package too large");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Avatar package too large"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  const assets = isZip ? await parseAvatarZip(bytes) : parseAvatarPackage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  return createAvatarGeneration(settingsFile, assets);
}

export async function createAvatarGeneration(settingsFile: string, assets: AvatarAssets): Promise<string> {
  assets = validateAvatarAssets(assets);
  const id = randomUUID(); const dir = join(avatarDirectory(settingsFile), id);
  try { await mkdir(dir, { recursive: true }); await writeFile(join(dir, "still.png"), assets.still); await writeFile(join(dir, "icon.png"), assets.icon); if (assets.fab) await writeFile(join(dir, "fab.png"), assets.fab); if (assets.newSession) await writeFile(join(dir, "new-session.apng"), assets.newSession); if (assets.label) await writeFile(join(dir, "label.json"), JSON.stringify(assets.label)); return id; }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
/** Commit the settings pointer only after a complete generation exists. */
export async function commitAvatarGeneration<T>(settingsFile: string, assetId: string, commit: () => Promise<T>, previousAssetId?: string): Promise<T> {
  let result: T;
  try { result = await commit(); }
  catch (error) { await removeAvatarGeneration(settingsFile, assetId); throw error; }
  // Keep one previous generation for readers already holding its pointer, but
  // bound retained storage across replacements. Callers serialize mutations.
  // Cleanup failure must never roll back/delete the newly committed generation.
  try {
    const generations = await readdir(avatarDirectory(settingsFile));
    await Promise.all(generations.filter(id => isAvatarAssetId(id) && id !== assetId && id !== previousAssetId).map(id => removeAvatarGeneration(settingsFile, id)));
  } catch (error) { console.warn("Could not reclaim superseded avatar generations", error); }
  return result;
}
export async function removeAvatarGeneration(settingsFile: string, id: string): Promise<void> { if (isAvatarAssetId(id)) await rm(join(avatarDirectory(settingsFile), id), { recursive: true, force: true }); }
export { isAvatarAssetId as validAssetId } from "./shared/appIdentity.js";
export async function readAvatar(settingsFile: string, assetId?: string, role: "still" | "icon" | "fab" | "newSession" = "still"): Promise<Buffer | undefined> {
  if (assetId !== undefined && !isAvatarAssetId(assetId)) return undefined;
  if (!assetId && (role === "newSession" || role === "fab")) return undefined;
  try { return await readFile(assetId ? join(avatarDirectory(settingsFile), assetId, role === "newSession" ? "new-session.apng" : `${role}.png`) : avatarFile(settingsFile)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function selectedAvatarAssets(settingsFile: string, assetId?: string): Promise<AvatarAssets> {
  const still = await readAvatar(settingsFile, assetId), icon = await readAvatar(settingsFile, assetId, "icon");
  if (!still || !icon) throw new Error("Custom avatar is unavailable");
  let label: string | undefined;
  if (assetId) { try { label = JSON.parse(await readFile(join(avatarDirectory(settingsFile), assetId, "label.json"), "utf8")); } catch {} }
  return { still, icon, label, fab: await readAvatar(settingsFile, assetId, "fab"), newSession: await readAvatar(settingsFile, assetId, "newSession") };
}
export async function exportAvatarPackage(settingsFile: string, assetId?: string): Promise<string> { return serializeAvatarPackage(await selectedAvatarAssets(settingsFile, assetId)); }
export async function exportAvatarZip(settingsFile: string, assetId?: string): Promise<Buffer> { return serializeAvatarZip(await selectedAvatarAssets(settingsFile, assetId)); }
export function publicIdentityAssets(settings: PiWebSettings, uploadedPng?: Buffer) {
  const identity = settings.identity.avatar.type === "custom" && !uploadedPng
    ? { ...settings.identity, avatar: { type: "preset" as const, id: "current-pi" as const } }
    : settings.identity;
  return resolveAvatarBundle(identity);
}

export function identityManifest(settings: PiWebSettings, selectedIcon?: Buffer) {
  const { name, shortName } = settings.identity;
  const icon = `/identity/icon.png?v=${settings.identity.revision}`;
  // Stored generation assets were validated before publication. Manifest reads
  // need only bounded IHDR dimensions, never another synchronous decompression.
  const hasHeader = selectedIcon && selectedIcon.length >= 33 && selectedIcon.subarray(0, 8).equals(signature) && selectedIcon.readUInt32BE(8) === 13 && selectedIcon.toString("ascii", 12, 16) === "IHDR";
  const width = hasHeader ? selectedIcon.readUInt32BE(16) : 0;
  const height = hasHeader ? selectedIcon.readUInt32BE(20) : 0;
  const sizes = width >= 1 && height >= 1 && width <= 2048 && height <= 2048 ? `${width}x${height}` : "512x512";
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
    // Report actual custom icon dimensions; built-in icons are 512×512.
    // None has a verified maskable safe zone.
    icons: [{ src: icon, sizes, type: "image/png", purpose: "any" }],
  };
}
