import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
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
      const jsonRoundtrip = parseAvatarPackage(JSON.parse(await exportAvatarPackage(file, id)));
      const zipRoundtrip = await parseAvatarZip(await exportAvatarZip(file, id));
      expect(jsonRoundtrip.fab).toEqual(fab);
      expect(zipRoundtrip.fab).toEqual(fab);
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id, animated: true } }).fab).toBe("/identity/fab.png?v=1");
      expect(jsonRoundtrip.newSession).toEqual(newSession);
      expect(zipRoundtrip.newSession).toEqual(newSession);
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id, animated: true } }).newSession?.apng).toBe("/identity/new-session.apng?v=1");
      expect(resolveAvatarBundle({ name: "Pi", shortName: "Pi", revision: 1, avatar: { type: "custom", assetId: id } }).newSession).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  // This multi-format integration performs bounded compression and validation
  // of real artwork; shared Linux runners need more than a unit-test deadline.
  }, 30_000);
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
  it("validates a separate APNG fallback poster and every fdAT frame", () => {
    const chunk = (type: string, body: Buffer) => {
      const data = Buffer.concat([Buffer.from(type), body]);
      const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
      const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(data));
      return Buffer.concat([size, data, checksum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
    const control = Buffer.alloc(8); control.writeUInt32BE(2); control.writeUInt32BE(1, 4);
    const pixels = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
    const frame = (sequence: number) => {
      const body = Buffer.alloc(26); body.writeUInt32BE(sequence); body.writeUInt32BE(1, 4); body.writeUInt32BE(1, 8); body.writeUInt16BE(1, 20); body.writeUInt16BE(10, 22);
      const order = Buffer.alloc(4); order.writeUInt32BE(sequence + 1);
      return Buffer.concat([chunk("fcTL", body), chunk("fdAT", Buffer.concat([order, pixels]))]);
    };
    const prefix = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("acTL", control)]);
    const suffix = Buffer.concat([frame(0), frame(2), chunk("IEND", Buffer.alloc(0))]);
    expect(validAvatarAnimation(Buffer.concat([prefix, chunk("IDAT", pixels), suffix]))).toBe(true);
    const palette = chunk("PLTE", Buffer.from([255, 0, 0]));
    expect(validAvatarAnimation(Buffer.concat([prefix, palette, chunk("IDAT", pixels), suffix]))).toBe(true);
    expect(validAvatarAnimation(Buffer.concat([prefix, palette, palette, chunk("IDAT", pixels), suffix]))).toBe(false);
    expect(validAvatarAnimation(Buffer.concat([prefix, chunk("PLTE", Buffer.from([1, 2])), chunk("IDAT", pixels), suffix]))).toBe(false);
    expect(validAvatarAnimation(Buffer.concat([prefix, chunk("IDAT", pixels), palette, suffix]))).toBe(false);
    expect(validAvatarAnimation(Buffer.concat([prefix, chunk("IDAT", deflateSync(Buffer.from([0, 255]))), suffix]))).toBe(false);
    const oneFrameControl = Buffer.from(control); oneFrameControl.writeUInt32BE(1);
    const oneFramePrefix = Buffer.concat([prefix.subarray(0, 33), chunk("acTL", oneFrameControl)]);
    const end = chunk("IEND", Buffer.alloc(0));
    expect(validAvatarAnimation(Buffer.concat([oneFramePrefix, chunk("IDAT", pixels), frame(0), end]))).toBe(true);
    const includedFrame = frame(0).subarray(0, 38);
    expect(validAvatarAnimation(Buffer.concat([oneFramePrefix, includedFrame, chunk("IDAT", pixels), end]))).toBe(true);
    const zeroDelayBody = Buffer.from(includedFrame.subarray(8, 34)); zeroDelayBody.writeUInt16BE(0, 20);
    expect(validAvatarAnimation(Buffer.concat([oneFramePrefix, chunk("fcTL", zeroDelayBody), chunk("IDAT", pixels), end]))).toBe(true);
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
