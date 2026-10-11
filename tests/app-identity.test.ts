import { describe, expect, it } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarPresetIds, avatarPresets, resolveAvatarBundle } from "../server/shared/appIdentity.js";
import { applySettingsPatch, normalizeSettings } from "../server/settings.js";
import { avatarDirectory, avatarFile, commitAvatarGeneration, createAvatarGeneration, exportAvatarPackage, identityManifest, parseAvatarPackage, readAvatar, receiveAvatar, receiveAvatarPackage, removeAvatarGeneration, serializeAvatarPackage, validPng } from "../server/appIdentity.js";

function request(data: Buffer, type = "image/png") {
  return Object.assign(Readable.from([data]), { headers: { "content-type": type, "content-length": String(data.length) } }) as any;
}
function solidPng(size: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(size * (size * 4 + 1)))), chunk("IEND", Buffer.alloc(0))]);
}
const png = await readFile(new URL("../public/avatars/current-pi/still.png", import.meta.url));
describe("app identity", () => {
  it("resolves all nine bundled presets consistently", async () => {
    expect(avatarPresetIds).toHaveLength(9);
    for (const id of avatarPresetIds) {
      const bundle = avatarPresets[id];
      expect(bundle.still).toBe(`/avatars/${id}/still.png`);
      expect(bundle.fab).toBe(bundle.still);
      expect(bundle.icon).toBe(`/avatars/${id}/icon.png`);
      const iconBytes = await readFile(new URL(`../public/avatars/${id}/icon.png`, import.meta.url));
      expect([iconBytes.readUInt32BE(16), iconBytes.readUInt32BE(20)]).toEqual([512, 512]);
      const image = await readFile(new URL(`../public${bundle.still}`, import.meta.url));
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([512, 512]);
      expect(image[25]).toBe(6); // RGBA, never opaque in-app artwork
      expect(bundle.newSession?.apng).toBe(`/avatars/${id}/new-session.apng`);
      const apng = await readFile(new URL(`../public${bundle.newSession!.apng}`, import.meta.url));
      expect(apng[25]).toBe(6);
      const animationControl = apng.indexOf("acTL");
      expect(animationControl).toBeGreaterThan(0);
      expect(apng.readUInt32BE(animationControl + 4)).toBeGreaterThan(1); // real frames
      expect(apng.readUInt32BE(animationControl + 8)).toBe(1); // settle, do not loop
      expect(bundle.newSession).not.toHaveProperty("sprite");
    }
  });
  it("validates optional static suggested palettes before persisting package assets", () => {
    const base = solidPng(1);
    const palette = (size: number) => {
      const chunk = Buffer.alloc(size + 12); chunk.writeUInt32BE(size); chunk.write("PLTE", 4); chunk.writeUInt32BE(crc32(chunk.subarray(4, size + 8)), size + 8); return chunk;
    };
    const insert = (chunk: Buffer) => Buffer.concat([base.subarray(0, 33), chunk, base.subarray(33)]);
    expect(validPng(insert(palette(3)))).toBe(true);
    const invalid = [insert(palette(0)), insert(palette(2)), insert(palette(771)), insert(Buffer.concat([palette(3), palette(3)])), Buffer.concat([base.subarray(0, -12), palette(3), base.subarray(-12)])];
    for (const still of invalid) {
      expect(validPng(still)).toBe(false);
      expect(() => parseAvatarPackage({ format: "pi-web-avatar", version: 1, assets: { still: { mediaType: "image/png", base64: still.toString("base64") }, icon: { mediaType: "image/png", base64: base.toString("base64") } } })).toThrow("Invalid static PNG asset");
    }
  });
  it("reads stored icon metadata from the bounded header without requiring image decompression", () => {
    const settings = normalizeSettings({});
    const headerOnly = solidPng(1024).subarray(0, 33);
    expect(validPng(headerOnly)).toBe(false);
    expect(identityManifest(settings, headerOnly).icons[0].sizes).toBe("1024x1024");
    expect(identityManifest(settings, Buffer.alloc(0)).icons[0].sizes).toBe("512x512");
  });
  it("validates identity patches and retains stable manifest identity", () => {
    const original = normalizeSettings(undefined);
    const invalid = applySettingsPatch(original, { identity: { name: " ", avatar: { type: "preset", id: "unknown" }, revision: 999 } });
    expect(invalid.identity).toEqual(original.identity);
    const updated = applySettingsPatch(original, { identity: { name: "My App", avatar: { type: "preset", id: "fox" } } });
    expect(updated.identity.revision).toBe(1);
    expect(resolveAvatarBundle(updated.identity).icon).toBe("/avatars/fox/icon.png");
    const manifest = identityManifest(updated);
    expect(manifest).toMatchObject({ id: "/", start_url: "/", name: "My App" });
    expect(manifest.icons).toEqual([{ src: "/identity/icon.png?v=1", sizes: "512x512", type: "image/png", purpose: "any" }]);
  });
  it("accepts only bounded PNG uploads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-identity-"));
    const file = join(dir, "settings.json");
    try {
      await expect(receiveAvatar(request(Buffer.from("garbage")), file)).rejects.toThrow("Invalid PNG");
      await expect(receiveAvatar(request(png, "text/plain"), file)).rejects.toThrow("image/png");
      await expect(receiveAvatar(request(Buffer.alloc(2 * 1024 * 1024 + 1)), file)).rejects.toThrow("2 MB");
      const assetId = await receiveAvatar(request(png), file);
      expect(await readAvatar(file, assetId)).toEqual(png);
      await expect(receiveAvatar(request(png.subarray(0, 24)), file)).rejects.toThrow("Invalid PNG");
      await expect(receiveAvatar(request(png.subarray(0, -12)), file)).rejects.toThrow("Invalid PNG");
      expect(await readAvatar(file, assetId)).toEqual(png);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("round trips independent roles across same-parent instances and restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-packages-"));
    try {
      const a = join(dir, "a.json"), b = join(dir, "b.json");
      const icon = await readFile(new URL("../public/avatars/fox/icon.png", import.meta.url));
      const serialized = serializeAvatarPackage({ still: png, icon, label: "Bleckbeard" });
      const first = await receiveAvatarPackage(request(Buffer.from(serialized), "application/json"), a);
      const second = await receiveAvatarPackage(request(Buffer.from(await exportAvatarPackage(a, first)), "application/json"), b);
      expect(second).not.toBe(first);
      expect(await readAvatar(b, second)).toEqual(png);
      expect(await readAvatar(b, second, "icon")).toEqual(icon);
      expect(await exportAvatarPackage(b, second)).toBe(serialized);
      const saved = normalizeSettings({ identity: { avatar: { type: "custom", assetId: second } } });
      expect(saved.identity.avatar).toEqual({ type: "custom", assetId: second });
      await removeAvatarGeneration(a, first);
      expect(await readAvatar(a, first)).toBeUndefined();
      expect(await readAvatar(b, second)).toEqual(png);
      await writeFile(avatarFile(a), png);
      expect(await readAvatar(a)).toEqual(png);
      expect(await readAvatar(b, "../../escape")).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects noncanonical packages and unsafe PNGs without mutation", async () => {
    const value = JSON.parse(serializeAvatarPackage({ still: png, icon: png }));
    for (const invalid of [{ ...value, version: 2 }, { ...value, format: "zip" }, { ...value, path: "../x" }, { ...value, label: "<script>" }, { ...value, assets: { ...value.assets, extra: value.assets.still } }]) expect(() => parseAvatarPackage(invalid)).toThrow();
    expect(() => parseAvatarPackage({ ...value, assets: { ...value.assets, still: { mediaType: "image/png", base64: value.assets.still.base64 + "\n" } } })).toThrow();
    const corrupt = Buffer.from(png); corrupt[40] ^= 1; expect(validPng(corrupt)).toBe(false);
    const animation = await readFile(new URL("../public/avatars/fox/new-session.apng", import.meta.url));
    expect(validPng(animation)).toBe(false);
    expect(() => parseAvatarPackage({ ...value, assets: { ...value.assets, icon: { mediaType: "image/svg+xml", base64: "PHN2Zz4=" } } })).toThrow();
  });

  it("rolls back only an uncommitted generation on settings failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rollback-")); const file = join(dir, "settings.json");
    try {
      const oldId = await createAvatarGeneration(file, { still: png, icon: png });
      const newId = await createAvatarGeneration(file, { still: png, icon: png });
      await expect(commitAvatarGeneration(file, newId, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
      expect(await readAvatar(file, newId)).toBeUndefined();
      expect(await readAvatar(file, oldId)).toEqual(png);
      expect(await commitAvatarGeneration(file, oldId, async () => "committed")).toBe("committed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("exports legacy and new non-512 PNG uploads without changing bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-size-"));
    try {
      for (const size of [1, 32, 2048]) {
        const image = solidPng(size), a = join(dir, `a-${size}.json`), b = join(dir, `b-${size}.json`);
        await writeFile(avatarFile(a), image);
        const legacy = await exportAvatarPackage(a);
        const newId = await receiveAvatar(request(image), a);
        expect(await exportAvatarPackage(a, newId)).toBe(legacy);
        const imported = await receiveAvatarPackage(request(Buffer.from(legacy), "application/json"), b);
        expect(await readAvatar(b, imported)).toEqual(image);
        expect(await readAvatar(b, imported, "icon")).toEqual(image);
        const settings = normalizeSettings({ identity: { avatar: { type: "custom", assetId: imported } } });
        expect(identityManifest(settings, image).icons[0].sizes).toBe(`${size}x${size}`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects malformed UTF-8 before creating assets or changing saved identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-utf8-")); const file = join(dir, "settings.json");
    try {
      const oldId = await createAvatarGeneration(file, { still: png, icon: png });
      const saved = JSON.stringify({ identity: { avatar: { type: "custom", assetId: oldId } } });
      await writeFile(file, saved);
      const body = Buffer.from(serializeAvatarPackage({ still: png, icon: png, label: "X" }));
      body[body.indexOf(Buffer.from('"label": "X"')) + '"label": "'.length] = 0xff;
      await expect(receiveAvatarPackage(request(body, "application/json"), file)).rejects.toThrow();
      expect(await readdir(avatarDirectory(file))).toEqual([oldId]);
      expect(await readFile(file, "utf8")).toBe(saved);
      expect(await readAvatar(file, oldId)).toEqual(png);
      // A legitimately encoded replacement character is valid plaintext.
      const good = Buffer.from(serializeAvatarPackage({ still: png, icon: png, label: "\ufffd" }));
      await expect(receiveAvatarPackage(request(good, "application/json"), file)).resolves.toBeTypeOf("string");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
