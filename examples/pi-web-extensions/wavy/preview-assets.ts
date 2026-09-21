import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface WavyPreviewAsset { id: string; path: string; mediaType?: string; bytes?: number; sha256?: string }
const ROOT = dirname(fileURLToPath(import.meta.url));
const NOTES = ["C1", "F#1", "C2", "F#2", "C3", "F#3", "C4", "F#4", "C5", "F#5", "C6", "F#6", "C7", "F#7", "C8"];
const MAX_SAMPLE_BYTES = 512 * 1024;
const MAX_PIANO_BYTES = 4 * 1024 * 1024;
let bundled: Promise<Array<{ note: string; source: string; data: Buffer; bytes: number; sha256: string }>> | undefined;

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
async function requireRealDirectory(path: string, label: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory.`);
}
async function ensureDirectory(parent: string, name: string, label: string) {
  const path = resolve(parent, name);
  try { await requireRealDirectory(path, label); }
  catch (error) {
    if (!missing(error)) throw error;
    try { await mkdir(path); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException)?.code !== "EEXIST") throw mkdirError; }
    await requireRealDirectory(path, label);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} escaped through a symlink.`);
  return path;
}
async function secureArtifactRoot(cwd: string) {
  const root = await realpath(cwd);
  await requireRealDirectory(root, "Wavy project root");
  let cursor = root;
  for (const [name, label] of [[".pi", "Wavy .pi directory"], ["web", "Wavy web directory"], ["artifacts", "Wavy artifact directory"]] as const) cursor = await ensureDirectory(cursor, name, label);
  const rel = relative(root, cursor);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Wavy artifact directory escaped the project directory.");
  return cursor;
}

async function bundledPiano() {
  return bundled ??= (async () => {
    // The installed extension itself may deliberately be a user-global symlink.
    // Trust that resolved installation, but reject links beneath its vendor tree.
    const installation = await realpath(ROOT);
    const vendor = join(installation, "vendor");
    await requireRealDirectory(vendor, "Bundled asset vendor directory");
    if (await realpath(vendor) !== vendor) throw new Error("Bundled asset vendor directory escaped through a symlink.");
    const PIANO_ROOT = join(vendor, "piano");
    const rootInfo = await lstat(PIANO_ROOT);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Bundled piano directory must be a real directory.");
    const canonicalRoot = await realpath(PIANO_ROOT);
    if (canonicalRoot !== PIANO_ROOT) throw new Error("Bundled piano directory escaped through a symlink.");
    let total = 0;
    const files: Array<{ note: string; source: string; bytes: number }> = [];
    for (const note of NOTES) {
      const source = join(PIANO_ROOT, `${note}v3.mp3`);
      const info = await lstat(source);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Bundled piano sample ${note} must be a regular file.`);
      if (info.size <= 0 || info.size > MAX_SAMPLE_BYTES) throw new Error(`Bundled piano sample ${note} exceeds its size bound.`);
      total += info.size;
      if (total > MAX_PIANO_BYTES) throw new Error("Bundled piano samples exceed their total size bound.");
      const canonical = await realpath(source);
      if (canonical !== source || relative(canonicalRoot, canonical).startsWith("..")) throw new Error(`Bundled piano sample ${note} escaped its vendor directory.`);
      files.push({ note, source, bytes: info.size });
    }
    return Promise.all(files.map(async file => {
      const data = await readFile(file.source);
      if (data.byteLength !== file.bytes) throw new Error(`Bundled piano sample ${file.note} changed while reading.`);
      return { ...file, data, sha256: createHash("sha256").update(data).digest("hex") };
    }));
  })();
}

async function validCachedFile(path: string, sample: { bytes: number; sha256: string }) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Wavy piano cache entries must be regular files, not links.");
    if (info.size !== sample.bytes) return false;
    const data = await readFile(path);
    return data.byteLength === sample.bytes && createHash("sha256").update(data).digest("hex") === sample.sha256;
  } catch (error) { if (missing(error)) return false; throw error; }
}

/** Stage immutable vendor samples only when rendering a real cwd-backed preview. */
export async function stagePianoAssets(cwd?: string): Promise<WavyPreviewAsset[]> {
  if (!cwd) return [];
  const artifactRoot = await secureArtifactRoot(cwd);
  const cache = await ensureDirectory(artifactRoot, "wavy-preview-cache", "Wavy piano cache");
  if (relative(artifactRoot, cache) !== "wavy-preview-cache") throw new Error("Wavy piano cache escaped the artifact directory.");
  const result: WavyPreviewAsset[] = [];
  for (const sample of await bundledPiano()) {
    const name = `${sample.sha256.slice(0, 20)}-${basename(sample.source).replace("#", "sharp")}`;
    const target = join(cache, name);
    if (!await validCachedFile(target, sample)) {
      // A regular cache file is extension-owned derived data and may be atomically
      // repaired. Symlinks and special files are rejected above, never followed.
      await requireRealDirectory(cache, "Wavy piano cache");
      if (await realpath(cache) !== cache) throw new Error("Wavy piano cache changed while staging.");
      const temp = join(cache, `tmp-${process.pid}-${Math.random().toString(16).slice(2)}-${name}`);
      try {
        await writeFile(temp, sample.data, { flag: "wx", mode: 0o600 });
        await rename(temp, target);
      } finally { await rm(temp, { force: true }); }
      if (!await validCachedFile(target, sample)) throw new Error(`Wavy piano cache repair failed for ${sample.note}.`);
    }
    result.push({ id: `piano-${sample.note.replace("#", "s")}`, path: `wavy-preview-cache/${name}`, mediaType: "audio/mpeg", bytes: sample.bytes, sha256: sample.sha256 });
  }
  return result;
}

export const pianoSampleNotes = NOTES;
