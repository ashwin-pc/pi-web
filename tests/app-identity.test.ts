import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarPresetIds, avatarPresets, resolveAvatarBundle } from "../src/appIdentity.js";
import { applySettingsPatch, normalizeSettings } from "../server/settings.js";
import { identityManifest, readAvatar, receiveAvatar } from "../server/appIdentity.js";

function request(data: Buffer, type = "image/png") {
  return Object.assign(Readable.from([data]), { headers: { "content-type": type, "content-length": String(data.length) } }) as any;
}
const dimensions = Buffer.alloc(8);
dimensions.writeUInt32BE(512, 0);
dimensions.writeUInt32BE(512, 4);
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([0,0,0,13]), Buffer.from("IHDR"), dimensions]);
describe("app identity", () => {
  it("resolves all nine bundled presets consistently", async () => {
    expect(avatarPresetIds).toHaveLength(9);
    for (const id of avatarPresetIds) {
      const bundle = avatarPresets[id];
      expect(bundle.still).toBe(`/avatars/${id}/still.png`);
      expect(bundle.fab).toBe(bundle.still);
      expect(bundle.icon).toBe(`/avatars/${id}/icon.png`);
      const image = await readFile(new URL(`../public${bundle.still}`, import.meta.url));
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([512, 512]);
      expect(bundle.newSession?.sources).toEqual([
        { src: `/avatars/${id}/new-session.webm`, type: 'video/webm; codecs="vp9"' },
      ]);
      for (const source of bundle.newSession!.sources) {
        const video = await readFile(new URL(`../public${source.src}`, import.meta.url));
        expect(video.length).toBeGreaterThan(0);
      }
      expect(bundle.newSession?.apng).toBe(`/avatars/${id}/new-session.apng`);
      expect((await readFile(new URL(`../public${bundle.newSession!.apng}`, import.meta.url))).length).toBeGreaterThan(0);
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
    expect(manifest.icons).toContainEqual(expect.objectContaining({ src: "/identity/icon.png?v=1", sizes: "192x192" }));
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
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
