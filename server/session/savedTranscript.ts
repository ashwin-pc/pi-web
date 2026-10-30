import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionReadText } from "./referenceTools.js";
import { sanitizeSavedTranscriptRecord, savedTranscriptRecordLimits } from "./savedTranscriptSanitizer.js";

export const savedTranscriptLimits = {
  maxRecordBytes: savedTranscriptRecordLimits.maxBytes,
} as const;

export class SavedTranscriptReadError extends Error {
  constructor(message: string, readonly status: 404 | 413) {
    super(message);
    this.name = "SavedTranscriptReadError";
  }
}

type ReadSavedTranscriptOptions = {
  path: string;
  sessionId: string;
  tail: number;
  entryId?: string;
  project(record: unknown, compact: boolean): SessionReadText | undefined;
};

export type SavedTranscriptReadResult = {
  entries: SessionReadText[];
  truncatedBeforeTail: boolean;
  matchedEntry: boolean;
};

export async function readSavedTranscript(options: ReadSavedTranscriptOptions): Promise<SavedTranscriptReadResult> {
  try { await stat(options.path); }
  catch { throw new SavedTranscriptReadError("Session not found", 404); }

  const stream = createReadStream(options.path);
  let lineBytes = 0;
  let fragments: Buffer[] = [];
  let discardingOversizedLine = false;
  let skippedOversizedLine = false;
  let sawHeader = false;
  let readableEntries = 0;
  let matchedEntry = false;
  const entries: SessionReadText[] = [];

  const consumeLine = (suffix?: Buffer) => {
    const parts = suffix?.length ? [...fragments, suffix] : fragments;
    const line = parts.length === 0 ? Buffer.alloc(0) : parts.length === 1 ? parts[0] : Buffer.concat(parts, lineBytes);
    fragments = [];
    lineBytes = 0;
    const text = line.toString("utf8").replace(/\r$/, "").trim();
    if (!text) return false;
    let record: unknown;
    try { record = sanitizeSavedTranscriptRecord(JSON.parse(text)); }
    catch { return false; }
    if (!sawHeader) {
      const header = record && typeof record === "object" ? record as Record<string, unknown> : undefined;
      if (header?.type !== "session" || header.id !== options.sessionId) {
        throw new SavedTranscriptReadError("Session not found", 404);
      }
      sawHeader = true;
      return false;
    }
    if (options.entryId) {
      const id = record && typeof record === "object" ? (record as Record<string, unknown>).id : undefined;
      if (id !== options.entryId) return false;
      matchedEntry = true;
      const projected = options.project(record, false);
      if (projected) entries.push(projected);
      return true;
    }
    const projected = options.project(record, true);
    if (!projected) return false;
    readableEntries += 1;
    entries.push(projected);
    if (entries.length > options.tail) entries.shift();
    return false;
  };

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const slice = bytes.subarray(offset, end);
        if (!discardingOversizedLine) {
          lineBytes += slice.length;
          if (lineBytes > savedTranscriptLimits.maxRecordBytes) {
            fragments = [];
            lineBytes = 0;
            discardingOversizedLine = true;
            skippedOversizedLine = true;
          }
        }
        if (newline < 0) {
          if (!discardingOversizedLine && slice.length) fragments.push(slice);
          break;
        }
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
        } else if (consumeLine(slice)) {
          return { entries, truncatedBeforeTail: skippedOversizedLine, matchedEntry };
        }
        offset = newline + 1;
      }
    }
    if (!discardingOversizedLine && lineBytes && consumeLine()) {
      return { entries, truncatedBeforeTail: skippedOversizedLine, matchedEntry };
    }
  } finally {
    stream.destroy();
  }
  if (!sawHeader) throw new SavedTranscriptReadError("Session not found", 404);
  return { entries, truncatedBeforeTail: skippedOversizedLine || readableEntries > entries.length, matchedEntry };
}
