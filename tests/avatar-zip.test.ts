import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { zipSync } from "fflate";
import { parseAvatarZip, serializeAvatarZip, receiveAvatarPackage, avatarDirectory, readAvatar, exportAvatarZip, removeAvatarGeneration } from "../server/appIdentity.js";
const still = await readFile("public/avatars/current-pi/still.png");
const icon = await readFile("public/avatars/fox/icon.png");
import { maxAvatarZipBytes } from "../server/shared/appIdentity.js";
const manifest = Buffer.from(JSON.stringify({ format: "pi-web-avatar", version: 1, label: "Bleckbeard" }));
const files = { "manifest.json": manifest, "still.png": still, "icon.png": icon };
function archive(extra: Record<string, Uint8Array> = {}) { return Buffer.from(zipSync({ ...files, ...extra })); }
function central(bytes: Buffer): number { return bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); }
describe("portable avatar ZIP", () => {
  it("round trips distinct fixed roles deterministically", async () => {
    const zip = serializeAvatarZip({ still, icon, label: "Bleckbeard" });
    expect(zip).toEqual(serializeAvatarZip({ still, icon, label: "Bleckbeard" }));
    expect(await parseAvatarZip(zip)).toEqual({ still, icon, label: "Bleckbeard" });
  });
  it("round trips optional static FAB without introducing motion", async () => {
    expect(await parseAvatarZip(serializeAvatarZip({ still, icon, fab: icon }))).toEqual({ still, icon, fab: icon });
    await expect(parseAvatarZip(archive({ "fab.png": Buffer.from("invalid") }))).rejects.toThrow("Invalid static PNG");
    await expect(parseAvatarZip(archive({ "fab.png": Buffer.alloc(2 * 1024 * 1024 + 1) }))).rejects.toThrow();
  });
  it("rejects missing, unknown, traversal, directory and invalid animated roles", async () => {
    for (const name of ["../escape", "sub/icon.png", "\\icon.png", "new-session.apng", "folder/"]) await expect(parseAvatarZip(archive({ [name]: Buffer.from("x") }))).rejects.toThrow();
    await expect(parseAvatarZip(Buffer.from(zipSync({ "manifest.json": manifest, "still.png": still })))).rejects.toThrow();
    await expect(parseAvatarZip(archive({ "manifest.json": Buffer.from('{"format":"pi-web-avatar","version":2}') }))).rejects.toThrow();
    const apng = await readFile("public/avatars/fox/new-session.apng");
    await expect(parseAvatarZip(archive({ "icon.png": apng }))).rejects.toThrow();
  });
  it("rejects central CRC, encryption, symlink, method and truncation attacks", async () => {
    for (const mutate of [
      (b: Buffer, c: number) => b.writeUInt32LE(0, c + 16),
      (b: Buffer, c: number) => b.writeUInt16LE(1, c + 8),
      (b: Buffer, c: number) => b.writeUInt32LE((0xa000 << 16) >>> 0, c + 38),
      (b: Buffer, c: number) => b.writeUInt16LE(99, c + 10),
    ]) { const zip = archive(); mutate(zip, central(zip)); await expect(parseAvatarZip(zip)).rejects.toThrow(); }
    await expect(parseAvatarZip(archive().subarray(0, -10))).rejects.toThrow();
  });
  it("rejects duplicate names and false inflated sizes", async () => {
    const same = Buffer.from(zipSync({ "manifest.json": manifest, "still.png": still, "other.png": icon }));
    const last = same.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    Buffer.from("still.png").copy(same, last + 46);
    await expect(parseAvatarZip(same)).rejects.toThrow();
    const bomb = archive({ "manifest.json": Buffer.alloc(100_000, 65) });
    bomb.writeUInt32LE(1, central(bomb) + 24);
    await expect(parseAvatarZip(bomb)).rejects.toThrow();
    await expect(parseAvatarZip(archive({ "manifest.json": Buffer.alloc(4097) }))).rejects.toThrow();
  });
  it("rejects malformed manifest UTF-8 without creating generation files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-zip-invalid-"));
    try {
      const file = join(dir, "settings.json"); const broken = Buffer.from(manifest); broken[broken.indexOf("Bleckbeard")] = 255;
      const bytes = archive({ "manifest.json": broken });
      const req = Object.assign(Readable.from([bytes]), { headers: { "content-type": "application/zip" } }) as any;
      await expect(receiveAvatarPackage(req, file)).rejects.toThrow();
      await expect(readdir(avatarDirectory(file))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses the same isolated asset store across instances and enforces wire bounds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-zip-roundtrip-"));
    const request = (bytes: Buffer, length = bytes.length) => Object.assign(Readable.from([bytes]), { headers: { "content-type": "application/zip", "content-length": String(length) } }) as any;
    try {
      const a = join(dir, "a.json"), b = join(dir, "b.json");
      const first = await receiveAvatarPackage(request(serializeAvatarZip({ still, icon })), a);
      const second = await receiveAvatarPackage(request(await exportAvatarZip(a, first)), b);
      expect(second).not.toBe(first);
      expect(await readAvatar(b, second)).toEqual(still);
      expect(await readAvatar(b, second, "icon")).toEqual(icon);
      await removeAvatarGeneration(a, first);
      expect(await readAvatar(b, second)).toEqual(still);
      await expect(receiveAvatarPackage(request(Buffer.alloc(0), maxAvatarZipBytes + 1), b)).rejects.toThrow("too large");
      expect(await readdir(avatarDirectory(b))).toEqual([second]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
