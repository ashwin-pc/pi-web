import { parseResourceRef, type ResourceRef } from "./resourceRef.js";

export type WorkItem = ResourceRef
  | { kind: "files" | "git"; workspaceId: string }
  | { kind: "preview"; workspaceId: string; path: string }
  | { kind: "app"; sessionId: string; key: string }
  | { kind: "browser"; id: string }
  | { kind: "mcp-app"; connectionId: string; toolName: string };
export type WorkRecord = { id: string; title: string; workspaceIds: string[]; sessionIds: string[]; references: WorkItem[]; revision: number; createdAt: string; updatedAt: string };
export type WorkDraft = { resource: Extract<ResourceRef, { kind: "file" }>; version: string; text: string };
export type WorkViewContext = { workId: string; windowId: string; revision: number; readWorkspaceIds: string[]; drafts?: WorkDraft[] };
export type WorkViewCommand = { id: string; sessionId: string; context: WorkViewContext; action: "open" | "close" | "pin" | "unpin"; item: WorkItem; alongside?: boolean; createdAt: string };
export type WorkDraftCommand = { id: string; sessionId: string; context: WorkViewContext; draft: WorkDraft; mode: "replace" | "append"; createdAt: string };

export function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}
export function parseWorkItem(value: unknown): WorkItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (v.kind === "file" || v.kind === "diff") return parseResourceRef(v);
  if ((v.kind === "files" || v.kind === "git") && boundedId(v.workspaceId)) return { kind: v.kind, workspaceId: v.workspaceId };
  if (v.kind === "preview") {
    const file = parseResourceRef({ ...v, kind: "file" });
    if (file?.kind === "file" && /\.html?$/i.test(file.path)) return { kind: "preview", workspaceId: file.workspaceId, path: file.path };
  }
  if (v.kind === "app" && boundedId(v.sessionId) && boundedId(v.key)) return { kind: "app", sessionId: v.sessionId, key: v.key };
  if (v.kind === "browser" && boundedId(v.id)) return { kind: "browser", id: v.id };
  if (v.kind === "mcp-app" && boundedId(v.connectionId) && boundedId(v.toolName)) return { kind: "mcp-app", connectionId: v.connectionId, toolName: v.toolName };
}
export function workItemKey(item: WorkItem) {
  switch (item.kind) {
    case "file": case "preview": return JSON.stringify([item.kind, item.workspaceId, item.path]);
    case "diff": return JSON.stringify([item.kind, item.workspaceId, item.repo, item.path, item.staged]);
    case "files": case "git": return JSON.stringify([item.kind, item.workspaceId]);
    case "app": return JSON.stringify([item.kind, item.sessionId, item.key]);
    case "mcp-app": return JSON.stringify([item.kind, item.connectionId, item.toolName]);
    case "browser": return JSON.stringify([item.kind, item.id]);
  }
}
export function parseWorkContext(value: unknown): WorkViewContext | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (!boundedId(v.workId) || !boundedId(v.windowId) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0
    || !Array.isArray(v.readWorkspaceIds) || !v.readWorkspaceIds.length || v.readWorkspaceIds.length > 32 || !v.readWorkspaceIds.every(boundedId)) return;
  const drafts: WorkDraft[] = [];
  if (v.drafts !== undefined) {
    if (!Array.isArray(v.drafts) || v.drafts.length > 8 || JSON.stringify(v.drafts).length > 64_000) return;
    for (const raw of v.drafts) {
      const resource = parseResourceRef(raw?.resource);
      if (resource?.kind !== "file" || !v.readWorkspaceIds.includes(resource.workspaceId) || !boundedId(raw.version) || typeof raw.text !== "string") return;
      drafts.push({ resource, version: raw.version, text: raw.text });
    }
  }
  return { workId: v.workId, windowId: v.windowId, revision: Number(v.revision), readWorkspaceIds: [...new Set(v.readWorkspaceIds as string[])], drafts };
}
