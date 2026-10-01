import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { CompositionFiles, FileRef, LoadedProject, WavyIndex, WavyRevision, WavySettings, WavySource, WavyTake } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import { validateSettings } from "./settings.js";

const execFileAsync = promisify(execFile);
const MAX_INDEX = 1_000_000;
const MAX_TEXT = 2_000_000;
const MAX_JSON = 4_000_000;
const MAX_AUDIO = 256 * 1024 * 1024;
const MAX_REFS = 10_000;
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".opus", ".ogg", ".m4a", ".aac", ".webm"]);
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type JsonRecord = Record<string, unknown>;

function fail(message: string): never { throw new Error(`Invalid Wavy project: ${message}`); }
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (POLLUTION_KEYS.has(key)) fail(`${label} contains forbidden key ${key}`);
  return value as JsonRecord;
}
function exactKeys(value: JsonRecord, allowed: readonly string[], label: string): void { const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) fail(`${label} contains unknown field ${key}`); }
function string(value: unknown, label: string, max = 10_000): string {
  if (typeof value !== "string" || value.length > max) fail(`${label} must be a bounded string`);
  return value;
}
function number(value: unknown, label: string, options: { integer?: boolean; min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (options.integer && !Number.isInteger(value)) || value < (options.min ?? -Infinity) || value > (options.max ?? Infinity)) fail(`${label} is invalid`);
  return value;
}
function boundedText(value: string, label: string, max = MAX_TEXT): string { if (Buffer.byteLength(value) > max) fail(`${label} exceeds size limit`); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") fail(`${label} must be boolean`); return value; }
function iso(value: unknown, label: string): string { const v = string(value, label, 64); if (!Number.isFinite(Date.parse(v))) fail(`${label} is not a date`); return v; }
function uuid(value: unknown, label: string): string { const v = string(value, label, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) fail(`${label} must be a UUID`); return v; }
function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T { if (typeof value !== "string" || !values.includes(value as T)) fail(`${label} is invalid`); return value as T; }
function safeRelative(value: unknown, label: string): string {
  const p = string(value, label, 1024).replaceAll("\\", "/");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some(x => !x || x === "." || x === "..")) fail(`${label} must be a normalized relative path`);
  return p;
}
function ref(value: unknown, label: string): FileRef {
  const r = record(value, label); exactKeys(r, ["path", "sha256", "bytes"], label);
  const hash = string(r.sha256, `${label}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail(`${label}.sha256 is invalid`);
  return { path: safeRelative(r.path, `${label}.path`), sha256: hash, bytes: number(r.bytes, `${label}.bytes`, { integer: true, min: 0, max: MAX_AUDIO }) };
}
function loadSettings(value: unknown): WavySettings { const raw = record(value, "settings"); for (const key of ["precision", "planning", "maxSemanticTokens"]) if (!Object.hasOwn(raw, key)) fail(`settings is missing required field ${key}`); try { return validateSettings(raw); } catch (error) { fail(error instanceof Error ? error.message : "settings are invalid"); } }
function files(value: unknown, label: string): CompositionFiles {
  const f = record(value, label); exactKeys(f, ["lyrics", "style", "settings", "score"], label);
  return { lyrics: ref(f.lyrics, `${label}.lyrics`), style: ref(f.style, `${label}.style`), settings: ref(f.settings, `${label}.settings`), ...(f.score === undefined ? {} : { score: ref(f.score, `${label}.score`) }) };
}
function validateIndex(value: unknown): WavyIndex {
  const x = record(value, "index"); exactKeys(x, ["format", "version", "title", "createdAt", "updatedAt", "revision", "revisions", "sources", "takes"], "index");
  if (x.format !== "wavy" || x.version !== 1) fail("unsupported format or version");
  const revisionsRaw = Array.isArray(x.revisions) ? x.revisions : fail("revisions must be an array");
  const sourcesRaw = Array.isArray(x.sources) ? x.sources : fail("sources must be an array");
  const takesRaw = Array.isArray(x.takes) ? x.takes : fail("takes must be an array");
  if (revisionsRaw.length + sourcesRaw.length + takesRaw.length > MAX_REFS) fail("too many records");
  const revisions: WavyRevision[] = revisionsRaw.map((v, i) => { const r = record(v, `revisions[${i}]`); exactKeys(r, ["id", "createdAt", "summary", "origin", "files", "provenance"], `revisions[${i}]`); return { id: number(r.id, `revisions[${i}].id`, { integer: true, min: 1 }), createdAt: iso(r.createdAt, `revisions[${i}].createdAt`), summary: string(r.summary, `revisions[${i}].summary`, 2000), origin: oneOf(r.origin, ["user", "agent", "yue", "transcription"] as const, `revisions[${i}].origin`), files: files(r.files, `revisions[${i}].files`), ...(r.provenance === undefined ? {} : { provenance: ref(r.provenance, `revisions[${i}].provenance`) }) }; });
  const sources: WavySource[] = sourcesRaw.map((v, i) => { const s = record(v, `sources[${i}]`); exactKeys(s, ["id", "label", "audio", "transcription", "score", "createdAt"], `sources[${i}]`); return { id: uuid(s.id, `sources[${i}].id`), label: string(s.label, `sources[${i}].label`, 500), audio: ref(s.audio, `sources[${i}].audio`), createdAt: iso(s.createdAt, `sources[${i}].createdAt`), ...(s.transcription === undefined ? {} : { transcription: ref(s.transcription, `sources[${i}].transcription`) }), ...(s.score === undefined ? {} : { score: ref(s.score, `sources[${i}].score`) }) }; });
  const takes: WavyTake[] = takesRaw.map((v, i) => { const t = record(v, `takes[${i}]`); exactKeys(t, ["id", "revision", "createdAt", "status", "seed", "precision", "request", "result", "audio", "wav", "durationSeconds", "elapsedSeconds", "finishReason", "truncated", "error"], `takes[${i}]`); const out: WavyTake = { id: uuid(t.id, `takes[${i}].id`), revision: number(t.revision, `takes[${i}].revision`, { integer: true, min: 1 }), createdAt: iso(t.createdAt, `takes[${i}].createdAt`), status: oneOf(t.status, ["running", "complete", "failed", "cancelled", "interrupted"] as const, `takes[${i}].status`), seed: number(t.seed, `takes[${i}].seed`, { integer: true, min: 0 }), precision: oneOf(t.precision, ["bf16", "4bit"] as const, `takes[${i}].precision`), request: ref(t.request, `takes[${i}].request`) };
    for (const k of ["result", "audio", "wav"] as const) if (t[k] !== undefined) out[k] = ref(t[k], `takes[${i}].${k}`);
    for (const k of ["durationSeconds", "elapsedSeconds"] as const) if (t[k] !== undefined) out[k] = number(t[k], `takes[${i}].${k}`, { min: 0, max: 1e9 });
    for (const k of ["finishReason", "error"] as const) if (t[k] !== undefined) out[k] = string(t[k], `takes[${i}].${k}`, 10_000);
    if (t.truncated !== undefined) out.truncated = boolean(t.truncated, `takes[${i}].truncated`); return out; });
  const revision = number(x.revision, "revision", { integer: true, min: 1 });
  if (revisions.length === 0 || revisions.some((r, i) => r.id !== i + 1) || revision !== revisions.length) fail("revision history must be contiguous with the head at the latest revision");
  if (new Set(sources.map(s => s.id)).size !== sources.length || new Set(takes.map(t => t.id)).size !== takes.length) fail("source or take IDs are duplicated");
  if (takes.some(t => !revisions.some(r => r.id === t.revision))) fail("take references unknown revision");
  return { format: "wavy", version: 1, title: string(x.title, "title", 500), createdAt: iso(x.createdAt, "createdAt"), updatedAt: iso(x.updatedAt, "updatedAt"), revision, revisions, sources, takes };
}

async function projectPath(cwd: string, input: string): Promise<{ index: string; root: string; artifacts: string }> {
  if (input.includes("\0")) fail("project path contains NUL");
  let relInput = input;
  const legacyPrefix = "/api/artifacts/", scopedPrefix = "/api/session-artifacts/";
  if (input.startsWith(legacyPrefix) || input.startsWith(scopedPrefix)) {
    const scoped = input.startsWith(scopedPrefix), encoded = input.slice((scoped ? scopedPrefix : legacyPrefix).length), parts = encoded.split("/");
    if (parts.some(p => !p) || (scoped && parts.length < 2)) fail("artifact URL has empty or missing path segments");
    const decoded = parts.map((part) => { let value: string; try { value = decodeURIComponent(part); } catch { fail("artifact URL has invalid encoding"); } if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) fail("artifact URL has unsafe path segments"); return value; });
    if (scoped) decoded.shift(); // Core authenticates and verifies the owning-session segment; Wavy still contains the remainder under cwd.
    relInput = decoded.join(sep);
  }
  if (isAbsolute(relInput)) fail("project path must be artifact-relative");
  const cwdReal = resolve(cwd); const artifacts = resolve(cwdReal, ".pi/web/artifacts");
  let cursor = cwdReal; for (const segment of [".pi", "web", "artifacts"]) { cursor = resolve(cursor, segment); try { const s = await lstat(cursor); if (s.isSymbolicLink() || !s.isDirectory()) fail("artifact ancestors must be real directories"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await mkdir(cursor); } }
  const prefix = `.pi${sep}web${sep}artifacts${sep}`;
  const rel = relInput.startsWith(prefix) ? relInput.slice(prefix.length) : relInput;
  if (extname(rel) !== ".wavy") fail("project path must end in .wavy");
  const index = resolve(artifacts, rel); const lexical = relative(artifacts, index);
  if (!lexical || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) fail("project path escapes artifacts");
  await assertNoSymlinkPath(artifacts, dirname(index));
  try { if ((await lstat(index)).isSymbolicLink()) fail("index symlinks are not allowed"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { index, root: `${index}.d`, artifacts };
}
async function assertNoSymlinkPath(base: string, target: string): Promise<void> {
  const rel = relative(base, target); if (rel.startsWith("..") || isAbsolute(rel)) fail("path escapes project");
  let cur = base;
  for (const part of rel.split(sep).filter(Boolean)) { cur = resolve(cur, part); try { if ((await lstat(cur)).isSymbolicLink()) fail("symlinks are not allowed"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; } }
}
async function atomicJson(path: string, value: unknown): Promise<void> { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; const data = jsonText(value, "index"); if (Buffer.byteLength(data) > MAX_INDEX) fail("index exceeds size limit"); try { await writeFile(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temp, path); } finally { await rm(temp, { force: true }); } }
function jsonText(value: unknown, label: string): string { let encoded: string | undefined; try { encoded = JSON.stringify(value, (key, item) => { if (POLLUTION_KEYS.has(key)) fail(`${label} contains forbidden key ${key}`); if (typeof item === "number" && !Number.isFinite(item)) fail(`${label} contains a non-finite number`); return item; }, 2); } catch (error) { if (error instanceof Error && error.message.startsWith("Invalid Wavy project:")) throw error; fail(`${label} is not JSON-serializable`); } if (encoded === undefined) fail(`${label} is not JSON-serializable`); return `${encoded}\n`; }
async function put(root: string, rel: string, data: string | Buffer, max: number): Promise<FileRef> { const bytes = Buffer.byteLength(data); if (bytes > max) fail(`${rel} exceeds size limit`); const path = resolve(root, rel); await assertNoSymlinkPath(root, dirname(path)); await mkdir(dirname(path), { recursive: true }); await assertNoSymlinkPath(root, dirname(path)); await writeFile(path, data, { flag: "wx", mode: 0o600 }); return { path: `${basename(root)}/${rel.replaceAll("\\", "/")}`, bytes, sha256: createHash("sha256").update(data).digest("hex") }; }
async function readBounded(path: string, max: number): Promise<Buffer> { const s = await stat(path); if (!s.isFile() || s.size > max) fail(`file is missing, not regular, or exceeds ${max} bytes`); return readFile(path); }

export async function resolveFile(project: LoadedProject, file: FileRef): Promise<string> {
  const root = `${project.absolutePath}.d`; const stored = safeRelative(file.path, "file reference"); const prefix = `${basename(project.absolutePath)}.d/`; if (!stored.startsWith(prefix)) fail(`file reference must start with ${prefix}`); const rel = stored.slice(prefix.length); if (!rel) fail("file reference points at companion directory"); const target = resolve(root, rel);
  if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) fail("file reference escapes companion directory");
  await assertNoSymlinkPath(root, target); const realRoot = await realpath(root); const realTarget = await realpath(target);
  if (realTarget !== resolve(realRoot, rel) || relative(realRoot, realTarget).startsWith("..")) fail("file reference escapes through symlink");
  const data = await readBounded(realTarget, MAX_AUDIO); if (data.length !== file.bytes || createHash("sha256").update(data).digest("hex") !== file.sha256) fail(`file integrity mismatch: ${rel}`); return realTarget;
}
export function artifactURL(cwd: string, absolutePath: string): string { const root = resolve(cwd, ".pi/web/artifacts"); const rel = relative(root, resolve(absolutePath)); if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail("artifact path escapes artifacts"); return `/api/artifacts/${rel.split(sep).map(encodeURIComponent).join("/")}`; }

export async function loadProject(cwd: string, path: string): Promise<LoadedProject> {
  const p = await projectPath(cwd, path); const raw = await readBounded(p.index, MAX_INDEX); let parsed: unknown; try { parsed = JSON.parse(raw.toString("utf8")); } catch { fail("index is not valid JSON"); }
  const index = validateIndex(parsed); const rootStat = await lstat(p.root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("companion path must be a real directory"); const revision = index.revisions.find(r => r.id === index.revision)!;
  const shell: LoadedProject = { index, absolutePath: p.index, artifactPath: artifactURL(cwd, p.index), head: { lyrics: "", style: "", settings: DEFAULT_SETTINGS }, warnings: [] };
  const allRefs = index.revisions.flatMap(r => [...Object.values(r.files), ...(r.provenance ? [r.provenance] : [])]).concat(index.sources.flatMap(s => [s.audio, s.transcription, s.score].filter(Boolean) as FileRef[]), index.takes.flatMap(t => [t.request, t.result, t.audio, t.wav].filter(Boolean) as FileRef[]));
  for (const item of allRefs) await resolveFile(shell, item);
  const lyrics = (await resolveFile(shell, revision.files.lyrics)).toString();
  const style = (await resolveFile(shell, revision.files.style)).toString();
  const settingsPath = await resolveFile(shell, revision.files.settings); let settingsJson: unknown; try { settingsJson = JSON.parse((await readFile(settingsPath, "utf8"))); } catch { fail("settings file is invalid JSON"); }
  shell.head = { lyrics: await readFile(lyrics, "utf8"), style: await readFile(style, "utf8"), settings: loadSettings(settingsJson), ...(revision.files.score ? { score: await readFile(await resolveFile(shell, revision.files.score), "utf8") } : {}) };
  if (!shell.head.lyrics) shell.warnings.push("Lyrics are empty.");
  if (!shell.head.style) shell.warnings.push("Style direction is empty.");
  if (!revision.files.score) shell.warnings.push("No score is attached.");
  if (!index.takes.length) shell.warnings.push("No takes have been rendered.");
  if (index.takes.some(take => take.status === "running")) shell.warnings.push("A take was marked running when saved. This snapshot is not a live process check; after a crash its status may be stale.");
  return shell;
}

export async function createProject(cwd: string, input: { path: string; title: string; lyrics?: string; style?: string; score?: string; settings?: Partial<WavySettings>; origin?: WavyRevision["origin"] }): Promise<LoadedProject> {
  const p = await projectPath(cwd, input.path); return withFileMutationQueue(p.index, async () => {
    try { await stat(p.index); fail("project already exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await mkdir(dirname(p.root), { recursive: true }); await mkdir(p.root, { recursive: false }); const now = new Date().toISOString();
    try { const base = "revisions/000001"; const fs: CompositionFiles = { lyrics: await put(p.root, `${base}/lyrics.md`, input.lyrics ?? "", MAX_TEXT), style: await put(p.root, `${base}/style.md`, input.style ?? "", MAX_TEXT), settings: await put(p.root, `${base}/settings.json`, `${JSON.stringify(validateSettings(input.settings ?? {}, DEFAULT_SETTINGS), null, 2)}\n`, MAX_JSON), ...(input.score === undefined ? {} : { score: await put(p.root, `${base}/score.abc`, input.score, MAX_TEXT) }) };
      const index: WavyIndex = { format: "wavy", version: 1, title: string(input.title, "title", 500), createdAt: now, updatedAt: now, revision: 1, revisions: [{ id: 1, createdAt: now, summary: "Created project", origin: input.origin ?? "agent", files: fs }], sources: [], takes: [] }; await atomicJson(p.index, index);
    } catch (e) { await rm(p.root, { recursive: true, force: true }); throw e; }
    return loadProject(cwd, input.path);
  });
}

export async function reviseProject(cwd: string, path: string, input: { expectedRevision: number; summary: string; origin?: WavyRevision["origin"]; lyrics?: string; style?: string; score?: string | null; settings?: Partial<WavySettings>; provenance?: unknown }): Promise<LoadedProject> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    const current = await loadProject(cwd, path);
    if (current.index.revision !== input.expectedRevision) throw new Error(`Wavy revision conflict: expected ${input.expectedRevision}, found ${current.index.revision}`);
    const id = current.index.revision + 1;
    const base = `revisions/${String(id).padStart(6, "0")}`;
    const finalDir = resolve(p.root, base);
    try { await lstat(finalDir); fail("next revision destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const score = input.score === undefined ? current.head.score : input.score ?? undefined;
    const lyrics = boundedText(input.lyrics ?? current.head.lyrics, "lyrics");
    const style = boundedText(input.style ?? current.head.style, "style");
    if (score !== undefined) boundedText(score, "score");
    const nextSettings = validateSettings(input.settings ?? {}, current.head.settings);
    const provenanceData = input.provenance === undefined ? undefined : jsonText(input.provenance, "provenance");
    const summary = string(input.summary, "summary", 2000);
    const stage = resolve(p.root, "revisions", `.stage-${randomUUID()}`);
    await assertNoSymlinkPath(p.root, dirname(stage)); await mkdir(stage);
    let ownsFinal = false, committed = false;
    const relocate = (r: FileRef, name: string): FileRef => ({ ...r, path: `${basename(p.root)}/${base}/${name}` });
    try {
      const lyricsRef = relocate(await put(stage, "lyrics.md", lyrics, MAX_TEXT), "lyrics.md");
      const styleRef = relocate(await put(stage, "style.md", style, MAX_TEXT), "style.md");
      const settingsRef = relocate(await put(stage, "settings.json", jsonText(nextSettings, "settings"), MAX_JSON), "settings.json");
      const scoreRef = score === undefined ? undefined : relocate(await put(stage, "score.abc", score, MAX_TEXT), "score.abc");
      const provenance = provenanceData === undefined ? undefined : relocate(await put(stage, "provenance.json", provenanceData, MAX_JSON), "provenance.json");
      await rename(stage, finalDir); ownsFinal = true;
      const files: CompositionFiles = { lyrics: lyricsRef, style: styleRef, settings: settingsRef, ...(scoreRef ? { score: scoreRef } : {}) };
      const now = new Date().toISOString(); current.index.revisions.push({ id, createdAt: now, summary, origin: input.origin ?? "agent", files, ...(provenance ? { provenance } : {}) });
      current.index.revision = id; current.index.updatedAt = now; await atomicJson(p.index, current.index); committed = true;
      return await loadProject(cwd, path);
    } finally {
      await rm(stage, { recursive: true, force: true });
      if (ownsFinal && !committed) await rm(finalDir, { recursive: true, force: true });
    }
  });
}

export async function importSource(cwd: string, path: string, input: { sourcePath: string; label?: string }): Promise<LoadedProject> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    const project = await loadProject(cwd, path); const ext = extname(input.sourcePath).toLowerCase(); if (!AUDIO_EXTENSIONS.has(ext)) fail("unsupported source audio type");
    const data = await readBounded(input.sourcePath, MAX_AUDIO); const label = input.label ? string(input.label, "label", 500) : basename(input.sourcePath); const id = randomUUID(); const owned = resolve(p.root, "sources", id); let committed = false;
    try { const audio = await put(p.root, `sources/${id}/audio${ext}`, data, MAX_AUDIO); project.index.sources.push({ id, label, audio, createdAt: new Date().toISOString() }); project.index.updatedAt = new Date().toISOString(); await atomicJson(p.index, project.index); committed = true; return await loadProject(cwd, path); }
    finally { if (!committed) await rm(owned, { recursive: true, force: true }); }
  });
}

export async function beginTake(cwd: string, path: string, input: { revision: number; seed: number; precision: "bf16" | "4bit"; request: unknown }): Promise<{ project: LoadedProject; take: WavyTake; outputDir: string }> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    const project = await loadProject(cwd, path); if (!project.index.revisions.some(r => r.id === input.revision)) fail("take revision does not exist");
    const seed = number(input.seed, "seed", { integer: true, min: 0 }); const precision = oneOf(input.precision, ["bf16", "4bit"] as const, "precision"); const requestData = jsonText(input.request, "request"); const id = randomUUID(); const owned = resolve(p.root, "takes", id); let committed = false;
    try { const request = await put(p.root, `takes/${id}/receipts/request.json`, requestData, MAX_JSON); const runDir = resolve(owned, "run"); await assertNoSymlinkPath(p.root, dirname(runDir)); await mkdir(runDir); const take: WavyTake = { id, revision: input.revision, createdAt: new Date().toISOString(), status: "running", seed, precision, request }; project.index.takes.push(take); project.index.updatedAt = new Date().toISOString(); await atomicJson(p.index, project.index); committed = true; return { project: await loadProject(cwd, path), take, outputDir: runDir }; }
    finally { if (!committed) await rm(owned, { recursive: true, force: true }); }
  });
}

export async function finishTake(cwd: string, path: string, takeId: string, input: { status: Exclude<WavyTake["status"], "running">; result?: unknown; audioPath?: string; wavPath?: string; durationSeconds?: number; elapsedSeconds?: number; finishReason?: string; truncated?: boolean; error?: string }): Promise<LoadedProject> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    const project = await loadProject(cwd, path); const take = project.index.takes.find(t => t.id === takeId); if (!take || take.status !== "running") fail("take is missing or already finished");
    const status = oneOf(input.status, ["complete", "failed", "cancelled", "interrupted"] as const, "status");
    const durationSeconds = input.durationSeconds === undefined ? undefined : number(input.durationSeconds, "durationSeconds", { min: 0, max: 1e9 });
    const elapsedSeconds = input.elapsedSeconds === undefined ? undefined : number(input.elapsedSeconds, "elapsedSeconds", { min: 0, max: 1e9 });
    const finishReason = input.finishReason === undefined ? undefined : string(input.finishReason, "finishReason", 10_000); const error = input.error === undefined ? undefined : string(input.error, "error", 10_000); const truncated = input.truncated === undefined ? undefined : boolean(input.truncated, "truncated");
    const resultData = input.result === undefined ? undefined : jsonText(input.result, "result"); const audioExt = input.audioPath ? extname(input.audioPath).toLowerCase() : undefined; if (audioExt && !AUDIO_EXTENSIONS.has(audioExt)) fail("unsupported take audio type"); if (input.wavPath && extname(input.wavPath).toLowerCase() !== ".wav") fail("take WAV path must end in .wav");
    const audioData = input.audioPath ? await readBounded(input.audioPath, MAX_AUDIO) : undefined; const sameAudio = !!(input.audioPath && input.wavPath && resolve(input.audioPath) === resolve(input.wavPath)); const wavData = input.wavPath && !sameAudio ? await readBounded(input.wavPath, MAX_AUDIO) : undefined; if (audioExt === ".wav" && wavData) fail("distinct audioPath and wavPath cannot both target audio.wav"); if (status === "complete" && !audioData && !wavData) fail("completed take requires usable audio");
    const stage = resolve(p.root, "takes", takeId, `.finish-${randomUUID()}`); await assertNoSymlinkPath(p.root, dirname(stage)); await mkdir(stage); const created: string[] = []; let committed = false;
    const finalRef = (r: FileRef, rel: string): FileRef => ({ ...r, path: `${basename(p.root)}/takes/${takeId}/${rel}` });
    try {
      const stagedResult = resultData === undefined ? undefined : await put(stage, "result.json", resultData, MAX_JSON); const stagedAudio = audioData && audioExt ? await put(stage, `audio${audioExt}`, audioData, MAX_AUDIO) : undefined; const stagedWav = wavData ? await put(stage, "audio.wav", wavData, MAX_AUDIO) : undefined;
      const install = async (name: string): Promise<void> => { const target = resolve(p.root, "takes", takeId, name); try { await lstat(target); fail(`take destination already exists: ${name}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } await mkdir(dirname(target), { recursive: true }); await rename(resolve(stage, name === "receipts/result.json" ? "result.json" : name), target); created.push(target); };
      if (stagedResult) { await install("receipts/result.json"); take.result = finalRef(stagedResult, "receipts/result.json"); } if (stagedAudio && audioExt) { await install(`audio${audioExt}`); take.audio = finalRef(stagedAudio, `audio${audioExt}`); } if (sameAudio) take.wav = take.audio; else if (stagedWav) { await install("audio.wav"); take.wav = finalRef(stagedWav, "audio.wav"); }
      Object.assign(take, { status, ...(durationSeconds === undefined ? {} : { durationSeconds }), ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }), ...(finishReason === undefined ? {} : { finishReason }), ...(truncated === undefined ? {} : { truncated }), ...(error === undefined ? {} : { error }) }); project.index.updatedAt = new Date().toISOString(); await atomicJson(p.index, project.index); committed = true; return await loadProject(cwd, path);
    } finally { await rm(stage, { recursive: true, force: true }); if (!committed) await Promise.all(created.map(file => rm(file, { force: true }))); }
  });
}

