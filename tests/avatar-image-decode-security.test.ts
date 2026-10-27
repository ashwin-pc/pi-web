import { beforeEach, describe, expect, it, vi } from "vitest";

const inflateLimits = vi.hoisted(() => [] as number[]);
vi.mock("node:zlib", async importOriginal => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    inflateSync(input: Parameters<typeof actual.inflateSync>[0], options?: { maxOutputLength?: number }) {
      if (options?.maxOutputLength !== undefined) inflateLimits.push(options.maxOutputLength);
      return actual.inflateSync(input, options);
    },
  };
});

import { crc32, deflateSync } from "node:zlib";
import { validateAvatarAssets, validPng } from "../server/appIdentity.js";
import { validAvatarAnimation } from "../server/avatarAnimation.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string | Buffer, body: Buffer): Buffer {
  const typeBytes = Buffer.isBuffer(type) ? type : Buffer.from(type, "latin1");
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length);
  typeBytes.copy(result, 4);
  body.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function png(width: number, height: number, raw: Buffer, ancillary?: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    ...(ancillary ? [ancillary] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function apng(frameCount: number): Buffer {
  const width = 512, height = 512;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(frameCount);
  animation.writeUInt32BE(1, 4);
  const pixels = deflateSync(Buffer.alloc((width * 4 + 1) * height));
  const chunks = [signature, chunk("IHDR", header), chunk("acTL", animation)];
  let sequence = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence++);
    control.writeUInt32BE(width, 4);
    control.writeUInt32BE(height, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(100, 22);
    chunks.push(chunk("fcTL", control));
    if (frame === 0) chunks.push(chunk("IDAT", pixels));
    else {
      const data = Buffer.alloc(pixels.length + 4);
      data.writeUInt32BE(sequence++);
      pixels.copy(data, 4);
      chunks.push(chunk("fdAT", data));
    }
  }
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

describe("avatar image decode limits", () => {
  beforeEach(() => { inflateLimits.length = 0; });

  it("ties static PNG inflation to the IHDR-declared raw size", () => {
    expect(validPng(png(1, 1, Buffer.alloc(1024)))).toBe(false);
    expect(inflateLimits).toEqual([5]);
    expect(validPng(png(1, 1, Buffer.alloc(5)))).toBe(true);
  });

  it("caps cumulative APNG frame inflation while allowing animation below the budget", () => {
    expect(validAvatarAnimation(apng(32))).toBe(false);
    expect(inflateLimits).toHaveLength(31);
    inflateLimits.length = 0;
    expect(validAvatarAnimation(apng(31))).toBe(true);
    expect(inflateLimits).toHaveLength(31);
  });

  it("discloses the cumulative decoded-frame budget when rejecting an APNG", () => {
    const still = png(1, 1, Buffer.alloc(5));
    expect(() => validateAvatarAssets({ still, icon: still, newSession: apng(32) })).toThrow(
      "at most 32 MiB of cumulative decoded frames, including a separate default poster, which permits at most 31 full-size 512×512 RGBA frames; these are separate ceilings, so not all combinations are accepted",
    );
  });

  it("rejects high-bit chunk aliases but accepts legitimate ancillary chunks", () => {
    const raw = Buffer.alloc(5);
    const text = chunk("tEXt", Buffer.from("note"));
    const highBitText = chunk(Buffer.from([0xf4, 0x45, 0x58, 0x74]), Buffer.from("note"));
    expect(validPng(png(1, 1, raw, text))).toBe(true);
    expect(validPng(png(1, 1, raw, highBitText))).toBe(false);
    const animation = apng(1);
    expect(validAvatarAnimation(Buffer.concat([animation.subarray(0, 33), text, animation.subarray(33)]))).toBe(true);
    expect(validAvatarAnimation(Buffer.concat([animation.subarray(0, 33), highBitText, animation.subarray(33)]))).toBe(false);
  });
});
