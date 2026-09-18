import { access, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CaptureHttpError, CaptureUploadLimiter, EphemeralCaptureStore } from "../server/extensions/captureStore.js";
import { capturedTextInsertion } from "../src/composer/composerCapture.js";

const policy = { media: "audio" as const, maxSeconds: 120, maxBytes: 1024, mimeTypes: ["audio/webm"] };
const owner = { sessionId: "session-a", contributionKey: "voice.input", registrationId: "registration-a" };
const storedInput = (overrides: Record<string, unknown> = {}) => ({
  ...owner, mimeType: "audio/webm", durationMs: 250, bytes: new Uint8Array([1, 2, 3]), policy, ...overrides,
});

describe("ephemeral composer captures", () => {
  it("binds a private temporary capture to one registration and invocation", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const { id } = await store.store(storedInput());
    await expect(store.consume(id, { ...owner, sessionId: "session-b" }, policy)).rejects.toThrow("does not belong");
    await expect(store.consume(id, { ...owner, registrationId: "replacement" }, policy)).rejects.toThrow("does not belong");
    const capture = await store.consume(id, owner, policy);
    expect(capture).toMatchObject({ mimeType: "audio/webm", size: 3, durationMs: 250 });
    expect((await stat(capture.path)).mode & 0o777).toBe(0o600);
    await expect(store.consume(id, owner, policy)).rejects.toThrow("unavailable or expired");
    await store.releasePath(capture.path);
    await expect(access(capture.path)).rejects.toThrow();

    const pending = await store.store(storedInput({ bytes: new Uint8Array([4]) }));
    await store.releaseOwner("session-a");
    await expect(store.consume(pending.id, owner, policy)).rejects.toThrow("unavailable");
    await store.dispose();
  });

  it("reserves quota before asynchronous writes", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
      store.store(storedInput({ contributionKey: `voice.${index}`, bytes: new Uint8Array([index]) })),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(32);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(8);
    expect(rejected.every((result) => result.reason instanceof CaptureHttpError && result.reason.status === 429)).toBe(true);
    await store.dispose();
  });

  it("rejects oversized, over-duration, and non-audio uploads with client statuses", async () => {
    const store = new EphemeralCaptureStore();
    await expect(store.store(storedInput({ bytes: new Uint8Array(1025) }))).rejects.toMatchObject({ status: 413 });
    await expect(store.store(storedInput({ durationMs: 120_001 }))).rejects.toMatchObject({ status: 400 });
    await expect(store.store(storedInput({ mimeType: "text/plain" }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("capture upload buffering", () => {
  it("bounds parallel active uploads and releases reservations", () => {
    const limiter = new CaptureUploadLimiter();
    const active = Array.from({ length: 4 }, () => limiter.begin(1));
    expect(() => limiter.begin(1)).toThrow(expect.objectContaining({ status: 429 }));
    active[0]?.release();
    const replacement = limiter.begin(1);
    replacement.release();
    active.slice(1).forEach((lease) => lease.release());
  });

  it("bounds aggregate chunked bytes", () => {
    const limiter = new CaptureUploadLimiter();
    const first = limiter.begin();
    first.add(49_000_000);
    const second = limiter.begin();
    expect(() => second.add(2_000_000)).toThrow(expect.objectContaining({ status: 429 }));
    first.release();
    second.release();
  });
});

describe("browser-scoped composer insertion", () => {
  const snapshot = { sessionId: "s1", revision: 4, selectionStart: 6, selectionEnd: 11 };
  const current = { sessionId: "s1", revision: 4, value: "hello world", selectionStart: 6, selectionEnd: 11 };

  it("replaces only the captured selection without sending", () => {
    expect(capturedTextInsertion({ text: "pi", placement: "selection", snapshot, current })).toEqual({ value: "hello pi", cursor: 8 });
  });

  it("ignores stale completion after edits, selection changes, or session switches", () => {
    expect(capturedTextInsertion({ text: "pi", placement: "selection", snapshot, current: { ...current, revision: 5 } })).toBeUndefined();
    expect(capturedTextInsertion({ text: "pi", placement: "selection", snapshot, current: { ...current, selectionEnd: 6 } })).toBeUndefined();
    expect(capturedTextInsertion({ text: "pi", placement: "selection", snapshot, current: { ...current, sessionId: "s2" } })).toBeUndefined();
  });
});
