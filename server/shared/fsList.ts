import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type DirectoryListing = {
  ok: true;
  path: string;
  parent: string;
  dirs: Array<{ name: string; path: string }>;
};

export async function assertDirectory(pathValue: string, fallback = process.cwd()): Promise<string> {
  const resolved = resolve(pathValue || fallback);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  return resolved;
}

export async function listDirectories(pathValue: unknown, fallback = process.cwd()): Promise<DirectoryListing> {
  const resolved = await assertDirectory(typeof pathValue === "string" ? pathValue : fallback, fallback);
  const entries = await readdir(resolved, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, path: resolved, parent: dirname(resolved), dirs };
}

export async function createDirectory(parent: string, name: string, fallback = process.cwd()): Promise<DirectoryListing> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Folder name is required");
  if (isAbsolute(trimmedName) || trimmedName === "." || trimmedName === ".." || trimmedName.includes("/") || trimmedName.includes("\\")) {
    throw new Error("Folder name must be a single directory name");
  }
  const parentDir = await assertDirectory(parent, fallback);
  const target = resolve(parentDir, trimmedName);
  const rel = relative(parentDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Folder name must stay inside the selected directory");
  await mkdir(target);
  return listDirectories(target, fallback);
}
