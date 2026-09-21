import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engines = vi.hoisted(() => ({
  status: vi.fn(),
  plan: vi.fn(),
  render: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("../examples/pi-web-extensions/wavy/engines.js", () => ({
  engineStatus: engines.status,
  planComposition: engines.plan,
  renderComposition: engines.render,
  transcribeSource: engines.transcribe,
}));

import wavy from "../examples/pi-web-extensions/wavy/index.js";
import { loadProject } from "../examples/pi-web-extensions/wavy/store.js";

type Tool = { name: string; execute: (...args: any[]) => Promise<any> };
type Handler = (...args: any[]) => any;

function harness(cwd: string) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const contributions: Array<[string, any]> = [];
  const pi = {
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  wavy(pi as any);
  const web = {
    capabilities: { slots: ["artifact-preview"], kinds: ["rendered"] },
    contribute: vi.fn((key: string, spec: any) => contributions.push([key, spec])),
  };
  const ctx = { cwd, ui: { web, notify: vi.fn() } };
  const call = (name: string, params: any, signal?: AbortSignal) =>
    tools.get(name)!.execute("call", params, signal, undefined, ctx);
  const emit = async (name: string, event: any = {}) => {
    const values = [];
    for (const handler of handlers.get(name) ?? []) values.push(await handler(event, ctx));
    return values;
  };
  return { tools, handlers, contributions, web, ctx, call, emit };
}

function tinyWav(): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0); b.writeUInt32LE(36, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(0, 40);
  return b;
}

const dirs: string[] = [];
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "wavy-entry-")); dirs.push(cwd);
  engines.status.mockReset().mockResolvedValue({ yue: { available: false }, sheetsage: { available: false } });
  engines.plan.mockReset(); engines.render.mockReset(); engines.transcribe.mockReset();
});
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function create(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  return h.call("wavy", { action: "create", path: "songs/demo.wavy", title: "Demo [song]", lyrics: "la", style: "folk", ...extra });
}

async function finishFiles(outputDir: string, seed: number) {
  // Deliberately use engine-native request/result names in run/. Store receipts must remain separate.
  await writeFile(join(outputDir, "request.json"), JSON.stringify({ engine: true, seed }));
  await writeFile(join(outputDir, "result.json"), JSON.stringify({ engineResult: seed }));
  const audioPath = join(outputDir, `take-${seed}.wav`);
  await writeFile(audioPath, tinyWav());
  return audioPath;
}

