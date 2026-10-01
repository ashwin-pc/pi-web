import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarPresetIds, avatarPresets, resolveAvatarBundle } from "../server/shared/appIdentity.js";
import { applySettingsPatch, normalizeSettings } from "../server/settings.js";
import { identityManifest, readAvatar, receiveAvatar } from "../server/appIdentity.js";

function request(data: Buffer, type = "image/png") {
  return Object.assign(Readable.from([data]), { headers: { "content-type": type, "content-length": String(data.length) } }) as any;
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
      await receiveAvatar(request(png), file);
      expect(await readAvatar(file)).toEqual(png);
      await expect(receiveAvatar(request(png.subarray(0, 24)), file)).rejects.toThrow("Invalid PNG");
      await expect(receiveAvatar(request(png.subarray(0, -12)), file)).rejects.toThrow("Invalid PNG");
      expect(await readAvatar(file)).toEqual(png);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