export async function attachTranscription(cwd: string, path: string, sourceId: string, input: { events: unknown; score: string }): Promise<LoadedProject> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    const project = await loadProject(cwd, path); const source = project.index.sources.find(s => s.id === sourceId); if (!source) fail("source does not exist"); if (source.transcription || source.score) fail("source already has a transcription"); const events = jsonText(input.events, "transcription events"); boundedText(input.score, "score");
    const stage = resolve(p.root, "sources", sourceId, `.transcription-${randomUUID()}`); await assertNoSymlinkPath(p.root, dirname(stage)); await mkdir(stage); const created: string[] = []; let committed = false;
    const install = async (name: string): Promise<void> => { const target = resolve(p.root, "sources", sourceId, name); try { await lstat(target); fail(`source destination already exists: ${name}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } await rename(resolve(stage, name), target); created.push(target); };
    try { const transcription = await put(stage, "transcription.json", events, MAX_JSON); const score = await put(stage, "score.abc", input.score, MAX_TEXT); await install("transcription.json"); await install("score.abc"); source.transcription = { ...transcription, path: `${basename(p.root)}/sources/${sourceId}/transcription.json` }; source.score = { ...score, path: `${basename(p.root)}/sources/${sourceId}/score.abc` }; project.index.updatedAt = new Date().toISOString(); await atomicJson(p.index, project.index); committed = true; return await loadProject(cwd, path); }
    finally { await rm(stage, { recursive: true, force: true }); if (!committed) await Promise.all(created.map(file => rm(file, { force: true }))); }
  });
}

export async function newOperationDir(cwd: string, path: string, operation: "compose" | "transcribe"): Promise<string> {
  const p = await projectPath(cwd, path);
  return withFileMutationQueue(p.index, async () => {
    await loadProject(cwd, path); oneOf(operation, ["compose", "transcribe"] as const, "operation"); const parent = resolve(p.root, "jobs", operation); await assertNoSymlinkPath(p.root, parent); await mkdir(parent, { recursive: true }); await assertNoSymlinkPath(p.root, parent); const dir = resolve(parent, randomUUID()); await mkdir(dir); return dir;
  });
}

async function inspectExportTree(root: string): Promise<void> { let count = 0, bytes = 0; const walk = async (dir: string): Promise<void> => { for (const entry of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) { if (++count > MAX_REFS) fail("too many files to export"); const p = resolve(dir, entry.name); const s = await lstat(p); if (s.isSymbolicLink()) fail("symlinks are not allowed in exports"); if (s.isDirectory()) await walk(p); else if (s.isFile()) { bytes += s.size; if (s.size > MAX_AUDIO || bytes > MAX_EXPORT_BYTES) fail("export exceeds size limit"); } else fail("special files are not allowed in exports"); } }; await walk(root); }
export async function exportProject(cwd: string, path: string): Promise<{ path: string; artifactPath: string }> { const p = await projectPath(cwd, path); return withFileMutationQueue(p.index, async () => { const project = await loadProject(cwd, path); const refs = project.index.revisions.flatMap(r => [...Object.values(r.files), ...(r.provenance ? [r.provenance] : [])]).concat(project.index.sources.flatMap(s => [s.audio, s.transcription, s.score].filter(Boolean) as FileRef[]), project.index.takes.flatMap(t => [t.request, t.result, t.audio, t.wav].filter(Boolean) as FileRef[])); for (const r of refs) await resolveFile(project, r); await inspectExportTree(p.root); const output = `${p.index}.tar.gz`, temp = `${output}.${randomUUID()}.tmp`; await execFileAsync("tar", ["-czf", temp, "-C", dirname(p.index), "--", basename(p.index), basename(p.root)]); await rename(temp, output); return { path: output, artifactPath: artifactURL(cwd, output) }; }); }