describe("Wavy extension entrypoint", () => {
  it("registers only Wavy tools/events and discovers its bundled skill", async () => {
    const h = harness(cwd);
    expect([...h.tools.keys()]).toEqual(["wavy", "wavy_status", "wavy_compose", "wavy_render", "wavy_transcribe"]);
    expect(h.handlers.has("resources_discover")).toBe(true);
    expect(h.handlers.has("session_start")).toBe(true);
    expect(h.handlers.has("session_shutdown")).toBe(true);
    expect([...h.handlers.keys()].some(x => /invalidation|handoff/i.test(x))).toBe(false);
    const [resources] = await h.emit("resources_discover");
    expect(resources.skillPaths).toHaveLength(1);
    expect(resources.skillPaths[0]).toMatch(/wavy\/skill\/SKILL\.md$/);
  });

  it("creates, inspects, and partially revises settings through the real store", async () => {
    const h = harness(cwd);
    const made = await create(h, { score: "X:1\nK:C\nC", settings: { precision: "4bit", temperature: 0.8 } });
    expect(made.details).toEqual({ path: "/api/artifacts/songs/demo.wavy", revision: 1 });
    const inspected = await h.call("wavy", { action: "inspect", path: made.details.path });
    expect(inspected.content[0].text).toContain('"precision": "4bit"');
    expect(inspected.content[0].text).toContain('"temperature": 0.8');
    await h.call("wavy", { action: "revise", path: made.details.path, expected_revision: 1, summary: "lower temp", settings: { temperature: 0.4 } });
    const project = await loadProject(cwd, "songs/demo.wavy");
    expect(project.head.settings).toMatchObject({ precision: "4bit", planning: "full", temperature: 0.4 });
    await expect(h.call("wavy", { action: "revise", path: made.details.path, expected_revision: 1, summary: "stale" })).rejects.toThrow(/revision conflict/i);
  });

  it("renders artifact previews from /api/artifacts paths and emits native media fallback links", async () => {
    const h = harness(cwd); await create(h, { score: "X:1\nK:C\nC" });
    await h.emit("session_start");
    const spec = h.contributions.at(-1)![1];
    const preview = await spec.render({ context: { path: "/api/artifacts/songs/demo.wavy", name: "demo.wavy", kind: "file" } });
    const scopedPreview = await spec.render({ context: { path: "/api/session-artifacts/session-123/songs/demo.wavy", name: "demo.wavy", kind: "file" } });
    expect(scopedPreview.html).toContain("Wavy preview");
    expect(preview.html).toContain("Wavy preview");
    const encoded = preview.html.match(/data-wavy="([^"]+)"/)![1];
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).title).toBe("Demo [song]");

    engines.render.mockImplementation(async ({ outputDir, seed }: any) => ({
      audioPath: await finishFiles(outputDir, seed), result: { seed }, durationSeconds: 1,
    }));
    const rendered = await h.call("wavy_render", { path: "songs/demo.wavy", expected_revision: 1, seed: 9 });
    expect(rendered.details.audio).toMatch(/^\/api\/artifacts\/songs\/demo\.wavy\.d\/takes\/[^/]+\/audio\.wav$/);
    expect(rendered.content[0].text).toContain(`[Listen to `);
    expect(rendered.content[0].text).toContain(`](${rendered.details.audio})`);
  });

  it("revalidates score review snapshots and returns a deterministic frozen artifact proposal", async () => {
    const h = harness(cwd); await create(h, { score: "X:1\nK:C\nC D|" }); await h.emit("session_start");
    const spec = h.contributions.at(-1)![1];
    const project = await loadProject(cwd, "songs/demo.wavy");
    const scoreRef = project.index.revisions.at(-1)!.files.score!;
    const start = project.head.score!.lastIndexOf("C D");
    const event = { action: "review-score-edit", context: { path: "/api/session-artifacts/session-123/songs/demo.wavy", name: "demo.wavy", kind: "file" }, payload: {
      snapshot: { compositionRevision: 1, scoreSha256: scoreRef.sha256 }, path: project.artifactPath,
      selection: { kind: "abc-source-ranges", unit: "utf16", label: "Bar 1", ranges: [{ start, end: start + 3, voiceId: "voice-1", excerpt: "C D" }], playback: { startMs: 0, endMs: 1000, repeatPasses: [1] } },
      comment: "Make this gentler",
    } };
    const first = await spec.interactions.invoke(event); const second = await spec.interactions.invoke(event);
    expect(second).toEqual(first);
    expect(first.status).toBe("review");
    expect(first.review.effects[0].text).toContain("Composition revision: 1");
    expect(first.review.effects[0].text).toContain(project.artifactPath);
    expect(first.review.effects[1].context.reference).toMatchObject({ provider: "artifact", sha256: scoreRef.sha256, ranges: [{ start, end: start + 3, unit: "utf16", label: "voice-1" }] });
    await h.call("wavy", { action: "revise", path: project.artifactPath, expected_revision: 1, summary: "advance", score: "X:1\nK:C\nE|" });
    await expect(spec.interactions.invoke(event)).resolves.toMatchObject({ status: "stale" });
  });

  it("commits compose only at the captured revision and preserves the raw planning receipt", async () => {
    const h = harness(cwd); await create(h);
    let release!: () => void;
    engines.plan.mockImplementation(async ({ outputDir }: any) => {
      await new Promise<void>(resolve => { release = resolve; });
      const rawPlanPath = join(outputDir, "raw-plan.txt");
      await writeFile(rawPlanPath, "RAW COT RECEIPT");
      return { score: "X:1\nK:C\nC", rawPlanPath, result: { ok: true } };
    });
    const composing = h.call("wavy_compose", { path: "songs/demo.wavy", expected_revision: 1, seed: 7 });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await h.call("wavy", { action: "revise", path: "songs/demo.wavy", expected_revision: 1, summary: "human edit", lyrics: "new" });
    release();
    await expect(composing).rejects.toThrow(/revision conflict/i);
    expect((await loadProject(cwd, "songs/demo.wavy")).index.revision).toBe(2);

    // A non-racing composition stores exact raw engine output in provenance.
    engines.plan.mockImplementation(async ({ outputDir }: any) => {
      const rawPlanPath = join(outputDir, "raw-plan.txt"); await writeFile(rawPlanPath, "RAW COT RECEIPT");
      return { score: "X:1\nK:C\nD", rawPlanPath, result: { ok: true } };
    });
    await h.call("wavy_compose", { path: "songs/demo.wavy", expected_revision: 2, seed: 8 });
    const p = await loadProject(cwd, "songs/demo.wavy");
    const provenance = p.index.revisions.at(-1)!.provenance!;
    expect(await readFile(join(cwd, ".pi/web/artifacts/songs", provenance.path), "utf8")).toContain('"rawPlan": "RAW COT RECEIPT"');
  });

  it("captures one immutable revision/request while rendering sequential seeds, despite engine run receipts", async () => {
    const h = harness(cwd); await create(h, { score: "X:1\nK:C\nC" });
    const inputs: any[] = [];
    engines.render.mockImplementation(async (input: any) => {
      inputs.push(structuredClone({ ...input, outputDir: undefined }));
      return { audioPath: await finishFiles(input.outputDir, input.seed), result: { seed: input.seed } };
    });
    await h.call("wavy_render", { path: "songs/demo.wavy", expected_revision: 1, seed: 41, count: 3 });
    expect(inputs.map(x => x.seed)).toEqual([41, 42, 43]);
    expect(inputs.every(x => x.score === "X:1\nK:C\nC" && x.lyrics === "la")).toBe(true);
    const p = await loadProject(cwd, "songs/demo.wavy");
    expect(p.index.takes.map(t => [t.revision, t.seed, t.status])).toEqual([[1, 41, "complete"], [1, 42, "complete"], [1, 43, "complete"]]);
    const selected = await h.call("wavy", { action: "inspect", path: "songs/demo.wavy", take_id: p.index.takes[0].id });
    expect(selected.details.audio).toContain(p.index.takes[0].id);
    const newest = await h.call("wavy", { action: "inspect", path: "songs/demo.wavy" });
    expect(newest.details.audio).toContain(p.index.takes[2].id);
    await expect(h.call("wavy", { action: "inspect", path: "songs/demo.wavy", take_id: "missing" })).rejects.toThrow(/Selected take/);
    for (const take of p.index.takes) {
      const request = JSON.parse(await readFile(join(cwd, ".pi/web/artifacts/songs", take.request.path), "utf8"));
      expect(request).toMatchObject({ operation: "render", revision: 1, seed: take.seed, lyrics: "la", score: "X:1\nK:C\nC" });
      expect(take.result).toBeDefined();
    }
  });

  it("marks failed/cancelled takes without losing older complete outputs", async () => {
    const h = harness(cwd); await create(h, { score: "X:1\nK:C\nC" });
    engines.render.mockImplementationOnce(async (input: any) => ({ audioPath: await finishFiles(input.outputDir, input.seed), result: { ok: true } }));
    await h.call("wavy_render", { path: "songs/demo.wavy", expected_revision: 1, seed: 1 });
    engines.render.mockRejectedValueOnce(new Error("boom"));
    await expect(h.call("wavy_render", { path: "songs/demo.wavy", expected_revision: 1, seed: 2 })).rejects.toThrow(/failed.*boom/i);
    const controller = new AbortController();
    engines.render.mockImplementationOnce(async (_input: any, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const pending = h.call("wavy_render", { path: "songs/demo.wavy", expected_revision: 1, seed: 3 }, controller.signal);
    await vi.waitFor(() => expect(engines.render).toHaveBeenCalledTimes(3)); controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow(/cancelled/i);
    const p = await loadProject(cwd, "songs/demo.wavy");
    expect(p.index.takes.map(t => t.status)).toEqual(["complete", "failed", "cancelled"]);
    expect(p.index.takes[0].audio).toBeDefined();
  });

  it("attaches transcription without changing composition, and applies score only with revision guard", async () => {
    const h = harness(cwd); await create(h);
    const wav = join(cwd, "source.wav"); await writeFile(wav, tinyWav());
    await h.call("wavy", { action: "source", path: "songs/demo.wavy", source_path: wav, source_label: "hum" });
    let p = await loadProject(cwd, "songs/demo.wavy"); const sourceId = p.index.sources[0].id;
    engines.transcribe.mockResolvedValue({ score: "X:1\nK:C\nE", events: [{ t: 0 }], result: { model: "mock" } });
    await h.call("wavy_transcribe", { path: "songs/demo.wavy", source_id: sourceId });
    p = await loadProject(cwd, "songs/demo.wavy");
    expect(p.index.revision).toBe(1); expect(p.head.score).toBeUndefined(); expect(p.index.sources[0].score).toBeDefined();

    // Use a second source because transcription attachment is intentionally one-shot.
    await h.call("wavy", { action: "source", path: "songs/demo.wavy", source_path: wav, source_label: "hum 2" });
    p = await loadProject(cwd, "songs/demo.wavy"); const source2 = p.index.sources[1].id;
    await expect(h.call("wavy_transcribe", { path: "songs/demo.wavy", source_id: source2, apply_score: true, expected_revision: 99 })).rejects.toThrow(/Composition changed/i);
    await h.call("wavy_transcribe", { path: "songs/demo.wavy", source_id: source2, apply_score: true, expected_revision: 1 });
    p = await loadProject(cwd, "songs/demo.wavy"); expect(p.index.revision).toBe(2); expect(p.head.score).toContain("E");
  });

  it("aborts in-flight work, waits for cleanup, and removes preview on shutdown", async () => {
    const h = harness(cwd); await create(h);
    await h.emit("session_start");
    let cleaned = false;
    engines.plan.mockImplementation(async ({ outputDir }: any, signal: AbortSignal) => {
      await mkdir(outputDir, { recursive: true });
      try { await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      finally { cleaned = true; }
    });
    const pending = h.call("wavy_compose", { path: "songs/demo.wavy", expected_revision: 1, seed: 4 });
    await vi.waitFor(() => expect(engines.plan).toHaveBeenCalled());
    await h.emit("session_shutdown", { reason: "reload" });
    await expect(pending).rejects.toThrow(/session closed or reloaded/i);
    expect(cleaned).toBe(true);
    expect(h.web.contribute).toHaveBeenLastCalledWith("wavy.preview", undefined);
  });
});
