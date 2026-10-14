import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dictation, { DictationWorker, migrateDictationSettings } from "./index.js";
import { defaultModel, platformDefaults, resolveRuntime, validateCombination } from "./adapters/config.js";

const fakeWorker = String.raw`
import json, sys, time
for line in sys.stdin:
    message = json.loads(line)
    time.sleep(0.2)
    print(json.dumps({"id": message["id"], "ok": True, "text": "fake transcript", "model": "fake", "durationMs": 10, "decodeMs": 1, "inferenceMs": 1}), flush=True)
`;

describe("dictation contribution settings", () => {
  it("dispatches explicit Photon settings and defaults without falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictation-settings-test-"));
    const path = join(root, "capture.wav");
    await writeFile(path, "audio");
    const transcribe = vi.spyOn(DictationWorker.prototype, "transcribe").mockResolvedValue({ text: "photon" } as any);
    try {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      let contribution: any;
      const values = { family: "parakeet", runtime: "photon", model: "", device: "cpu" };
      const web = {
        capabilities: { slots: ["composer-input"], kinds: ["capture"] },
        contribute: (_key: string, value: unknown) => { contribution = value; },
        registerSettings: async () => {},
        getSettings: async () => ({ values }),
      };
      dictation({ on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any);
      await handlers.get("session_start")?.({}, { ui: { web, notify: () => {} } });
      const event = { capture: { path, mimeType: "audio/wav" } };
      await expect(contribution.invoke(event)).resolves.toMatchObject({ effects: [{ text: "photon" }] });
      expect(transcribe).toHaveBeenLastCalledWith(path, expect.objectContaining({ family: "parakeet", runtime: "photon", model: "moondream/parakeet-redux", device: "cpu" }));
      values.model = "custom/model";
      await contribution.invoke(event);
      expect(transcribe).toHaveBeenLastCalledWith(path, expect.objectContaining({ model: "custom/model" }));
      values.device = "cuda";
      await expect(contribution.invoke(event)).rejects.toThrow("CUDA is available only");
      values.family = "whisper";
      values.device = "cpu";
      await expect(contribution.invoke(event)).rejects.toThrow("Whisper does not support");
      expect(transcribe).toHaveBeenCalledTimes(2);
    } finally {
      transcribe.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-registers capture only when the capture maximum changes", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let settingsRegistration: any;
    const contributions: unknown[] = [];
    const web = {
      capabilities: { slots: ["composer-input"], kinds: ["capture"] },
      contribute: (_key: string, value: unknown) => contributions.push(value),
      registerSettings: async (registration: unknown) => { settingsRegistration = registration; },
      getSettings: async () => ({ values: { maxSeconds: 120 } }),
    };
    dictation({ on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any);
    await handlers.get("session_start")?.({}, { ui: { web, notify: () => {} } });
    expect(contributions).toHaveLength(1);
    expect(settingsRegistration.fields.find((field: any) => field.key === "runtime").options).toContainEqual({ value: "photon", label: "Photon (Parakeet CPU; telemetry blocked by audited shim)" });
    expect(settingsRegistration.fields.find((field: any) => field.key === "runtime").description).toContain("incompatible packages refuse inference");
    expect(settingsRegistration.fields.find((field: any) => field.key === "runtime").description).toContain("Model downloads still use the network");
    settingsRegistration.onChange({ maxSeconds: 120, model: "changed" });
    settingsRegistration.onChange({ maxSeconds: 120, pythonPath: "changed" });
    expect(contributions).toHaveLength(1);
    settingsRegistration.onChange({ maxSeconds: 60 });
    expect(contributions).toHaveLength(2);
  });
});

describe("Photon platform whitelist", () => {
  it.each<[NodeJS.Platform, NodeJS.Architecture]>([["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"], ["linux", "arm64"]])("accepts %s/%s", (hostPlatform, hostArch) => {
    expect(() => validateCombination("parakeet", "photon", hostPlatform, hostArch)).not.toThrow();
  });
  it.each<[NodeJS.Platform, NodeJS.Architecture]>([["darwin", "x64"], ["win32", "arm64"], ["linux", "ia32"], ["linux", "riscv64"], ["freebsd", "x64"]])("rejects %s/%s", (hostPlatform, hostArch) => {
    expect(() => validateCombination("parakeet", "photon", hostPlatform, hostArch)).toThrow("not configured");
  });
});

