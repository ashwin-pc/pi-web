import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { attachTranscription, beginTake, createProject, exportProject, finishTake, importSource, loadProject, newOperationDir, resolveFile, reviseProject } from "../../store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
async function cwd() { const p = await mkdtemp(join(tmpdir(), "wavy-test-")); roots.push(p); return p; }

function wav(): Buffer { return Buffer.from("RIFF0000WAVEfmt "); }

describe("Wavy native project storage", () => {
  it("creates an artifact-contained project with immutable snapshots", async () => {
    const root = await cwd();
    const first = await createProject(root, { path: "songs/demo.wavy", title: "Demo", lyrics: "hello", style: "soft" });
    expect(first.index.revision).toBe(1); expect(first.warnings).toContain("No score is attached.");
    const second = await reviseProject(root, "songs/demo.wavy", { expectedRevision: 1, summary: "add score", score: "X:1\nK:C\nC|", provenance: { planner: "raw", effective: { seed: 7 } } });
    expect(second.index.revision).toBe(2); expect(second.head.lyrics).toBe("hello"); expect(second.head.score).toContain("K:C");
    await expect(reviseProject(root, "songs/demo.wavy", { expectedRevision: 1, summary: "stale" })).rejects.toThrow("revision conflict");
    const old = first.index.revisions[0].files.lyrics;
    expect(await readFile(await resolveFile(second, old), "utf8")).toBe("hello");
    expect(second.index.revisions[1].provenance).toBeDefined();
  });

  it("detects direct edits, traversal references, and symlink escapes", async () => {
    const root = await cwd(); const project = await createProject(root, { path: "demo.wavy", title: "Demo" });
    const lyrics = await resolveFile(project, project.index.revisions[0].files.lyrics); await writeFile(lyrics, "tampered");
    await expect(loadProject(root, "demo.wavy")).rejects.toThrow("integrity mismatch");

    const clean = await createProject(root, { path: "other.wavy", title: "Other" });
    const index = JSON.parse(await readFile(clean.absolutePath, "utf8")); index.revisions[0].files.lyrics.path = "../outside"; await writeFile(clean.absolutePath, JSON.stringify(index));
    await expect(loadProject(root, "other.wavy")).rejects.toThrow("normalized relative path");

    const linked = await createProject(root, { path: "linked.wavy", title: "Linked" }); const ref = linked.index.revisions[0].files.style;
    await rm(await resolveFile(linked, ref)); await symlink("/etc/hosts", join(linked.absolutePath.slice(0, linked.absolutePath.lastIndexOf("/")), ref.path));
    await expect(loadProject(root, "linked.wavy")).rejects.toThrow("symlinks");
  });

  it("imports source, attaches transcription, and records take lifecycle without bumping revision", async () => {
    const root = await cwd(); const audio = join(root, "input.wav"); await writeFile(audio, wav());
    let project = await createProject(root, { path: "demo.wavy", title: "Demo", score: "X:1\nK:C\nC|" });
    project = await importSource(root, "demo.wavy", { sourcePath: audio, label: "hum" });
    project = await attachTranscription(root, "demo.wavy", project.index.sources[0].id, { events: [{ t: 0 }], score: "X:1\nK:C\nD|" });
    const started = await beginTake(root, "demo.wavy", { revision: 1, seed: 42, precision: "bf16", request: { model: "test" } });
    expect(started.outputDir).toContain(`${started.take.id}/run`); expect(started.take.request.path).toContain("/receipts/request.json");
    project = await finishTake(root, "demo.wavy", started.take.id, { status: "failed", error: "expected test failure", elapsedSeconds: 1 });
    expect(project.index.revision).toBe(1); expect(project.index.takes[0].status).toBe("failed"); expect(project.index.takes[0].audio).toBeUndefined();
  });

  it("creates safe operation receipt directories and exports retained jobs", async () => {
    const root = await cwd(); const project = await createProject(root, { path: "nested/demo.wavy", title: "Demo" });
    const operation = await newOperationDir(root, "nested/demo.wavy", "compose"); await writeFile(join(operation, "engine.log"), "retained failure log");
    expect(relative(`${project.absolutePath}.d`, operation).startsWith("jobs/compose/")).toBe(true);
    const archive = await exportProject(root, "nested/demo.wavy"); expect(archive.artifactPath).toMatch(/^\/api\/artifacts\//); expect((await readFile(archive.path)).length).toBeGreaterThan(0);
  });

  it("rejects projects outside artifacts and oversized or unsupported imports", async () => {
    const root = await cwd(); await expect(createProject(root, { path: "../escape.wavy", title: "x" })).rejects.toThrow("escapes artifacts");
    const project = await createProject(root, { path: "demo.wavy", title: "Demo" });
    const bad = join(root, "bad.txt"); await writeFile(bad, "not audio"); await expect(importSource(root, "demo.wavy", { sourcePath: bad })).rejects.toThrow("unsupported source");
    expect(project.absolutePath).toContain(".pi/web/artifacts");
  });

  it("accepts safe artifact URLs and partial settings but rejects encoded traversal and unknown settings", async () => {
    const root = await cwd(); await createProject(root, { path: "space song/demo.wavy", title: "Demo", settings: { precision: "4bit" } });
    const loaded = await loadProject(root, "/api/artifacts/space%20song/demo.wavy"); expect(loaded.head.settings.precision).toBe("4bit"); expect(loaded.head.settings.planning).toBe("full");
    const scoped = await loadProject(root, "/api/session-artifacts/session-123/space%20song/demo.wavy"); expect(scoped.absolutePath).toBe(loaded.absolutePath);
    await expect(loadProject(root, "/api/artifacts/%2e%2e/demo.wavy")).rejects.toThrow("unsafe path");
    await expect(loadProject(root, "/api/session-artifacts/session-123/%2e%2e/demo.wavy")).rejects.toThrow("unsafe path");
    await expect(createProject(root, { path: "bad.wavy", title: "Bad", settings: { surprise: 1 } as never })).rejects.toThrow("Unsupported Wavy setting");
  });

  it("prevalidates multi-file mutations so a failed attempt can be retried", async () => {
    const root = await cwd(); const audio = join(root, "input.wav"); await writeFile(audio, wav()); let project = await createProject(root, { path: "demo.wavy", title: "Demo" }); project = await importSource(root, "demo.wavy", { sourcePath: audio }); const sourceId = project.index.sources[0].id;
    await expect(attachTranscription(root, "demo.wavy", sourceId, { events: { ok: true }, score: "x".repeat(2_000_001) })).rejects.toThrow("score exceeds");
    project = await attachTranscription(root, "demo.wavy", sourceId, { events: { ok: true }, score: "X:1\nK:C\nC|" }); expect(project.index.sources[0].score).toBeDefined();
    await expect(reviseProject(root, "demo.wavy", { expectedRevision: 1, summary: "bad", score: "x".repeat(2_000_001) })).rejects.toThrow("score exceeds");
    project = await reviseProject(root, "demo.wavy", { expectedRevision: 1, summary: "retry", score: "X:1\nK:C\nD|" }); expect(project.index.revision).toBe(2);
  });

  it("rejects forged IDs and never removes pre-existing revision destinations", async () => {
    const root = await cwd(); const project = await createProject(root, { path: "demo.wavy", title: "Demo" }); const occupied = join(`${project.absolutePath}.d`, "revisions/000002"); await mkdir(occupied); await writeFile(join(occupied, "sentinel"), "keep");
    await expect(reviseProject(root, "demo.wavy", { expectedRevision: 1, summary: "blocked" })).rejects.toThrow("destination already exists"); expect(await readFile(join(occupied, "sentinel"), "utf8")).toBe("keep");
    const raw = JSON.parse(await readFile(project.absolutePath, "utf8")); raw.sources.push({ id: "../../escape", label: "bad", createdAt: new Date().toISOString(), audio: raw.revisions[0].files.lyrics }); await writeFile(project.absolutePath, JSON.stringify(raw)); await expect(loadProject(root, "demo.wavy")).rejects.toThrow("must be a UUID");
  });

  it("checks job ancestors before mkdir and cannot follow a jobs symlink", async () => {
    const root = await cwd(); const project = await createProject(root, { path: "demo.wavy", title: "Demo" }); const outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(`${project.absolutePath}.d`, "jobs")); await expect(newOperationDir(root, "demo.wavy", "compose")).rejects.toThrow("symlinks"); expect(await (await import("node:fs/promises")).readdir(outside)).toEqual([]);
  });

  it("failed finish validation leaves the take retryable and receipts unpoisoned", async () => {
    const root = await cwd(); const audio = join(root, "out.wav"); await writeFile(audio, wav()); await createProject(root, { path: "demo.wavy", title: "Demo" }); const started = await beginTake(root, "demo.wavy", { revision: 1, seed: 2, precision: "bf16", request: {} });
    await expect(finishTake(root, "demo.wavy", started.take.id, { status: "complete", result: { premature: true }, durationSeconds: -1 })).rejects.toThrow("durationSeconds");
    let loaded = await loadProject(root, "demo.wavy"); expect(loaded.index.takes[0].status).toBe("running"); expect(loaded.index.takes[0].result).toBeUndefined();
    loaded = await finishTake(root, "demo.wavy", started.take.id, { status: "complete", result: { ok: true }, audioPath: audio }); expect(loaded.index.takes[0].status).toBe("complete");
  });

  it("keeps request receipt isolated and deduplicates identical WAV output", async () => {
    const root = await cwd(); const audio = join(root, "out.wav"); await writeFile(audio, wav()); await createProject(root, { path: "demo.wavy", title: "Demo" });
    const started = await beginTake(root, "demo.wavy", { revision: 1, seed: 1, precision: "bf16", request: { x: 1 } }); await writeFile(join(started.outputDir, "request.json"), "engine scratch");
    const done = await finishTake(root, "demo.wavy", started.take.id, { status: "complete", audioPath: audio, wavPath: audio }); expect(done.index.takes[0].audio).toEqual(done.index.takes[0].wav); expect(await readFile(await resolveFile(done, done.index.takes[0].request), "utf8")).toContain('"x"');
  });
});
