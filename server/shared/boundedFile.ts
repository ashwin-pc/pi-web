import { open } from "node:fs/promises";

export class BoundedFileError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File exceeds ${maxBytes} bytes`);
    this.name = "BoundedFileError";
  }
}

/** Read at most maxBytes without allowing readFile() to allocate from file size. */
export async function readUtf8FileBounded(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (offset > maxBytes) throw new BoundedFileError(maxBytes);
  return buffer.toString("utf8", 0, offset);
}
