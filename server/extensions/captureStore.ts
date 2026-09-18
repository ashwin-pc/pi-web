import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const MAX_CAPTURE_SECONDS = 120;
export const MAX_CAPTURE_BYTES = 25_000_000;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING_CAPTURES = 32;
const MAX_PENDING_BYTES = 100_000_000;
const MAX_ACTIVE_UPLOADS = 4;
const MAX_ACTIVE_UPLOAD_BYTES = 50_000_000;

export class CaptureHttpError extends Error {
  constructor(message: string, readonly status: 400 | 408 | 409 | 413 | 429) { super(message); }
}

export type AudioCapturePolicy = {
  media: "audio";
  maxSeconds: number;
  maxBytes: number;
  mimeTypes?: string[];
};

export type ValidatedAudioCapture = {
  path: string;
  mimeType: string;
  size: number;
  durationMs: number;
};

type StoredCapture = ValidatedAudioCapture & {
  id: string;
  sessionId: string;
  contributionKey: string;
  registrationId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Bounds raw request buffering before an upload reaches the temporary store. */
export class CaptureUploadLimiter {
  private activeUploads = 0;
  private activeBytes = 0;

  begin(declaredBytes?: number) {
    if (this.activeUploads >= MAX_ACTIVE_UPLOADS) throw new CaptureHttpError("Too many audio capture uploads", 429);
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) throw new CaptureHttpError("Invalid Content-Length", 400);
    if (declaredBytes !== undefined && declaredBytes > MAX_CAPTURE_BYTES) throw new CaptureHttpError("Audio capture is too large", 413);
    if (declaredBytes !== undefined && this.activeBytes + declaredBytes > MAX_ACTIVE_UPLOAD_BYTES) throw new CaptureHttpError("Audio capture upload quota exceeded", 429);
    this.activeUploads += 1;
    this.activeBytes += declaredBytes || 0;
    let accounted = declaredBytes || 0;
    let received = 0;
    let released = false;
    return {
      add: (bytes: number) => {
        if (released) return;
        received += bytes;
        const additional = Math.max(0, received - accounted);
        if (!additional) return;
        if (this.activeBytes + additional > MAX_ACTIVE_UPLOAD_BYTES) throw new CaptureHttpError("Audio capture upload quota exceeded", 429);
        this.activeBytes += additional;
        accounted += additional;
      },
      release: () => {
        if (released) return;
        released = true;
        this.activeUploads -= 1;
        this.activeBytes -= accounted;
      },
    };
  }
}

export class EphemeralCaptureStore {
  private readonly captures = new Map<string, StoredCapture>();
  private rootPromise?: Promise<string>;
  /** Includes both writes in flight and completed captures. */
  private pendingCount = 0;
  private pendingBytes = 0;

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  private root() {
    return this.rootPromise ??= mkdtemp(join(tmpdir(), "pi-web-captures-"));
  }

  private releaseReservation(bytes: number) {
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
  }

  async store(input: {
    sessionId: string;
    contributionKey: string;
    registrationId: string;
    mimeType: string;
    durationMs: number;
    bytes: Uint8Array;
    policy: AudioCapturePolicy;
  }) {
    const { policy } = input;
    if (!input.bytes.byteLength) throw new CaptureHttpError("Audio capture is empty", 400);
    if (input.bytes.byteLength > policy.maxBytes || input.bytes.byteLength > MAX_CAPTURE_BYTES) throw new CaptureHttpError("Audio capture is too large", 413);
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > policy.maxSeconds * 1000) throw new CaptureHttpError("Audio capture duration is invalid", 400);
    const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (!mimeType.startsWith("audio/")) throw new CaptureHttpError("Audio capture MIME type is invalid", 400);
    if (policy.mimeTypes?.length && !policy.mimeTypes.includes(mimeType)) throw new CaptureHttpError("Audio capture MIME type is not accepted", 400);

    // Reserve synchronously before the first await so parallel stores cannot all
    // observe the same pre-write counters.
    if (this.pendingCount >= MAX_PENDING_CAPTURES || this.pendingBytes + input.bytes.byteLength > MAX_PENDING_BYTES) {
      throw new CaptureHttpError("Audio capture temporary quota exceeded", 429);
    }
    this.pendingCount += 1;
    this.pendingBytes += input.bytes.byteLength;

    const id = randomUUID();
    let dir: string | undefined;
    try {
      dir = join(await this.root(), id);
      const path = join(dir, "capture");
      await mkdir(dir, { recursive: false, mode: 0o700 });
      await writeFile(path, input.bytes, { flag: "wx", mode: 0o600 });
      const expiresAt = Date.now() + this.ttlMs;
      const timer = setTimeout(() => { void this.delete(id); }, this.ttlMs);
      timer.unref?.();
      this.captures.set(id, {
        id, path, mimeType, size: input.bytes.byteLength, durationMs: Math.round(input.durationMs),
        sessionId: input.sessionId, contributionKey: input.contributionKey, registrationId: input.registrationId,
        expiresAt, timer,
      });
      return { id, expiresAt };
    } catch (error) {
      this.releaseReservation(input.bytes.byteLength);
      if (dir) await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async consume(
    id: string,
    owner: { sessionId: string; contributionKey: string; registrationId: string },
    policy: AudioCapturePolicy,
  ): Promise<ValidatedAudioCapture> {
    const capture = this.captures.get(id);
    if (!capture || capture.expiresAt <= Date.now()) {
      if (capture) await this.delete(id);
      throw new CaptureHttpError("Audio capture is unavailable or expired", 409);
    }
    if (capture.sessionId !== owner.sessionId || capture.contributionKey !== owner.contributionKey || capture.registrationId !== owner.registrationId) {
      throw new CaptureHttpError("Audio capture does not belong to this contribution registration", 409);
    }
    if (capture.size > policy.maxBytes || capture.durationMs > policy.maxSeconds * 1000 || (policy.mimeTypes?.length && !policy.mimeTypes.includes(capture.mimeType))) {
      await this.delete(id);
      throw new CaptureHttpError("Audio capture no longer satisfies the contribution policy", 409);
    }
    this.captures.delete(id);
    this.releaseReservation(capture.size);
    clearTimeout(capture.timer);
    return { path: capture.path, mimeType: capture.mimeType, size: capture.size, durationMs: capture.durationMs };
  }

  async releasePath(path: string) {
    await rm(dirname(path), { recursive: true, force: true });
  }

  async delete(id: string) {
    const capture = this.captures.get(id);
    if (!capture) return;
    this.captures.delete(id);
    this.releaseReservation(capture.size);
    clearTimeout(capture.timer);
    await this.releasePath(capture.path);
  }

  async releaseOwner(sessionId: string) {
    await Promise.all([...this.captures.values()].filter((capture) => capture.sessionId === sessionId).map((capture) => this.delete(capture.id)));
  }

  async dispose() {
    await Promise.all([...this.captures.keys()].map((id) => this.delete(id)));
    if (this.rootPromise) await rm(await this.rootPromise, { recursive: true, force: true });
    this.rootPromise = undefined;
    this.pendingCount = 0;
    this.pendingBytes = 0;
  }
}
