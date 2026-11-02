import { access, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureUploadLimiter, EphemeralCaptureStore } from "../server/extensions/captureStore.js";
import { HttpError } from "../server/shared/httpError.js";
import { capturedTextInsertion } from "../src/composer/composerCapture.js";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdtemp: vi.fn(),
  actualAccess: undefined as typeof import("node:fs/promises").access | undefined,
  actualMkdtemp: undefined as typeof import("node:fs/promises").mkdtemp | undefined,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.actualAccess = actual.access;
  fsMocks.actualMkdtemp = actual.mkdtemp;
  fsMocks.access.mockImplementation(actual.access);
  fsMocks.mkdtemp.mockImplementation(actual.mkdtemp);
  return { ...actual, access: fsMocks.access, mkdtemp: fsMocks.mkdtemp };
});

const policy = { media: "audio" as const, maxSeconds: 120, maxBytes: 1024, mimeTypes: ["audio/webm"] };
const owner = { sessionId: "session-a", contributionKey: "voice.input", registrationId: "registration-a" };
const storedInput = (overrides: Record<string, unknown> = {}) => ({
  ...owner, mimeType: "audio/webm", durationMs: 250, bytes: new Uint8Array([1, 2, 3]), policy, ...overrides,
});

describe("ephemeral composer captures", () => {
  beforeEach(() => {
    fsMocks.access.mockReset();
    fsMocks.mkdtemp.mockReset();
    fsMocks.access.mockImplementation(fsMocks.actualAccess!);
    fsMocks.mkdtemp.mockImplementation(fsMocks.actualMkdtemp!);
  });

  it("propagates a capture-root creation failure and retries on the next call", async () => {
    const store = new EphemeralCaptureStore(10_000);
    fsMocks.mkdtemp.mockRejectedValueOnce(new Error("synthetic mkdtemp failure"));

    await expect(store.store(storedInput())).rejects.toThrow("synthetic mkdtemp failure");
    const { id } = await store.store(storedInput());
    const capture = await store.consume(id, owner, policy);
    await store.releasePath(capture.path);
    await store.dispose();
  });

  it("reuses one replacement root during concurrent removed-root recovery", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const first = await store.store(storedInput());
    const firstCapture = await store.consume(first.id, owner, policy);
    const staleRoot = dirname(dirname(firstCapture.path));
    await rm(staleRoot, { recursive: true, force: true });

    let staleChecks = 0;
    let releaseStaleChecks!: () => void;
    let markReplacementCreated!: () => void;
    const bothStaleChecksStarted = new Promise<void>((resolve) => { releaseStaleChecks = resolve; });
    const replacementCreated = new Promise<void>((resolve) => { markReplacementCreated = resolve; });
    fsMocks.access.mockImplementation(async (path) => {
      if (path !== staleRoot) return fsMocks.actualAccess!(path);
      const check = ++staleChecks;
      if (check === 2) releaseStaleChecks();
      await bothStaleChecksStarted;
      if (check === 2) await replacementCreated;
      throw Object.assign(new Error("removed"), { code: "ENOENT" });
    });
    fsMocks.mkdtemp.mockImplementation(async (prefix, options) => {
      const root = await fsMocks.actualMkdtemp!(prefix, options as never);
      markReplacementCreated();
      return root;
    });
    fsMocks.mkdtemp.mockClear();

    const [second, third] = await Promise.all([
      store.store(storedInput({ contributionKey: "voice.second" })),
      store.store(storedInput({ contributionKey: "voice.third" })),
    ]);
    const [secondCapture, thirdCapture] = await Promise.all([
      store.consume(second.id, { ...owner, contributionKey: "voice.second" }, policy),
      store.consume(third.id, { ...owner, contributionKey: "voice.third" }, policy),
    ]);
    expect(dirname(dirname(secondCapture.path))).toBe(dirname(dirname(thirdCapture.path)));
    expect(fsMocks.mkdtemp).toHaveBeenCalledTimes(1);
    await Promise.all([store.releasePath(secondCapture.path), store.releasePath(thirdCapture.path)]);
    await store.dispose();
  });

  it("propagates non-ENOENT capture-root access errors without retrying", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const first = await store.store(storedInput());
    const firstCapture = await store.consume(first.id, owner, policy);
    const root = dirname(dirname(firstCapture.path));
    await store.releasePath(firstCapture.path);

    fsMocks.access.mockImplementation(async (path) => {
      if (path === root) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return fsMocks.actualAccess!(path);
    });
    fsMocks.mkdtemp.mockClear();

    await expect(store.store(storedInput())).rejects.toMatchObject({ code: "EACCES" });
    expect(fsMocks.mkdtemp).not.toHaveBeenCalled();
    await store.dispose();
  });

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
    expect(rejected.every((result) => result.reason instanceof HttpError && result.reason.status === 429)).toBe(true);
    await store.dispose();
  });

  it("keeps claimed captures in quota until their paths are released", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const claimed = [];
    for (let index = 0; index < 32; index += 1) {
      const stored = await store.store(storedInput({ contributionKey: `voice.${index}`, bytes: new Uint8Array([index]) }));
      claimed.push(await store.consume(stored.id, { ...owner, contributionKey: `voice.${index}` }, policy));
    }

    await expect(store.store(storedInput({ contributionKey: "voice.over-quota" }))).rejects.toMatchObject({ status: 429 });
    await Promise.all(claimed.map((capture) => store.releasePath(capture.path)));
    const replacement = await store.store(storedInput({ contributionKey: "voice.replacement" }));
    const replacementCapture = await store.consume(replacement.id, { ...owner, contributionKey: "voice.replacement" }, policy);
    await store.releasePath(replacementCapture.path);
    await store.dispose();
  });

  it("expires claimed capture files and makes cleanup idempotent", async () => {
    const store = new EphemeralCaptureStore(10_000);
    vi.useFakeTimers();
    try {
      const { id } = await store.store(storedInput());
      const capture = await store.consume(id, owner, policy);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        await expect(access(capture.path)).rejects.toThrow();
      }, { timeout: 1_000, interval: 10 });
      await store.releasePath(capture.path);
      await store.releasePath(capture.path);
      await store.delete(id);
      await store.dispose();
    } finally {
      vi.useRealTimers();
      await store.dispose();
    }
  });

  it("accepts canonical audio types and codec parameters allowed by policy", async () => {
    const store = new EphemeralCaptureStore(10_000);
    const mimeTypes = [
      "audio/webm;codecs=opus",
      "audio/ogg; codecs=opus",
      "audio/mp4; codecs=\"mp4a.40.2\"",
      "audio/wav",
      "audio/mpeg",
      "audio/flac",
      "audio/aac",
    ];

    for (const [index, mimeType] of mimeTypes.entries()) {
      const normalizedMimeType = mimeType.split(";", 1)[0]!;
      const allowedPolicy = { ...policy, mimeTypes: [normalizedMimeType] };
      const stored = await store.store(storedInput({
        contributionKey: `voice.mime-${index}`,
        mimeType,
        policy: allowedPolicy,
      }));
      const capture = await store.consume(stored.id, {
        ...owner,
        contributionKey: `voice.mime-${index}`,
      }, allowedPolicy);
      expect(capture.mimeType).toBe(normalizedMimeType);
      await store.releasePath(capture.path);
    }
    await store.dispose();
  });

  it("rejects oversized, over-duration, and non-audio uploads", async () => {
    const store = new EphemeralCaptureStore();
    await expect(store.store(storedInput({ bytes: new Uint8Array(1025) }))).rejects.toMatchObject({ status: 413 });
    await expect(store.store(storedInput({ durationMs: 120_001 }))).rejects.toMatchObject({ status: 400 });
    await expect(store.store(storedInput({ mimeType: "text/plain" }))).rejects.toMatchObject({ status: 400 });
    await store.dispose();
  });

  it.each([
    "audio/",
    "audio/-flac",
    "audio/fl ac",
    "audio/fl@c",
    "audio//flac",
    `audio/${"a".repeat(128)}`,
    "audio/webm;\r\nx-injected: yes",
    "audio/webm\u0000",
  ])("rejects malformed Content-Type %j", async (mimeType) => {
    const store = new EphemeralCaptureStore();
    await expect(store.store(storedInput({
      mimeType,
      policy: { ...policy, mimeTypes: undefined },
    }))).rejects.toMatchObject({ status: 400 });
    await store.dispose();
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
