import { crc32 } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { zipSync } from "fflate";
import { maxAvatarZipBytes, maxAvatarAnimationBytes } from "./shared/appIdentity.js";

const limits: Record<string, number> = { "manifest.json": 4096, "still.png": 2 * 1024 * 1024, "icon.png": 2 * 1024 * 1024, "fab.png": 2 * 1024 * 1024, "new-session.apng": maxAvatarAnimationBytes };

/** Fixed-file archive codec: never extracts archive-controlled filesystem paths. */
export async function decodeAvatarZip(bytes: Buffer): Promise<Record<string, Buffer>> {
  if (bytes.length > maxAvatarZipBytes) throw new Error("Avatar ZIP too large");
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file!)));
  try {
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const found: Entry[] = []; const names = new Set<string>();
      zip.on("error", reject);
      zip.on("entry", (entry: Entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!Object.hasOwn(limits, entry.fileName) || names.has(entry.fileName) || entry.generalPurposeBitFlag & ~0x080e || ![0, 8].includes(entry.compressionMethod) || (mode !== 0 && mode !== 0x8000) || entry.uncompressedSize > limits[entry.fileName] || entry.compressedSize > maxAvatarZipBytes || entry.fileComment || found.length >= Object.keys(limits).length) {
          reject(new Error("Invalid avatar ZIP entry")); return;
        }
        names.add(entry.fileName); found.push(entry); zip.readEntry();
      });
      zip.on("end", () => found.length >= 3 && ["manifest.json", "still.png", "icon.png"].every(name => names.has(name)) && !zip.comment ? resolve(found) : reject(new Error("Avatar ZIP requires manifest.json, still.png, icon.png and optional fab.png/new-session.apng")));
      zip.readEntry();
    });
    const result: Record<string, Buffer> = {}; let total = 0;
    for (const entry of entries) {
      result[entry.fileName] = await new Promise<Buffer>((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error ?? new Error("Missing ZIP stream")); return; }
          const chunks: Buffer[] = []; let size = 0; let checksum = 0;
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length; total += chunk.length;
            if (size > limits[entry.fileName] || total > 6 * 1024 * 1024 + maxAvatarAnimationBytes + 4096) { stream.destroy(new Error("Avatar ZIP inflated data too large")); return; }
            checksum = crc32(chunk, checksum); chunks.push(chunk);
          });
          stream.on("end", () => size === entry.uncompressedSize && checksum === entry.crc32 ? resolve(Buffer.concat(chunks)) : reject(new Error("Avatar ZIP size or CRC mismatch")));
        });
      });
    }
    return result;
  } finally { zip.close(); }
}
export function encodeAvatarZip(files: Record<string, Buffer>): Buffer {
  // Stable timestamps and insertion order make repeated exports deterministic.
  const output = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, { mtime: new Date(1980, 0, 1, 0, 0, 0) }]])), { level: 6 }));
  if (output.length > maxAvatarZipBytes) throw new Error("Avatar ZIP too large");
  return output;
}
