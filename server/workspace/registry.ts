import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type WorkspaceDescriptor = {
  id: string;
  name: string;
  root: string;
  runtime: "local";
};

function workspaceId(root: string) {
  return `local-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

function workspaceName(root: string) {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || root;
}

/**
 * Minimal prototype registry.
 *
 * Identity is derived from the canonical local root so sessions that share a cwd
 * converge on one workspace without introducing persistence yet.
 */
export class WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceDescriptor>();

  register(root: string): WorkspaceDescriptor {
    const canonicalRoot = resolve(root);
    const id = workspaceId(canonicalRoot);
    const existing = this.byId.get(id);
    if (existing) return existing;
    const workspace = { id, name: workspaceName(canonicalRoot), root: canonicalRoot, runtime: "local" as const };
    this.byId.set(id, workspace);
    return workspace;
  }

  get(id: string | null | undefined) {
    return id ? this.byId.get(id) : undefined;
  }

  require(id: string | null | undefined) {
    const workspace = this.get(id);
    if (!workspace) throw new Error("Workspace not found");
    return workspace;
  }

  list() {
    return [...this.byId.values()];
  }
}