describe("DictationWorker lifecycle", () => {
  let root: string;
  let script: string;
  let workers: DictationWorker[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dictation-manager-test-"));
    script = join(root, "fake_worker.py");
    await writeFile(script, fakeWorker);
    workers = [];
  });

  afterEach(async () => {
    for (const worker of workers) worker.stop();
    await rm(root, { recursive: true, force: true });
  });

  function createWorker() {
    const worker = new DictationWorker({ workerScript: script, tempRoot: root });
    workers.push(worker);
    return worker;
  }

  const request = (worker: DictationWorker, signal?: AbortSignal, timeoutMs = 5_000) => worker.transcribe(join(root, "fake.webm"), {
    mimeType: "audio/webm",
    family: "whisper",
    runtime: "faster-whisper",
    model: "tiny",
    device: "cpu",
    computeType: "int8",
    pythonPath: process.platform === "win32" ? "python" : "python3",
    timeoutMs,
    signal,
  });

  it("reserves queue capacity across concurrent cold-start awaits", async () => {
    const worker = createWorker();
    const first = request(worker);
    const second = request(worker);
    const third = request(worker);
    await expect(request(worker)).rejects.toThrow("busy");
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);
  });

  it("does not miss cancellation while asynchronous setup is in progress", async () => {
    const worker = createWorker();
    const controller = new AbortController();
    const duringSetup = request(worker, controller.signal);
    // transcribe() has yielded to its first setup await but has not installed
    // the worker request listener yet.
    controller.abort();
    await expect(duringSetup).rejects.toThrow("cancelled");
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);
    await expect(request(worker)).resolves.toMatchObject({ text: "fake transcript" });
  });

  it("removes a cancelled queued request without interrupting the warm worker or its neighbors", async () => {
    const worker = createWorker();
    const queuedController = new AbortController();
    const first = request(worker);
    const cancelled = request(worker, queuedController.signal);
    const third = request(worker);
    queuedController.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(Promise.all([first, third])).resolves.toHaveLength(2);
  });

  it("keeps queued work after active cancellation", async () => {
    const worker = createWorker();
    const activeController = new AbortController();
    const active = request(worker, activeController.signal);
    const queued = request(worker);
    setTimeout(() => activeController.abort(), 40);
    await expect(active).rejects.toThrow("cancelled");
    await expect(queued).resolves.toMatchObject({ text: "fake transcript" });
  });

  it("starts a queued request timeout at dispatch rather than enqueue", async () => {
    // The peer records each received request and holds its response until released.
    // This keeps dispatch and response ordering independent of host scheduling.
    await writeFile(script, String.raw`
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
for number, line in enumerate(sys.stdin, 1):
    message = json.loads(line)
    (root / f"received-{number}").touch()
    while not (root / f"release-{number}").exists():
        time.sleep(0.01)
    print(json.dumps({"id": message["id"], "ok": True, "text": "fake transcript"}), flush=True)
`);
    const received = async (number: number) => {
      while (!(await readdir(root)).includes(`received-${number}`)) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    // Fake only deadline timers: filesystem, child-process I/O and Python remain real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const worker = new DictationWorker({ workerScript: script, tempRoot: root, killWindowsTree: async () => {} });
      workers.push(worker);
      const first = request(worker);
      const queued = request(worker, undefined, 300);
      const queuedResult = expect(queued).resolves.toMatchObject({ text: "fake transcript" });
      await received(1); // first dispatched and held; second is still queued
      await vi.advanceTimersByTimeAsync(300);
      await writeFile(join(root, "release-1"), "");
      await expect(first).resolves.toMatchObject({ text: "fake transcript" });
      await received(2); // second dispatched after the logical enqueue deadline
      await writeFile(join(root, "release-2"), "");
      await queuedResult;

      const timedOut = request(worker, undefined, 300);
      const rejection = expect(timedOut).rejects.toThrow("Dictation timed out");
      await received(3); // dispatched, but the peer cannot respond before the deadline
      await vi.advanceTimersByTimeAsync(300);
      // Cleanup may wait for child exit (and a Windows tree-kill hook); drive
      // its bounded fallback too rather than awaiting a frozen fake timer.
      await vi.advanceTimersByTimeAsync(2_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds unread worker protocol output", async () => {
    const noisyScript = join(root, "noisy_worker.py");
    await writeFile(noisyScript, 'import sys\nfor line in sys.stdin:\n print("x" * 1000001, flush=True)\n');
    const worker = new DictationWorker({ workerScript: noisyScript, tempRoot: root });
    workers.push(worker);
    await expect(request(worker)).rejects.toThrow("protocol buffer limit");
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);
  });

  it("migrates legacy MLX settings without changing explicit models", () => {
    expect(migrateDictationSettings({ backend: "whisper", model: "org/custom", maxSeconds: 42 })).toEqual({
      family: "whisper", runtime: "mlx", model: "org/custom", maxSeconds: 42,
    });
    expect(migrateDictationSettings({ backend: "parakeet", model: "local/model" })).toEqual({
      family: "parakeet", runtime: "mlx", model: "local/model",
    });
  });

  it("uses platform-appropriate automatic defaults and runtime models", () => {
    expect(platformDefaults("darwin", "arm64")).toEqual({ family: "parakeet", runtime: "auto" });
    expect(resolveRuntime("parakeet", "auto", "darwin", "arm64")).toBe("mlx");
    expect(defaultModel("parakeet", "mlx")).toBe("mlx-community/parakeet-tdt-0.6b-v3");
    expect(platformDefaults("linux", "x64").family).toBe("whisper");
    expect(platformDefaults("win32", "x64").family).toBe("whisper");
    expect(platformDefaults("darwin", "x64").family).toBe("whisper");
    expect(resolveRuntime("whisper", "auto", "win32", "x64")).toBe("faster-whisper");
    expect(defaultModel("whisper", "faster-whisper")).toBe("large-v3-turbo");
    expect(() => resolveRuntime("parakeet", "auto", "win32", "x64")).toThrow("no portable runtime");
    expect(() => validateCombination("whisper", "mlx", "linux", "x64")).toThrow("Apple Silicon");
    expect(() => validateCombination("parakeet", "faster-whisper", "win32", "x64")).toThrow("Parakeet only through MLX");
  });

  it("keeps Photon opt-in with a family-specific default and rejects Whisper/Photon", () => {
    expect(resolveRuntime("parakeet", "photon", "linux", "x64")).toBe("photon");
    expect(defaultModel("parakeet", "photon")).toBe("moondream/parakeet-redux");
    expect(() => validateCombination("parakeet", "photon", "linux", "x64")).not.toThrow();
    expect(() => validateCombination("whisper", "photon", "linux", "x64")).toThrow("Whisper does not support");
    expect(() => defaultModel("whisper", "photon")).toThrow("Unsupported");
    expect(() => validateCombination("parakeet", "photon", "freebsd", "x64")).toThrow("not configured");
    expect(() => resolveRuntime("parakeet", "auto", "linux", "x64")).toThrow("Select Photon explicitly");
  });

  it.each([
    ["throws synchronously", () => { throw new Error("tree kill threw"); }],
    ["rejects", async () => { throw new Error("tree kill rejected"); }],
    ["never settles", () => new Promise<void>(() => {})],
  ] as const)("bounds a Windows process-tree hook that %s and preserves cancellation cleanup", async (_label, killWindowsTree) => {
    const worker = new DictationWorker({
      workerScript: script,
      tempRoot: root,
      hostPlatform: "win32",
      killWindowsTree,
      windowsKillTimeoutMs: 50,
    });
    workers.push(worker);
    const controller = new AbortController();
    const cancelled = request(worker, controller.signal);
    setTimeout(() => controller.abort(), 40);
    await expect(cancelled).rejects.toThrow("cancelled");
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);
    // Direct child.kill() fallback must leave the worker restartable.
    await expect(request(worker)).resolves.toMatchObject({ text: "fake transcript" });
  });

  it("cancels the process group, cleans work directories, and restarts cleanly", async () => {
    const worker = createWorker();
    const controller = new AbortController();
    const cancelled = request(worker, controller.signal);
    setTimeout(() => controller.abort(), 40);
    await expect(cancelled).rejects.toThrow("cancelled");
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);

    await expect(request(worker)).resolves.toMatchObject({ text: "fake transcript" });
    // A late exit/data callback from the killed generation must not stop the new one.
    await expect(request(worker)).resolves.toMatchObject({ text: "fake transcript" });
    expect((await readdir(root)).filter((name) => name.startsWith("pi-dictation-"))).toEqual([]);
  });
});
