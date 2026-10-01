import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedId, parseWorkItem, workItemKey, type WorkRecord, type WorkItem } from "../../shared/work.js";
import { WorkspaceRegistry, type WorkspaceDescriptor } from "./registry.js";

export class WorkError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
type Catalogue = { version: 1; workspaces: WorkspaceDescriptor[]; work: WorkRecord[] };
export class WorkStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cached?: Catalogue;
  constructor(private readonly file: string, private readonly registry: WorkspaceRegistry) {}
  async read(): Promise<Catalogue> {
    if (!this.cached) {
      try {
        const data = JSON.parse(await readFile(this.file, "utf8")) as Catalogue;
        if (data.version !== 1 || !Array.isArray(data.workspaces) || !Array.isArray(data.work)) throw new Error("Unsupported or invalid work catalogue");
        for (const workspace of data.workspaces) {
          if (typeof workspace.root !== "string" || this.registry.register(workspace.root).id !== workspace.id) throw new Error("Invalid workspace identity in work catalogue");
        }
        for (const work of data.work) {
          if (!boundedId(work.id) || !work.title?.trim() || !Number.isSafeInteger(work.revision) || !Array.isArray(work.workspaceIds) || !work.workspaceIds.length || work.workspaceIds.some(id => !this.registry.get(id)) || !Array.isArray(work.sessionIds) || !work.sessionIds.every(boundedId)) throw new Error("Invalid work record");
          work.references = this.references(work.references || [], work.workspaceIds, work.sessionIds);
        }
        this.cached = data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.cached = { version: 1, workspaces: [], work: [] };
      }
    }
    return structuredClone(this.cached);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  private async write(data: Catalogue) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.file); this.cached = structuredClone(data);
  }
  register(workspace: WorkspaceDescriptor) {
    return this.serial(async () => { const data = await this.read(); if (!data.workspaces.some(w => w.id === workspace.id)) { data.workspaces.push(workspace); await this.write(data); } return workspace; });
  }
  private fields(input: unknown) {
    if (!input || typeof input !== "object") throw new WorkError("Work details are required");
    const v = input as Partial<WorkRecord>;
    const title = typeof v.title === "string" ? v.title.trim() : "";
    if (!title || title.length > 160) throw new WorkError("Give this work a name of up to 160 characters");
    if (!Array.isArray(v.workspaceIds) || !v.workspaceIds.length || v.workspaceIds.length > 32 || v.workspaceIds.some(id => !this.registry.get(id))) throw new WorkError("Choose known projects for this work");
    if (!Array.isArray(v.sessionIds) || v.sessionIds.length > 100 || !v.sessionIds.every(boundedId)) throw new WorkError("Invalid conversation references");
    return { title, workspaceIds: [...new Set(v.workspaceIds)], sessionIds: [...new Set(v.sessionIds)], references: this.references(v.references || [], v.workspaceIds, v.sessionIds) };
  }
  private references(input: unknown, roots: string[], sessions: string[]) {
    if (!Array.isArray(input) || input.length > 200) throw new WorkError("Work can keep up to 200 references");
    const refs = new Map<string, WorkItem>();
    for (const value of input) { const item = parseWorkItem(value); if (!item || item.kind === "browser" || ("workspaceId" in item && !roots.includes(item.workspaceId)) || (item.kind === "app" && !sessions.includes(item.sessionId))) throw new WorkError("Invalid or unowned work reference"); refs.set(workItemKey(item), item); }
    return [...refs.values()];
  }
  create(input: unknown) {
    return this.serial(async () => {
      const fields = this.fields(input), data = await this.read(), time = new Date().toISOString();
      const work: WorkRecord = { ...fields, id: randomUUID(), revision: 0, createdAt: time, updatedAt: time };
      for (const id of fields.workspaceIds) if (!data.workspaces.some(w => w.id === id)) data.workspaces.push(this.registry.require(id));
      data.work.push(work); await this.write(data); return work;
    });
  }
  patch(id: string, changes: unknown, expectedRevision: unknown) {
    return this.serial(async () => {
      const data = await this.read(), index = data.work.findIndex(work => work.id === id);
      if (index < 0) throw new WorkError("Work not found", 404);
      const previous = data.work[index];
      if (expectedRevision !== previous.revision) throw new WorkError("This work changed in another window. Refresh and try again.", 409);
      const fields = this.fields({ ...previous, ...(changes as object) });
      const work = { ...previous, ...fields, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      data.work[index] = work;
      for (const root of fields.workspaceIds) if (!data.workspaces.some(w => w.id === root)) data.workspaces.push(this.registry.require(root));
      await this.write(data); return work;
    });
  }
  async require(id: string) { const work = (await this.read()).work.find(work => work.id === id); if (!work) throw new WorkError("Work not found", 404); return work; }
}
