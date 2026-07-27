import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const editableLimit = 5 * 1024 * 1024;
const hiddenDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache", ".next", "target", "vendor"]);

export class WorkspaceFileError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function normalizedRelativePath(value: unknown) {
  const path = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (isAbsolute(path) || path.split("/").some((part) => part === "..")) throw new WorkspaceFileError("Path must remain inside the workspace");
  return path === "." ? "" : path;
}

function isContained(root: string, target: string) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function workspaceRoot(cwd: string) {
  return realpath(cwd);
}

async function existingWorkspacePath(cwd: string, pathValue: unknown) {
  const root = await workspaceRoot(cwd);
  const path = normalizedRelativePath(pathValue);
  const lexical = resolve(root, path);
  if (!isContained(root, lexical)) throw new WorkspaceFileError("Path must remain inside the workspace");
  let target: string;
  try { target = await realpath(lexical); } catch { throw new WorkspaceFileError("File not found", 404); }
  if (!isContained(root, target)) throw new WorkspaceFileError("Symlink resolves outside the workspace", 403);
  return { root, path, target };
}

function revision(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function looksBinary(data: Buffer) {
  const sample = data.subarray(0, Math.min(data.length, 8_192));
  return sample.includes(0);
}

function languageFor(path: string) {
  const name = basename(path).toLowerCase();
  if (["package.json", "tsconfig.json", "composer.json"].includes(name)) return "json";
  return ({
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".json": "json", ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "css", ".md": "markdown", ".markdown": "markdown", ".py": "python",
    ".rs": "rust", ".java": "java", ".sql": "sql",
  } as Record<string, string>)[extname(name)] || "text";
}

export async function listWorkspaceDirectory(cwd: string, pathValue: unknown, showHidden = false) {
  const { path, target } = await existingWorkspacePath(cwd, pathValue);
  const info = await stat(target);
  if (!info.isDirectory()) throw new WorkspaceFileError("Path is not a directory");
  const entries = await readdir(target, { withFileTypes: true });
  const items = await Promise.all(entries
    .filter((entry) => showHidden || !hiddenDirectories.has(entry.name))
    .map(async (entry) => {
      const itemPath = path ? `${path}/${entry.name}` : entry.name;
      const fullPath = join(target, entry.name);
      const link = entry.isSymbolicLink();
      let kind: "file" | "directory" | "symlink" = link ? "symlink" : entry.isDirectory() ? "directory" : "file";
      let size: number | undefined;
      try {
        const resolved = await realpath(fullPath);
        const itemInfo = await stat(resolved);
        if (link && isContained(await workspaceRoot(cwd), resolved)) kind = itemInfo.isDirectory() ? "directory" : "symlink";
        size = itemInfo.isFile() ? itemInfo.size : undefined;
      } catch { /* Broken or inaccessible link remains visible. */ }
      return { name: entry.name, path: itemPath, kind, ...(size === undefined ? {} : { size }) };
    }));
  items.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
  return { ok: true as const, path, entries: items };
}

const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
};

export async function readWorkspaceImage(cwd: string, pathValue: unknown) {
  const { path, target } = await existingWorkspacePath(cwd, pathValue);
  const extension = extname(path).toLowerCase();
  const mimeType = imageTypes[extension];
  if (!mimeType) throw new WorkspaceFileError("Path is not a supported image", 415);
  const info = await stat(target);
  if (!info.isFile()) throw new WorkspaceFileError("Path is not a file");
  if (info.size > 25 * 1024 * 1024) throw new WorkspaceFileError("Image is too large to preview", 413);
  const data = await readFile(target);
  const valid = extension === ".png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === ".jpg" || extension === ".jpeg" ? data[0] === 0xff && data[1] === 0xd8
    : extension === ".gif" ? data.subarray(0, 3).toString("ascii") === "GIF"
    : extension === ".webp" ? data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP"
    : extension === ".bmp" ? data.subarray(0, 2).toString("ascii") === "BM"
    : extension === ".svg" ? /<svg[\s>]/i.test(data.subarray(0, 4096).toString("utf8"))
    : false;
  if (!valid) throw new WorkspaceFileError("File has an image extension but does not contain valid image data", 415);
  return { path, mimeType, data };
}

export async function readWorkspaceFile(cwd: string, pathValue: unknown) {
  const { path, target } = await existingWorkspacePath(cwd, pathValue);
  const info = await stat(target);
  if (!info.isFile()) throw new WorkspaceFileError("Path is not a file");
  if (info.size > editableLimit) throw new WorkspaceFileError(`File is too large to edit (maximum ${editableLimit / 1024 / 1024} MB)`, 413);
  const data = await readFile(target);
  if (looksBinary(data)) throw new WorkspaceFileError("Binary files cannot be edited", 415);
  return { ok: true as const, path, content: data.toString("utf8"), size: data.length, revision: revision(data), language: languageFor(path), readOnly: false };
}

export async function writeWorkspaceFile(cwd: string, pathValue: unknown, contentValue: unknown, expectedRevision: unknown) {
  const { path, target } = await existingWorkspacePath(cwd, pathValue);
  const info = await lstat(target);
  if (!info.isFile()) throw new WorkspaceFileError("Path is not a regular file");
  const current = await readFile(target);
  if (typeof expectedRevision !== "string" || revision(current) !== expectedRevision) throw new WorkspaceFileError("File changed on disk", 409);
  if (typeof contentValue !== "string") throw new WorkspaceFileError("content must be a string");
  const data = Buffer.from(contentValue, "utf8");
  if (data.length > editableLimit) throw new WorkspaceFileError("File is too large", 413);
  const temporary = join(dirname(target), `.${basename(target)}.pi-web-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { mode: info.mode });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { ok: true as const, path, size: data.length, revision: revision(data) };
}
