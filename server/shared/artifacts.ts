import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const artifactPathParts = [".pi", "web", "artifacts"] as const;
export const legacyArtifactPathParts = [".pi-web-uploads", "artifacts"] as const;

export function safeArtifactName(name: unknown): string {
  return String(name || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 160);
}

export function isValidArtifactName(name: string): boolean {
  return Boolean(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\") && safeArtifactName(name) === name;
}

export function isValidArtifactPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return false;
  return path.split("/").every(isValidArtifactName);
}

function containedArtifactFile(root: string, path: string): string | undefined {
  if (!isValidArtifactPath(path)) return undefined;
  const file = resolve(root, ...path.split("/"));
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  const fromRoot = relative(realRoot, realFile);
  return fromRoot && !fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." ? file : undefined;
}

export function artifactDirForCwd(cwd: string): string {
  return join(cwd, ...artifactPathParts);
}

export function legacyArtifactDirForCwd(cwd: string): string {
  return join(cwd, ...legacyArtifactPathParts);
}

export function artifactFileForCwd(cwd: string, name: string): string {
  return join(artifactDirForCwd(cwd), name);
}

export function legacyArtifactFileForCwd(cwd: string, name: string): string {
  return join(legacyArtifactDirForCwd(cwd), name);
}

export function findArtifactFile(cwds: Iterable<string>, path: string): string | undefined {
  if (!isValidArtifactPath(path)) return undefined;
  for (const cwd of cwds) {
    const file = containedArtifactFile(artifactDirForCwd(cwd), path);
    if (file) return file;
    const legacyFile = containedArtifactFile(legacyArtifactDirForCwd(cwd), path);
    if (legacyFile) return legacyFile;
  }
  return undefined;
}

export async function readArtifactBase64(cwd: string, nameValue: unknown, maxBytes?: number) {
  const name = String(nameValue || "");
  if (!isValidArtifactPath(name)) throw new Error("Invalid artifact path");
  const root = await realpath(artifactDirForCwd(cwd));
  const file = await realpath(artifactFileForCwd(cwd, name));
  const fromRoot = relative(root, file);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("Invalid artifact path");
  const info = await stat(file);
  if (Number.isFinite(maxBytes) && Number(maxBytes) > 0 && info.size > Number(maxBytes)) {
    throw new Error(`Artifact is too large (${info.size} bytes > ${maxBytes} bytes)`);
  }
  const bytes = await readFile(file);
  return { ok: true as const, name, base64: bytes.toString("base64") };
}
