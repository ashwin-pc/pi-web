import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const artifactPathParts = [".pi", "web", "artifacts"] as const;
export const legacyArtifactPathParts = [".pi-web-uploads", "artifacts"] as const;

export function safeArtifactName(name: unknown): string {
  return String(name || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 160);
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

export async function readArtifactBase64(cwd: string, nameValue: unknown, maxBytes?: number) {
  const name = safeArtifactName(nameValue);
  if (!name) throw new Error("Artifact name is required");
  const file = artifactFileForCwd(cwd, name);
  const info = await stat(file);
  if (Number.isFinite(maxBytes) && Number(maxBytes) > 0 && info.size > Number(maxBytes)) {
    throw new Error(`Artifact is too large (${info.size} bytes > ${maxBytes} bytes)`);
  }
  const bytes = await readFile(file);
  return { ok: true as const, name, base64: bytes.toString("base64") };
}
