import { crc32, inflateSync } from "node:zlib";
import { maxAvatarAnimationBytes } from "./shared/appIdentity.js";

/** Bounded, non-interlaced RGBA APNG; validate every frame, not just its poster. */
export function validAvatarAnimation(bytes: Buffer): boolean {
  try {
    if (bytes.length > maxAvatarAnimationBytes || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
    let offset = 8, width = 0, height = 0, frames = 0, declared = 0, sequence = 0, duration = 0, ended = false;
    let frameWidth = 0, frameHeight = 0, data: Buffer[] = [], firstData = false, separatePoster = false, sawPalette = false;
    const finish = () => {
      if (!data.length) throw new Error("Missing frame data");
      const stride = frameWidth * 4 + 1;
      const raw = inflateSync(Buffer.concat(data), { maxOutputLength: stride * frameHeight });
      if (raw.length !== stride * frameHeight) throw new Error("Invalid frame size");
      for (let y = 0; y < frameHeight; y++) if (raw[y * stride] > 4) throw new Error("Invalid filter");
      data = [];
    };
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return false;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      const body = bytes.subarray(offset + 8, offset + 8 + length);
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13 || body[8] !== 8 || body[9] !== 6 || body[10] || body[11] || body[12]) return false;
        width = body.readUInt32BE(0); height = body.readUInt32BE(4);
        if (!width || !height || width > 512 || height > 512) return false;
        frameWidth = width; frameHeight = height;
      } else if (type === "PLTE") {
        // RGBA may carry a suggested palette, but only once before image data.
        if (sawPalette || firstData || data.length || !length || length > 768 || length % 3) return false;
        sawPalette = true;
      } else if (type === "acTL") {
        if (declared || frames || firstData || length !== 8 || body.readUInt32BE(4) !== 1) return false;
        declared = body.readUInt32BE(0);
        if (declared < 1 || declared > 240) return false;
      } else if (type === "fcTL") {
        if (!declared || length !== 26 || body.readUInt32BE(0) !== sequence++) return false;
        if (frames) finish();
        else if (firstData) { finish(); separatePoster = true; }
        frameWidth = body.readUInt32BE(4); frameHeight = body.readUInt32BE(8);
        if (!frameWidth || !frameHeight || frameWidth + body.readUInt32BE(12) > width || frameHeight + body.readUInt32BE(16) > height || body[24] > 2 || body[25] > 1) return false;
        if (!frames && !separatePoster && (frameWidth !== width || frameHeight !== height || body.readUInt32BE(12) || body.readUInt32BE(16))) return false;
        duration += body.readUInt16BE(20) / (body.readUInt16BE(22) || 100);
        if (duration > 15 || ++frames > declared) return false;
      } else if (type === "IDAT") {
        if (!declared || separatePoster || frames > 1) return false;
        data.push(body); firstData = true;
      } else if (type === "fdAT") {
        if (frames < (separatePoster ? 1 : 2) || length < 5 || body.readUInt32BE(0) !== sequence++) return false;
        data.push(body.subarray(4));
      } else if (type === "IEND") {
        if (length || frames !== declared || !firstData) return false;
        finish(); ended = true; offset += 12; break;
      } else if (!/^[a-zA-Z]{4}$/.test(type) || type[0] === type[0].toUpperCase()) return false;
      offset += length + 12;
    }
    return ended && offset === bytes.length;
  } catch { return false; }
}
