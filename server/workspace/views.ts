import { randomUUID } from "node:crypto";
import { parseWorkContext, parseWorkItem, type WorkViewContext, type WorkViewCommand, type WorkDraftCommand } from "../../shared/work.js";
import { WorkStore, WorkError } from "./workStore.js";

/** Commands are run-scoped requests. Focus/layout decisions and receipts belong to each window. */
export class WorkViews {
  private origins = new Map<string, WorkViewContext>();
  private cancelled = new Set<string>();
  private commands = new Map<string, WorkViewCommand>();
  private drafts = new Map<string, WorkDraftCommand>();
  constructor(private readonly work: WorkStore, private readonly emit: (value: Record<string, unknown>) => void,
    private readonly validateForeign?: (workId: string, item: import("../../shared/work.js").WorkItem) => Promise<void>) {}
  async capture(sessionId: string, input: unknown, running = false) {
    const context = parseWorkContext(input); if (!context) throw new WorkError("Invalid work context");
    const work = await this.work.require(context.workId);
    if (!work.sessionIds.includes(sessionId) || context.readWorkspaceIds.some(id => !work.workspaceIds.includes(id))) throw new WorkError("The conversation or read scope is outside this work", 403);
    const previous = this.origins.get(sessionId);
    if (running && previous) {
      if (previous.workId !== context.workId || previous.windowId !== context.windowId) throw new WorkError("This conversation is running in other work. Wait or choose another conversation.", 409);
      return previous;
    }
    this.cancelled.delete(sessionId); this.origins.set(sessionId, context); return context;
  }
  cancel(sessionId: string) { this.cancelled.add(sessionId); }
  async origin(sessionId: string) {
    if (this.cancelled.has(sessionId)) throw new WorkError("The run was stopped", 409);
    const origin = this.origins.get(sessionId); if (origin) return structuredClone(origin);
    const matches = (await this.work.read()).work.filter(work => work.sessionIds.includes(sessionId));
    if (matches.length !== 1) throw new WorkError("Choose a work and send the prompt from its Pi chat first");
    return { workId: matches[0].id, windowId: "unbound", revision: 0, readWorkspaceIds: [...matches[0].workspaceIds] };
  }
  async issue(sessionId: string, context: WorkViewContext, input: Record<string, unknown>) {
    if (this.cancelled.has(sessionId)) throw new WorkError("The run was stopped", 409);
    const work = await this.work.require(context.workId), item = parseWorkItem(input.item), action = input.action;
    if (!work.sessionIds.includes(sessionId) || !item || !["open", "close", "pin", "unpin"].includes(String(action))) throw new WorkError("Invalid view request");
    if ("workspaceId" in item && (!work.workspaceIds.includes(item.workspaceId) || !context.readWorkspaceIds.includes(item.workspaceId))) throw new WorkError("This file's project is outside the submitted work context", 403);
    if (item.kind === "app" && !work.sessionIds.includes(item.sessionId)) throw new WorkError("This app's conversation is outside this work", 403);
    if (item.kind === "browser" || item.kind === "mcp-app") await this.validateForeign?.(work.id, item);
    const command: WorkViewCommand = { id: randomUUID(), sessionId, context: { ...context, drafts: undefined }, item, action: action as WorkViewCommand["action"], alongside: input.alongside === true, createdAt: new Date().toISOString() };
    this.commands.set(command.id, command); if (this.commands.size > 200) this.commands.delete(this.commands.keys().next().value!);
    this.emit({ type: "work_view", command }); return command;
  }
  list() { return [...this.commands.values()].map(command => structuredClone(command)); }
  listDrafts() { return [...this.drafts.values()].map(command => structuredClone(command)); }
  async edit(sessionId: string, context: WorkViewContext, input: Record<string, unknown>) {
    if (this.cancelled.has(sessionId)) throw new WorkError("The run was stopped", 409);
    const snapshot = context.drafts?.find(draft => draft.resource.workspaceId === input.workspaceId && draft.resource.path === input.path);
    const record = await this.work.require(context.workId);
    if (!record.sessionIds.includes(sessionId) || !snapshot || !record.workspaceIds.includes(snapshot.resource.workspaceId) || typeof input.text !== "string" || input.text.length > 64_000 || !["append", "replace"].includes(String(input.mode))) throw new WorkError("Read the submitted draft first and choose its project and path");
    const command: WorkDraftCommand = { id: randomUUID(), sessionId, context: { ...context, drafts: undefined }, draft: { ...snapshot, text: input.text }, mode: input.mode as "append" | "replace", createdAt: new Date().toISOString() };
    this.drafts.set(command.id, command); if (this.drafts.size > 100) this.drafts.delete(this.drafts.keys().next().value!);
    this.emit({ type: "work_draft", command }); return command;
  }
}
