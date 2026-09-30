import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { PiWebSettings } from "./settings.js";

export const maxAvatarBytes = 2 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function avatarFile(settingsFile: string): string { return join(dirname(settingsFile), "pi-web-avatar.png"); }
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
    icons: [
      { src: icon, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}
