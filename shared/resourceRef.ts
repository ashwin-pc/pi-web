/** Workspace owns identity; a session, selection and layout never do. */
export type ResourceRef =
  | { kind: "file"; workspaceId: string; path: string }
  | { kind: "diff"; workspaceId: string; repo: string; path: string; staged: boolean };

function relativePath(value: unknown, root = false): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\\\x00-\x1f]/.test(value) || value.startsWith("/")) return;
  const parts = value.split("/");
  if (parts.includes("..")) return;
  const path = parts.filter((part) => part && part !== ".").join("/");
  return path || (root ? "." : undefined);
}

export function parseResourceRef(value: unknown): ResourceRef | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.workspaceId !== "string" || !/^local-[a-f0-9]{16}$/.test(item.workspaceId)) return;
  const path = relativePath(item.path);
  if (!path) return;
  if (item.kind === "file") return { kind: "file", workspaceId: item.workspaceId, path };
  const repo = relativePath(item.repo, true);
  if (item.kind === "diff" && repo && typeof item.staged === "boolean") {
    return { kind: "diff", workspaceId: item.workspaceId, repo, path, staged: item.staged };
  }
}

export function resourceKey(ref: ResourceRef) {
  return JSON.stringify(ref.kind === "file" ? [ref.workspaceId, "file", ref.path] : [ref.workspaceId, "diff", ref.repo, ref.path, ref.staged]);
}

export function resourceUrl(ref: ResourceRef, base = "http://localhost/") {
  const url = new URL(base);
  url.searchParams.set("surface", ref.kind === "file" ? "files" : "git");
  url.searchParams.set("workspaceId", ref.workspaceId);
  url.searchParams.set("path", ref.path);
  url.searchParams.delete("repo"); url.searchParams.delete("staged");
  if (ref.kind === "diff") {
    url.searchParams.set("repo", ref.repo); url.searchParams.set("staged", ref.staged ? "1" : "0");
  }
  return url;
}

export function resourceFromUrl(url: URL): ResourceRef | undefined {
  const params = url.searchParams;
  const surface = params.get("surface");
  return parseResourceRef({ kind: surface === "files" ? "file" : surface === "git" ? "diff" : undefined,
    workspaceId: params.get("workspaceId"), path: params.get("path"), repo: params.get("repo") || ".", staged: params.get("staged") === "1" });
}

export type ResourceSelection = { text: string; fromLine: number; toLine: number };
export type ResourceContextAttachment = {
  type: "resource";
  id: string;
  label: string;
  title?: string;
  resource: ResourceRef;
  selection?: ResourceSelection;
};

export function parseResourceContext(value: unknown): ResourceContextAttachment | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const resource = parseResourceRef(item.resource);
  if (item.type !== "resource" || !resource || typeof item.id !== "string" || !item.id || item.id.length > 500
    || typeof item.label !== "string" || !item.label || item.label.length > 500
    || (item.title !== undefined && (typeof item.title !== "string" || item.title.length > 1000))) return;
  let selection: ResourceSelection | undefined;
  if (item.selection !== undefined) {
    if (!item.selection || typeof item.selection !== "object") return;
    const range = item.selection as Record<string, unknown>;
    if (typeof range.text !== "string" || range.text.length > 16000 || !Number.isSafeInteger(range.fromLine)
      || !Number.isSafeInteger(range.toLine) || Number(range.fromLine) < 1 || Number(range.toLine) < Number(range.fromLine)) return;
    selection = { text: range.text, fromLine: Number(range.fromLine), toLine: Number(range.toLine) };
  }
  return { type: "resource", id: item.id, label: item.label, ...(typeof item.title === "string" ? { title: item.title } : {}), resource,
    ...(selection ? { selection } : {}) };
}
