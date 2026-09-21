import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { artifactDirForCwd, artifactFileForCwd, isValidArtifactPath } from "../shared/artifacts.js";
import type { PiWebArtifactPreviewAsset } from "../../src/extensions.js";

export const MAX_ARTIFACT_PREVIEW_ASSETS = 128;
export const MAX_ARTIFACT_PREVIEW_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_ARTIFACT_PREVIEW_ASSET_METADATA_BYTES = 64 * 1024;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const shaPattern = /^[a-fA-F0-9]{64}$/;
const audioTypes = new Map([
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".flac", "audio/flac"], [".opus", "audio/ogg"],
]);

function relativeAssetPath(raw: unknown, sessionId: string): string {
  if (typeof raw !== "string" || !raw || raw.includes("?") || raw.includes("#") || raw.includes("\0") || raw.includes("\\")) {
    throw new Error("Artifact preview asset has an invalid path");
  }
  let encoded = raw;
  if (raw.startsWith("/api/artifacts/")) encoded = raw.slice("/api/artifacts/".length);
  else if (raw.startsWith("/api/session-artifacts/")) {
    const rest = raw.slice("/api/session-artifacts/".length);
    const slash = rest.indexOf("/");
    if (slash < 1) throw new Error("Artifact preview asset has an invalid session path");
    let owner: string;
    try { owner = decodeURIComponent(rest.slice(0, slash)); } catch { throw new Error("Artifact preview asset has invalid encoding"); }
    if (owner !== sessionId) throw new Error("Artifact preview asset belongs to another session");
    encoded = rest.slice(slash + 1);
  } else if (raw.startsWith("/") || raw.includes(":")) {
    throw new Error("Artifact preview asset must be artifact-relative");
  }
  // Reject encoded separators before decoding so URL normalization cannot alter boundaries.
  if (/%(?:2f|5c|00)/i.test(encoded)) throw new Error("Artifact preview asset has an encoded separator");
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { throw new Error("Artifact preview asset has invalid encoding"); }
  if (!isValidArtifactPath(decoded)) throw new Error("Artifact preview asset has an invalid path");
  return decoded;
}

async function hashStableFile(path: string, root: string) {
  // O_NOFOLLOW closes the terminal-symlink replacement window between realpath
  // and open. Re-resolving and comparing the opened inode catches an
  // intermediate-component replacement that happened before this check. A
  // privileged concurrent filesystem mutator is not fully sandboxable through
  // portable Node APIs (there is no openat-style component walk here).
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const resolvedAfterOpen = await realpath(path);
    const resolvedFromRoot = relative(root, resolvedAfterOpen);
    const target = await stat(resolvedAfterOpen);
    if (resolvedAfterOpen !== path || !resolvedFromRoot || resolvedFromRoot === ".." || resolvedFromRoot.startsWith(`..${sep}`)
      || target.dev !== before.dev || target.ino !== before.ino) {
      throw new Error("Artifact preview asset path changed while opening");
    }
    if (!before.isFile()) throw new Error("Artifact preview asset is not a regular file");
    if (before.size > MAX_ARTIFACT_PREVIEW_ASSET_BYTES) throw new Error("Artifact preview asset exceeds 128 MiB");
    const hash = createHash("sha256");
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = handle.createReadStream({ autoClose: false });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy(error);
        reject(error);
      };
      stream.on("data", (chunk: string | Buffer) => {
        bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (bytes > MAX_ARTIFACT_PREVIEW_ASSET_BYTES || bytes > before.size) {
          fail(new Error("Artifact preview asset changed or exceeded 128 MiB while hashing"));
          return;
        }
        hash.update(chunk);
      }).on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))))
        .on("end", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
    });
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error("Artifact preview asset changed while hashing");
    }
    return { info: before, digest: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function normalizeArtifactPreviewAssets(input: unknown, options: { cwd: string; sessionId: string }): Promise<PiWebArtifactPreviewAsset[] | undefined> {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_ARTIFACT_PREVIEW_ASSETS) throw new Error("Artifact preview assets must be an array of at most 128 entries");
  if (input.length === 0) return [];
  const ids = new Set<string>();
  const root = await realpath(artifactDirForCwd(options.cwd));
  const output: PiWebArtifactPreviewAsset[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("Artifact preview asset must be an object");
    const asset = raw as Record<string, unknown>;
    const id = asset.id;
    if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Artifact preview asset id must be 1-80 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit");
    if (ids.has(id)) throw new Error(`Duplicate artifact preview asset id: ${id}`);
    ids.add(id);
    const path = relativeAssetPath(asset.path, options.sessionId);
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    const mediaType = audioTypes.get(extension);
    if (!mediaType) throw new Error(`Unsupported artifact preview asset type: ${path}`);
    const file = await realpath(artifactFileForCwd(options.cwd, path));
    const fromRoot = relative(root, file);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("Artifact preview asset escapes the artifact directory");
    const { info, digest } = await hashStableFile(file, root);
    if (asset.mediaType !== undefined && asset.mediaType !== mediaType) throw new Error("Artifact preview asset mediaType does not match its file extension");
    if (asset.bytes !== undefined && asset.bytes !== info.size) throw new Error("Artifact preview asset bytes do not match the file");
    if (asset.sha256 !== undefined && (typeof asset.sha256 !== "string" || !shaPattern.test(asset.sha256))) throw new Error("Artifact preview asset sha256 is invalid");
    if (asset.sha256 !== undefined && asset.sha256.toLowerCase() !== digest) throw new Error("Artifact preview asset sha256 does not match the file");
    output.push({ id, path: `/api/session-artifacts/${encodeURIComponent(options.sessionId)}/${path.split("/").map(encodeURIComponent).join("/")}`, mediaType, bytes: info.size, sha256: digest });
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_ARTIFACT_PREVIEW_ASSET_METADATA_BYTES) throw new Error("Artifact preview asset metadata exceeds 64 KiB");
  return output;
}
