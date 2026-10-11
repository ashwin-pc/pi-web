import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { validAvatarAnimation } from "../server/avatarAnimation.js";
import { commitAvatarGeneration, createAvatarGeneration, exportAvatarPackage, exportAvatarZip, parseAvatarPackage, parseAvatarZip, readAvatar } from "../server/appIdentity.js";
import { resolveAvatarBundle } from "../server/shared/appIdentity.js";

describe("custom animated bundles", () => {
  it("round trips animation through both packages and generation storage", async () => {
    const still = await readFile("public/avatars/fox/still.png");
    const icon = await readFile("public/avatars/fox/icon.png");
    const fab = await readFile("public/avatars/cat/still.png");
    const newSession = await readFile("public/avatars/fox/new-session.apng");
    expect(validAvatarAnimation(newSession)).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "animated-avatar-"));
    try {
      const file = join(root, "settings.json");
      const id = await createAvatarGeneration(file, { still, fab, icon, newSession });
      expect(await readAvatar(file, id, "newSession")).toEqual(newSession);
      expect(await readAvatar(file, id, "fab")).toEqual(fab);
      expect(parseAvatarPackage(JSON.parse(await exportAvatarPackage(file, id))).fab).toEqual(fab);
      expect((await parseAvatarZip(await exportAvatarZip(file, id))).fab).toEqual(fab);
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id, animated: true } }).fab).toBe("/identity/fab.png?v=1");
      expect(parseAvatarPackage(JSON.parse(await exportAvatarPackage(file, id))).newSession).toEqual(newSession);
      expect((await parseAvatarZip(await exportAvatarZip(file, id))).newSession).toEqual(newSession);
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id, animated: true } }).newSession?.apng).toBe("/identity/new-session.apng?v=1");
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id } }).newSession).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reclaims old generations only after commit while preserving the previous reader and rollback", async () => {
    const still = await readFile("public/avatars/fox/still.png");
    const root = await mkdtemp(join(tmpdir(), "avatar-reclaim-"));
    const file = join(root, "settings.json");
    try {
      const oldest = await createAvatarGeneration(file, { still, icon: still });
      const previous = await createAvatarGeneration(file, { still, icon: still });
      const current = await createAvatarGeneration(file, { still, icon: still });
      await commitAvatarGeneration(file, current, async () => {
        expect(await readAvatar(file, oldest)).toEqual(still);
        return "committed";
      }, previous);
      expect(await readAvatar(file, oldest)).toBeUndefined();
      expect(await readAvatar(file, previous)).toEqual(still);
      expect(await readAvatar(file, current)).toEqual(still);
      const failed = await createAvatarGeneration(file, { still, icon: still });
      await expect(commitAvatarGeneration(file, failed, async () => { throw new Error("disk failure"); }, current)).rejects.toThrow("disk failure");
      expect(await readAvatar(file, failed)).toBeUndefined();
      expect(await readAvatar(file, previous)).toEqual(still);
      expect(await readAvatar(file, current)).toEqual(still);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects infinite looping, corrupted frames, truncation, static PNG and excessive dimensions", async () => {
    const original = await readFile("public/avatars/fox/new-session.apng");
    const looping = Buffer.from(original);
    const control = looping.indexOf("acTL");
    looping.writeUInt32BE(0, control + 8);
    looping.writeUInt32BE(crc32(looping.subarray(control, control + 12)), control + 12);
    expect(validAvatarAnimation(looping)).toBe(false);
    const corrupt = Buffer.from(original); corrupt[corrupt.indexOf("fdAT") + 12] ^= 255;
    expect(validAvatarAnimation(corrupt)).toBe(false);
    expect(validAvatarAnimation(original.subarray(0, original.length - 1))).toBe(false);
    expect(validAvatarAnimation(await readFile("public/avatars/fox/still.png"))).toBe(false);
    const huge = Buffer.from(original); huge.writeUInt32BE(2048, 16); huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
    expect(validAvatarAnimation(huge)).toBe(false);
  });
});
