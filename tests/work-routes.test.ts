import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkRecord } from "../shared/work.js";
import { handleWorkRoute } from "../server/workspace/routes.js";
import { WorkspaceRegistry } from "../server/workspace/registry.js";
import { WorkStore, WorkError } from "../server/workspace/workStore.js";
import { WorkViews } from "../server/workspace/views.js";
import { WorkspaceBrowser } from "../server/workspace/browser.js";
import { WorkspaceMcp } from "../server/workspace/mcp.js";

it("work edits prune deleted conversations while retaining other projects and reject invalid new members", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-work-routes-"));
  const registry = new WorkspaceRegistry(), root = registry.register(dir), foreign = registry.register(join(dir, "other"));
  const store = new WorkStore(join(dir, "work.json"), registry), views = new WorkViews(store, () => undefined);
  const browser = new WorkspaceBrowser(), mcp = new WorkspaceMcp(join(dir, "mcp.json"), () => undefined);
  try {
    const file = { kind: "file", workspaceId: root.id, path: "note.md" };
    const app = { kind: "app", sessionId: "live", key: "chart" };
    const record = await store.create({ title: "Release", workspaceIds: [root.id], sessionIds: ["deleted", "live"], references: [file, app, { kind: "app", sessionId: "deleted", key: "old" }] });
    const patch = async (changes: Record<string, unknown>) => {
      let result: { status: number; data: { work?: WorkRecord } } | undefined;
      await handleWorkRoute({ method: "PATCH" } as IncomingMessage, {} as ServerResponse, new URL(`http://localhost/api/work/${record.id}`), {
        store, registry, views, browser, mcp, defaultRoot: () => dir, refreshRoots: () => undefined,
        sessionRoot: async id => { if (id === "foreign") return foreign.root; if (id !== "live") throw new WorkError("Session not found", 404); return dir; },
        readBody: async () => changes, send: (_res, status, data) => { result = { status, data: data as { work?: WorkRecord } }; },
      });
      return result!;
    };
    const updated = await patch({ title: "Continue release", expectedRevision: record.revision });
    expect(updated.status).toBe(200);
    expect(updated.data.work).toMatchObject({ title: "Continue release", sessionIds: ["live"], references: [file, app], revision: 1 });
    expect((await patch({ title: "Stale", expectedRevision: 0 })).status).toBe(409);
    expect((await patch({ sessionIds: ["live", "unknown"], expectedRevision: 1 })).status).toBe(404);
    expect((await patch({ sessionIds: ["foreign"], expectedRevision: 1 })).status).toBe(400);
    expect((await patch({ references: [{ kind: "app", sessionId: "unknown", key: "unowned" }], expectedRevision: 1 })).status).toBe(400);
    expect((await store.require(record.id)).title).toBe("Continue release");
  } finally { await browser.dispose(); await mcp.dispose(); await rm(dir, { recursive: true, force: true }); }
});
