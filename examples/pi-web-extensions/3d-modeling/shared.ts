import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function esc(value: unknown) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

export function errorView(title: string, detail: string) {
  return { html: `<!doctype html><meta name="color-scheme" content="dark"><style>body{margin:0;padding:32px;background:#0b1020;color:#dbe5ff;font:14px system-ui}.box{max-width:620px;margin:auto;padding:24px;border:1px solid #293653;border-radius:16px;background:#121a2c}h2{margin:0 0 8px;color:#fff}p{color:#9eacc8;line-height:1.5}</style><div class="box"><h2>${esc(title)}</h2><p>${esc(detail)}</p></div>` };
}

export function artifactRelativeFromUrl(urlPath: string) {
  const clean = urlPath.split(/[?#]/, 1)[0];
  let encoded: string | undefined;
  if (clean.startsWith("/api/artifacts/")) encoded = clean.slice(15);
  else if (clean.startsWith("/api/session-artifacts/")) {
    const rest = clean.slice(23); const slash = rest.indexOf("/");
    if (slash >= 0) encoded = rest.slice(slash + 1);
  }
  if (!encoded) throw new Error("Only pi-web artifact URLs can be opened.");
  try { return safeRelativePath(decodeURIComponent(encoded)); }
  catch (error) { if (error instanceof URIError) throw new Error("The artifact URL is malformed."); throw error; }
}

function safeRelativePath(input: string) {
  const rel = input.replaceAll("\\", "/");
  if (!rel || rel.includes("\0") || isAbsolute(rel) || rel.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Unsafe artifact path.");
  return rel;
}

async function artifactRoot(cwd: string) {
  const configured = join(cwd, ".pi", "web", "artifacts");
  await mkdir(configured, { recursive: true });
  return realpath(configured);
}

function contained(root: string, candidate: string, message: string) {
  const rel = relative(root, candidate);
  if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error(message);
}

export async function resolveArtifactRead(cwd: string, input: string, extension: string, maxBytes: number, kind: string) {
  const rel = safeRelativePath(input);
  if (!rel.toLowerCase().endsWith(extension)) throw new Error(`${kind} input must end in ${extension}.`);
  const root = await artifactRoot(cwd);
  const candidate = resolve(root, rel);
  contained(root, candidate, "Artifact escapes the project artifact directory.");
  const actual = await realpath(candidate);
  contained(root, actual, "Artifact symlink escapes the project artifact directory.");
  const stat = await lstat(actual);
  if (!stat.isFile()) throw new Error("Artifact is not a regular file.");
  if (stat.size > maxBytes) throw new Error(`${kind} is too large (${Math.ceil(stat.size / 1048576)} MB).`);
  return { path: actual, relative: rel, size: stat.size };
}

export async function resolveArtifactWrite(cwd: string, input: string, extension: string) {
  const rel = safeRelativePath(input);
  if (!rel.toLowerCase().endsWith(extension)) throw new Error(`Output must end in ${extension}.`);
  const root = await artifactRoot(cwd);
  const candidate = resolve(root, rel);
  contained(root, candidate, "Artifact escapes the project artifact directory.");
  await mkdir(dirname(candidate), { recursive: true });
  const parent = await realpath(dirname(candidate));
  contained(root, parent, "Artifact parent symlink escapes the project artifact directory.");
  return { path: candidate, relative: rel, url: `/api/artifacts/${rel.split("/").map(encodeURIComponent).join("/")}` };
}

export async function artifactFile(cwd: string, urlPath: string, maxBytes: number, kind: string, maxMb: number) {
  const rel = artifactRelativeFromUrl(urlPath);
  try { return (await resolveArtifactRead(cwd, rel, "", maxBytes, kind)).path; }
  catch (error) {
    if (error instanceof Error && error.message.startsWith(`${kind} is too large`)) throw new Error(`${kind} is too large (${Math.ceil((await lstat(resolve(await artifactRoot(cwd), safeRelativePath(rel)))).size / 1048576)} MB; limit is ${maxMb} MB).`);
    throw error;
  }
}
