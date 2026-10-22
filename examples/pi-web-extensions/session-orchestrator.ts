/**
 * session-orchestrator — experimental pi-web extension
 *
 * Gives every pi-web session the same orchestration verbs a human has in the
 * UI: spawn sibling sessions, check on them, steer or interrupt them, and abort
 * them. Workers are ordinary first-class pi-web sessions (full history, visible
 * in the sidebar, resumable). Core supplies sessions_read for transcript inspection.
 *
 * Wakeups: after spawning/prompting a worker, the parent does NOT block. A
 * background watcher (plain JS polling — zero tokens) injects a user message
 * into the parent session when a worker goes idle, which starts a new parent
 * turn. The parent can end its turn and "sleep" while workers run. Wakeups go to
 * the active parent branch; pending batches retain immutable assignment ownership.
 * Registered SDK commands/templates/skills are rejected before interrupt or dispatch;
 * path-led and unknown slash literals remain ordinary tracked tasks.
 *
 * Everything goes through the same local HTTP API the web UI uses.
 *
 * Reversible install: this lives at .pi/web/extensions/session-orchestrator.ts —
 * delete that file (and ~/.pi/agent/skills/session-orchestration/) to remove
 * the feature entirely. No AGENTS.md changes; matching host APIs are required.
 */

import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebSettingsSchema, PiWebHttpClient } from "@ashwin-pc/pi-web/extensions";

const WORKER_MARKER = "[pi-web orchestrated worker]";
const EXT_VERSION = "v9";
const WAKEUP_CUSTOM_TYPE = "session-orchestrator";
// Durable watch ledger: appended to the parent's session file so a freshly
// re-materialized parent (server restart, /reload, idle disposal) can re-arm
// its watchers or deliver catch-up wakeups. The external journal is authoritative:
// appendEntry may defer disk writes until the parent's first assistant message.
// Resolved means the host confirmed the completion message was saved to JSONL.
const WATCH_ENTRY = "orchestrator-watch";
const RESOLVED_ENTRY = "orchestrator-watch-resolved";
const MAX_WORKERS = 4;
const POLL_MS = 2500;
const WAKEUP_SUMMARY_CHARS = 2000;
const MAX_TRANSCRIPT_FAILURES = 20;
const MAX_MISSING_MARKER_POLLS = 12;
// At most three 2,000-character reports plus bounded headers/status prose.
const WAKEUP_BATCH_CHARS = 8000;
const WAKEUP_BATCH_WORKERS = Math.floor((WAKEUP_BATCH_CHARS - 2000) / WAKEUP_SUMMARY_CHARS);

// Generic extension-settings schema: user-authored worker model categories.
// The `description` prose IS the routing guidance the orchestrator reads; the
// concrete model stays private to config (never shown to the LLM). Empty config
// is a virtual, unwritten "Default" resolved live to the worker's own model.
const SETTINGS_ID = "session-orchestrator.workerModelCategories";
const SETTINGS_SCHEMA: PiWebSettingsSchema = {
  id: SETTINGS_ID,
  title: "Worker model categories",
  schemaVersion: 1,
  fields: [
    {
      key: "categories",
      type: "list",
      label: "Categories",
      description:
        'Named model tiers the orchestrator can spawn workers on. Write the "When to use" prose as absolute guidance — it is the routing policy.',
      minItems: 0,
      maxItems: 4,
      itemFields: [
        { key: "name", type: "text", label: "Name", required: true, maxLength: 24, uniqueCaseInsensitive: true },
        { key: "model", type: "select", label: "Model", optionsSource: "models", required: true },
        { key: "description", type: "textarea", label: 'When to use', maxLength: 400 },
      ],
    },
    {
      key: "defaultCategory",
      type: "select",
      label: "Default category",
      description: "Used when a spawn omits an explicit category.",
      optionsFromField: "categories.name",
    },
  ],
};

// ---------------------------------------------------------------------------
// Global helpers: token parsing, resolution
// ---------------------------------------------------------------------------

/** Parse "<provider>:<id>" into { provider, id }. Split on FIRST colon only. */
export function parseToken(token: string): { provider: string; id: string } | null {
  const idx = token.indexOf(":");
  if (idx < 0) return null;
  return { provider: token.slice(0, idx), id: token.slice(idx + 1) };
}

/** Determine if normalized id base matches (Bedrock inference-profile case). */
export function normalizeBedrockId(id: string): string {
  // Extract base (e.g. "us.amazon.nova-2-lite-v1" from "us.amazon.nova-2-lite-v1:0")
  return id.split(":")[0];
}

/** Resolution order per Amendment 6. Returns { match, substituted }. */
export function resolveModel(
  canonicalToken: string,
  registryModels: any[],
  parentRegionPrefix: string,
): { match: any; substituted: boolean } | null {
  const canonical = parseToken(canonicalToken);
  if (!canonical) return null;

  const { provider, id } = canonical;

  // 1. Exact {provider, id} match.
  const exact = registryModels.find((m: any) => m.provider === provider && m.id === id);
  if (exact) return { match: exact, substituted: false };

  // 2. For an unprefixed configured id only, add the parent's region prefix
  // (Bedrock inference-profile case). An explicit configured region is a
  // residency choice and must never be silently replaced with another one.
  const baseId = normalizeBedrockId(id);
  if (parentRegionPrefix && !/^(us|eu|au|apac|global)\./.test(baseId)) {
    const withPrefix = parentRegionPrefix + baseId;
    const candidate = registryModels.find(
      (m: any) => m.provider === provider && normalizeBedrockId(m.id) === normalizeBedrockId(withPrefix),
    );
    if (candidate) return { match: candidate, substituted: true };
  }

  // 3. Else failure.
  return null;
}

// ---------------------------------------------------------------------------
// Small HTTP client for the pi-web API (same API the browser UI uses)
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function admissionRejected(error: unknown): boolean {
  // Transport/gateway failures may arrive after the task was accepted.
  return error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
}

function trunc(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

/** Generic pi-web custom-message presentation metadata; semantics stay here. */
function reportPresentation(label: string, preview: string, tone: "accent" | "danger" = "accent") {
  return { kind: "expandable-report", label, preview: trunc(preview, 320), tone };
}

// ---------------------------------------------------------------------------
// Transcript helpers (uses /api/messages simplified message shape)
// ---------------------------------------------------------------------------

type WorkerReport = { text: string; isError: boolean; outcome: "finished" | "failed" | "interrupted" | "report unavailable"; entryId?: string; attributionUnavailable?: boolean };

/** Classify the last activity, never an earlier assistant's optimistic prose. */
export function workerReport(messages: any[] | null): WorkerReport {
  if (messages === null) return { text: "Transcript could not be read; the watch remains open for retry.", isError: false, outcome: "report unavailable" };
  // Extension notes and compaction metadata are not worker activity. Keep the
  // actual reply's entry ID, but never scan past new user/tool/bash activity.
  const m = messages.slice().reverse().find((message) => !["custom", "system", "compactionSummary"].includes(message?.role));
  const text = typeof m?.text === "string" ? m.text.trim() : "";
  const reason = m?.raw?.stopReason ?? m?.stopReason;
  // A failed assistant stream can contain partial tool calls. Its terminal
  // error takes precedence over those calls, but an explicit abort does not.
  const terminalError = m?.role === "assistant" && (m?.isError || reason === "error");
  const interrupted = m?.role !== "assistant" || m?.toolCalls?.length > 0 || ["toolUse", "pending", "deferred"].includes(reason);
  const outcome = reason === "aborted" ? "interrupted" : terminalError ? "failed" : interrupted ? "interrupted" : text ? "finished" : "interrupted";
  return { text: text || "No terminal assistant reply; last activity: " + (m?.role || "empty transcript"), isError: outcome === "failed", outcome, entryId: m?.entryId };
}

export function formatWorkerReport(report: WorkerReport, sessionId: string, max = WAKEUP_SUMMARY_CHARS): string {
  if (report.text.length <= max) return report.text;
  // /api/messages supplies persisted entryId. Never invent a final-entry link.
  const link = report.entryId
    ? `/?sessionId=${encodeURIComponent(sessionId)}&entryId=${encodeURIComponent(report.entryId)}`
    : `/?sessionId=${encodeURIComponent(sessionId)}`;
  const footer = report.entryId
    ? `\nReport truncated, full final message: ${link}.`
    : `\nReport truncated; final entry link unavailable. Session: ${link}.`;
  const remaining = Math.max(0, max - footer.length - 3);
  const head = Math.ceil(remaining / 2);
  return `${report.text.slice(0, head)}\n…\n${report.text.slice(-(remaining - head))}${footer}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sessionOrchestrator(pi: PiWebExtensionAPI) {
  let client: PiWebHttpClient | undefined;
  async function api(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
    if (!client) throw new Error("Session orchestration requires pi-web's scoped extension HTTP API; update pi-web and reload extensions.");
    const res = await client.request(method, path, { body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) throw new ApiError(`${method} ${path} failed (${res.status}): ${json?.error || "unknown error"}`, res.status);
    return json;
  }
  async function fetchMessages(sessionId: string, dispatchId?: string): Promise<any[]> {
    const path = dispatchId
      ? `/api/session/history?sessionId=${encodeURIComponent(sessionId)}&dispatchId=${encodeURIComponent(dispatchId)}`
      : `/api/messages?sessionId=${encodeURIComponent(sessionId)}`;
    const json = await api("GET", path);
    if (!Array.isArray(json.messages)) throw new Error("Transcript response did not contain messages");
    return json.messages;
  }
  async function checkTrackedMessage(sessionId: string, message: string): Promise<void> {
    if (!/^\s*\//.test(message)) return;
    // Read the target's current registry, not this extension's parent registry.
    // Web-only commands are interpreted by the browser, not SDK prompt().
    const { commands } = await api("GET", `/api/commands?sessionId=${encodeURIComponent(sessionId)}`);
    if (!Array.isArray(commands) || commands.some((command: any) =>
      !command || typeof command.name !== "string" || !command.name ||
      !["web", "extension", "prompt", "skill"].includes(command.source))) {
      throw new Error("Cannot validate tracked slash input: command metadata unavailable; no task was sent.");
    }
    // Paired with LocalSessionService.prompt() in server/session/service.ts;
    // this standalone example cannot import server code. Keep both in sync with
    // SDK-parse parity cases in tests/session-delivery.test.ts and tests/session-orchestrator.test.ts.
    // Mirror SDK parsing without trimming or rewriting the user's input:
    // extensions/skills split at ASCII space; templates accept any whitespace.
    if (!message.startsWith("/")) return;
    const spaceIndex = message.indexOf(" ");
    const commandName = message.slice(1, spaceIndex === -1 ? undefined : spaceIndex);
    const templateName = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)?.[1];
    if (commands.some((command: any) =>
      command.source === "prompt" ? command.name === templateName :
        (command.source === "extension" || command.source === "skill") && command.name === commandName)) {
      throw new Error("Tracked registered slash commands/templates/skills are unsupported; send a natural-language task instead.");
    }
  }
  type Watched = {
    id: string;
    name: string;
    categoryName: string;
    sawRunning: boolean;
    idlePolls: number;
    errorPolls: number;
    aborted: boolean;
    unavailableReported?: boolean;
    transcriptFailures: number;
    watchId: string;
    spawned?: boolean;
    dispatchId?: string;
    admissionPending?: boolean;
    fingerprint?: string;
  };
  type Pending = { deliveryId: string; members: { id: string; watchId: string; resolves: boolean }[]; message: { customType: string; content: string; display: boolean; details: Record<string, unknown> } };
  type Journal = { version: 1; watches: Watched[]; pending: Pending[] };
  let pending: Pending[] = [];
  const dispatching = new Set<string>();
  const dispatchQueues = new Map<string, Promise<unknown>>();
  function journalPath(): string {
    const directory = process.env.PI_WEB_ORCHESTRATOR_STATE_DIR || join(homedir(), ".pi", "agent", "orchestrator-state");
    return join(directory, `${encodeURIComponent(selfSessionId)}.json`);
  }
  function persist() {
    const path = journalPath();
    if (!watched.size && !pending.length) {
      try { unlinkSync(path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, watches: [...watched.values()], pending } satisfies Journal));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, path);
      // Windows does not consistently permit opening/fsyncing directories.
      // Only that unsupported durability enhancement may be skipped there;
      // file write/fsync/rename failures always fail closed.
      let directoryFd: number | undefined;
      try {
        directoryFd = openSync(dirname(path), "r");
        fsyncSync(directoryFd);
      } catch (error: any) {
        if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES", "EBADF"].includes(error?.code)) throw error;
      } finally { if (directoryFd !== undefined) closeSync(directoryFd); }
    } finally { try { unlinkSync(temp); } catch {} }
  }
  function current(w: Watched): boolean { return watched.get(w.id)?.watchId === w.watchId && !dispatching.has(w.id) && !dispatchQueues.has(w.id); }

  const watched = new Map<string, Watched>();
  // The spawn cap applies only to workers created by sessions_spawn. Sessions
  // added to the watcher by sessions_prompt do not consume spawn capacity.
  const spawnedWorkers = new Set<string>();
  let reservedSpawnSlots = 0;
  let cachedConfig: { categories: any[]; defaultCategory: string } = { categories: [], defaultCategory: "" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  let selfSessionId = "";
  let reportSettlementDependencies: ((dependencies: { sessionIds: string[] }) => void) | undefined;
  let disposed = false;
  let generation = 0;

  function isActive(expectedGeneration = generation): boolean {
    return !disposed && generation === expectedGeneration;
  }

  // Capture our own session id whenever context is available; wakeups use the
  // host completion route, which works when the parent is idle or mid-turn.
  function captureSelf(ctx: PiWebExtensionContext) {
    if (!client && !disposed) client = ctx.ui?.web?.createApiClient?.({
      name: "session-orchestrator",
      scopes: ["sessions.read", "sessions.create", "sessions.write", "sessions.delete"],
      // The existing tools deliberately accept arbitrary user-selected sessions,
      // including restored workers; cross-session access is explicit, not implicit.
      sessionIds: "all",
    });
    const id = ownSessionId(ctx);
    if (id && id !== "unknown") selfSessionId = id;
    const reporter = ctx?.ui?.web?.reportSettlementDependencies;
    if (typeof reporter === "function") reportSettlementDependencies = reporter.bind(ctx.ui.web);
  }

  function reportWatchedDependencies() {
    reportSettlementDependencies?.({ sessionIds: [...new Set([...watched.keys(), ...pending.flatMap((p) => p.members.map((m) => m.id))])] });
  }

  function isWorkerSession(ctx: PiWebExtensionContext): boolean {
    try {
      const entries = ctx.sessionManager?.getBranch?.() || [];
      for (const entry of entries) {
        if (entry?.type !== "message") continue;
        const message = entry.message;
        if (message?.role !== "user") continue;
        const content = message.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => (part?.type === "text" ? part.text : "")).join(" ")
            : "";
        return text.includes(WORKER_MARKER);
      }
    } catch {
      // If we cannot tell, err on the side of allowing.
    }
    return false;
  }

  function ownSessionId(ctx: PiWebExtensionContext): string {
    try {
      return String(ctx.sessionManager?.getSessionId?.() ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  function ownCwd(ctx: PiWebExtensionContext): string | undefined {
    try {
      const cwd = ctx.sessionManager?.getCwd?.();
      return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  function ensureTimer() {
    if (!isActive() || timer || (watched.size === 0 && pending.length === 0)) return;
    const timerGeneration = generation;
    timer = setInterval(() => {
      if (isActive(timerGeneration)) void poll(timerGeneration);
    }, POLL_MS);
  }

  function stopTimerIfIdle() {
    if (timer && watched.size === 0 && pending.length === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function watch(id: string, name: string, categoryName = "Unknown", dispatchId?: string, admissionPending = false) {
    if (!isActive()) return;
    const previous = watched.get(id);
    watched.set(id, { id, name: trunc(name, 80), categoryName, dispatchId, admissionPending, spawned: spawnedWorkers.has(id), watchId: randomUUID(), sawRunning: false, idlePolls: 0, errorPolls: 0, aborted: false, transcriptFailures: 0 });
    try { persist(); }
    catch (error) { if (previous) watched.set(id, previous); else watched.delete(id); throw error; }
    reportWatchedDependencies();
    ensureTimer();
  }

  function trackTranscriptReport(w: Watched, summary: WorkerReport): WorkerReport {
    if (summary.outcome !== "report unavailable") {
      w.transcriptFailures = 0;
      return summary;
    }
    w.transcriptFailures += 1;
    if (w.transcriptFailures >= MAX_TRANSCRIPT_FAILURES) {
      return { ...summary, text: `Transcript unavailable after ${MAX_TRANSCRIPT_FAILURES} failed fetches; automatic retries stopped and this watch is being released. Inspect the worker with sessions_read using id "${w.id}" or [open its session](/?sessionId=${encodeURIComponent(w.id)}).` };
    }
    return summary;
  }

  function unwatch(id: string) {
    watched.delete(id);
    spawnedWorkers.delete(id);
    reportWatchedDependencies();
    stopTimerIfIdle();
  }

  function appendLedger(customType: string, childId: string, name?: string, categoryName?: string, spawned?: boolean) {
    try {
      pi.appendEntry(customType, { childId, ...(watched.get(childId) ? { watchId: watched.get(childId)!.watchId, dispatchId: watched.get(childId)!.dispatchId } : {}), ...(name ? { name } : {}), ...(categoryName ? { categoryName } : {}), ...(spawned !== undefined ? { spawned } : {}) });
    } catch (error) {
      console.error(`[session-orchestrator] could not append ${customType} entry: ${error instanceof Error ? error.message : error}`);
    }
  }

  function markChildRead(childId: string) {
    api("POST", "/api/session-ui-state/read", { sessionId: childId })
      .catch((error) => console.error(`[session-orchestrator] could not mark child read: ${error instanceof Error ? error.message : error}`));
  }

  async function cleanupCreatedSession(sessionId: string): Promise<boolean> {
    try {
      await api("POST", "/api/sessions/delete", { sessionId });
      return true;
    } catch (error) {
      console.error(`[session-orchestrator] could not clean up worker ${sessionId}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  function cleanupReport(sessionId: string, cleanedUp: boolean): string {
    return cleanedUp
      ? `Session ${sessionId} was created but then deleted (no orphan).`
      : `Session ${sessionId} could not be deleted and may remain — please remove it.`;
  }

  function outstandingWatches(ctx: any): Map<string, { name: string; categoryName: string; spawned: boolean }> {
    const watches = new Map<string, { name: string; categoryName: string; spawned: boolean }>();
    try {
      for (const entry of ctx.sessionManager?.getBranch?.() || []) {
        if (entry?.type !== "custom") continue;
        const childId = typeof entry.data?.childId === "string" ? entry.data.childId : "";
        if (!childId) continue;
        if (entry.customType === WATCH_ENTRY) {
          watches.set(childId, {
            name: typeof entry.data?.name === "string" ? entry.data.name : childId.slice(-8),
            categoryName: typeof entry.data?.categoryName === "string" ? entry.data.categoryName : "Unknown",
            // Legacy entries did not distinguish spawn from prompt watches;
            // count them conservatively until a new typed entry is written.
            spawned: typeof entry.data?.spawned === "boolean" ? entry.data.spawned : true,
          });
        }
        else if (entry.customType === RESOLVED_ENTRY) watches.delete(childId);
      }
    } catch (error) {
      console.error(`[session-orchestrator] could not read watch ledger: ${error instanceof Error ? error.message : error}`);
    }
    return watches;
  }

  // =========================================================================
  // Tool builder and settings registration
  // =========================================================================

  function buildSpawnTool(ctx: PiWebExtensionContext): any {
    let description = [
      "Spawn a new pi-web worker session and give it a task. The worker runs in the background as a normal, fully visible pi-web session.",
      "Returns immediately with the worker's session id. When the worker goes idle you will receive a '🔔 [orchestrator]' user message containing its final output — do NOT poll for completion; do other, non-overlapping work or end your turn and wait.",
      "Do not redo what you just delegated: after spawning, use judgement about whether you need to do work yourself at all. Doing it yourself is right when you need the answer to plan the next step, when the worker may fail or is slow and the check is cheap, or when there is genuinely complementary work (design, drafting, scaffolding, verifying a worker's claims). Otherwise end your turn — idling costs nothing and keeps the noisy exploration out of your context.",
      "Write the task so it is self-contained (the worker has none of your context): include relevant file paths, constraints, and what evidence to report back (diffs, test output, findings with file:line).",
    ];

    let categoryDescription = "";
    let hasConfig = false;
    {
      const values = cachedConfig || { categories: [], defaultCategory: "" };
      const categories = Array.isArray(values.categories) ? values.categories : [];
      const defaultCategory = values.defaultCategory || "";
      if (categories.length > 0) {
        hasConfig = true;
        const categoryLines: string[] = [];
        for (const cat of categories) {
          if (cat && typeof cat === "object") {
            const name = String(cat.name || "").trim();
            const desc = String(cat.description || "").trim();
            const isDefault = name === defaultCategory ? " (default)" : "";
            const line = desc ? `• **${name}**${isDefault}: ${desc}` : `• **${name}**${isDefault}`;
            categoryLines.push(line);
          }
        }
        if (categoryLines.length > 0) {
          categoryDescription = `Configured categories:\n${categoryLines.join("\n")}`;
        }
      }
    }

    if (!hasConfig) {
      categoryDescription = "No categories are configured. The worker will use the session's default model. Configure categories in extension settings to choose specific models.";
    }

    description.push("");
    description.push(categoryDescription);

    const parameterDescription =
      "Category name (from settings) that selects the worker's model. Defaults to the configured default category, or the session default if no config exists. Unknown category → error, nothing created; valid names are listed in the tool description.";

    return {
      name: "sessions_spawn",
      label: "Spawn worker session",
      description: description.join(" "),
      promptSnippet: "Spawn a background worker session for a delegated task; completion arrives as a wakeup message",
      promptGuidelines: [
        "Use sessions_spawn to delegate noisy or parallelizable work (exploration, running tests, an isolated implementation step) to a worker session instead of doing it inline. After spawning, either do complementary work that does not duplicate what you delegated, or end your turn — a wakeup message arrives when the worker is done. Use judgement: re-doing a worker's task yourself is only worth it when you need the result to proceed, or the check is cheap and the worker may be wrong.",
      ],
      parameters: Type.Object({
        name: Type.String({ description: "Short human-readable worker name, e.g. 'scout: auth flow' or 'fix lint'" }),
        task: Type.String({ description: "Self-contained task prompt for the worker, including what to report back" }),
        cwd: Type.Optional(Type.String({ description: "Working directory for the worker (defaults to this session's cwd)" })),
        category: Type.Optional(Type.String({ description: parameterDescription })),
      }),
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: PiWebExtensionContext) => {
        const result = await (async () => {
        if (isWorkerSession(ctx)) {
          return {
            content: [
              {
                type: "text",
                text: "Refused: this session is itself an orchestrated worker (depth cap is 1). Report back to your parent instead of spawning sub-workers.",
              },
            ],
            isError: true,
            details: {},
          };
        }
        const spawnSlotsInUse = spawnedWorkers.size + reservedSpawnSlots;
        if (spawnSlotsInUse >= MAX_WORKERS) {
          return {
            content: [{ type: "text", text: `Refused: already running or starting ${spawnSlotsInUse} spawned workers (spawn cap ${MAX_WORKERS}; sessions watched after sessions_prompt do not count). Wait for a wakeup or abort one first.` }],
            isError: true,
            details: {},
          };
        }

        // Reserve synchronously, before category/settings/API awaits, so
        // concurrent tool calls cannot all pass the cap check.
        reservedSpawnSlots += 1;
        try {
        const spawnGeneration = generation;
        const parentId = ownSessionId(ctx);
        const parentCwd = ownCwd(ctx);

        // ====================================================================
        // Phase 1: Resolve category → canonical {provider, id} from config
        // ====================================================================

        let resolvedToken: { provider: string; id: string } | null = null;
        const explicitCategory = typeof params.category === "string" && params.category.trim().length > 0;
        let categoryName = explicitCategory ? params.category.trim() : "";
        let validCategories: string[] = [];

        try {
          const web = ctx?.ui?.web;
          const settings = web?.getSettings ? await web.getSettings(SETTINGS_ID) : null;
          if (settings && typeof settings === "object") {
            const values = settings.values || {};
            cachedConfig = { categories: Array.isArray(values.categories) ? values.categories : [], defaultCategory: String(values.defaultCategory || "") };
            const categories = Array.isArray(values.categories) ? values.categories : [];
            const defaultCategory = String(values.defaultCategory || "");

            for (const cat of categories) {
              if (cat && typeof cat === "object" && cat.name) validCategories.push(String(cat.name));
            }

            // An explicit category must resolve even when the configured list
            // is empty. Only an omitted category gets the virtual Default.
            if (categories.length === 0) {
              if (explicitCategory) {
                return {
                  content: [{ type: "text", text: `ERROR: category "${categoryName}" not found. Valid categories: (none configured)` }],
                  isError: true,
                  details: { validCategories, categoryName },
                };
              }
              categoryName = "Default";
            } else {
              if (!categoryName) categoryName = defaultCategory;
              if (!categoryName) {
                return {
                  content: [{ type: "text", text: `ERROR: category omitted and no default is configured. Valid categories: ${validCategories.join(", ") || "(none configured)"}. Set a default in extension settings or pass an explicit category name.` }],
                  isError: true,
                  details: { validCategories },
                };
              }

              const matching = categories.find(
                (cat: any) => cat && typeof cat === "object" && cat.name && String(cat.name).toLowerCase() === String(categoryName).toLowerCase(),
              );
              if (!matching || !matching.model) {
                return {
                  content: [{ type: "text", text: `ERROR: category "${categoryName}" not found or has no model configured. Valid categories: ${validCategories.join(", ") || "(none configured)"}` }],
                  isError: true,
                  details: { validCategories, categoryName },
                };
              }

              resolvedToken = parseToken(String(matching.model));
              if (!resolvedToken) {
                return {
                  content: [{ type: "text", text: `ERROR: the model configured for category "${categoryName}" is malformed. Check extension settings. Valid categories: ${validCategories.join(", ") || "(none configured)"}` }],
                  isError: true,
                  details: { validCategories },
                };
              }
            }
          } else if (explicitCategory) {
            return {
              content: [{ type: "text", text: `ERROR: category "${categoryName}" cannot be resolved because category settings are unavailable. Valid categories: (none configured)` }],
              isError: true,
              details: { validCategories, categoryName },
            };
          } else {
            categoryName = "Default";
          }
        } catch (error) {
          if (explicitCategory) {
            return {
              content: [{ type: "text", text: `ERROR: failed to read category config: ${error instanceof Error ? error.message : error}. Category "${categoryName}" cannot be resolved; valid categories are unavailable.` }],
              isError: true,
              details: { validCategories, categoryName },
            };
          }
          // With no explicit category, an unreadable settings API may safely
          // fall back to the new session's default model.
          categoryName = "Default";
        }

        // ====================================================================
        // Phase 2: Create unprompted session
        // ====================================================================

        let sessionId = "";
        try {
          const created = await api("POST", "/api/new-chat", {
            cwd: params.cwd || parentCwd,
            ...(parentId && parentId !== "unknown" ? { origin: { sessionId: parentId, kind: "spawn" } } : {}),
          });
          sessionId = String(created.sessionId || "");
          if (!sessionId) throw new Error("new-chat did not return a sessionId");
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `ERROR: failed to create worker session: ${error instanceof Error ? error.message : error}`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        const displayName = params.name;
        await api("POST", "/api/session/name", { sessionId, name: displayName }).catch(() => {});

        let regionSubstituted = false;

        // ====================================================================
        // Phase 3: Resolve against worker's registry (if config provided)
        // ====================================================================

        if (resolvedToken) {
          try {
            const { models } = await api("GET", `/api/models?sessionId=${encodeURIComponent(sessionId)}`);
            const registryModels = Array.isArray(models) ? models : [];

            // Get parent region prefix for fallback.
            let parentRegionPrefix = "";
            try {
              const parentState = await api("GET", `/api/state?sessionId=${encodeURIComponent(parentId)}`);
              parentRegionPrefix = String(parentState?.model?.id || "").match(/^(us|eu|au|apac|global)\./)  ?.[0] || "";
            } catch { /* best effort */ }

            const resolution = resolveModel(
              `${resolvedToken.provider}:${resolvedToken.id}`,
              registryModels,
              parentRegionPrefix,
            );

            if (!resolution) {
              // Resolution failed → delete session and error.
              const cleanedUp = await cleanupCreatedSession(sessionId);
              return {
                content: [
                  {
                    type: "text",
                    text: `ERROR: the model configured for category "${categoryName}" is not available in this worker's registry. Valid categories: ${validCategories.join(", ") || "(none configured)"}. ${cleanupReport(sessionId, cleanedUp)}`,
                  },
                ],
                isError: true,
                details: { sessionId, validCategories, categoryName, cleanedUp },
              };
            }

            const { match, substituted } = resolution;

            // ================================================================
            // Phase 4: Set model on worker
            // ================================================================

            await api("POST", "/api/model", { sessionId, provider: match.provider, id: match.id });
            regionSubstituted = substituted;
          } catch (error) {
            // Model resolution error → delete session and error. Keep the
            // configured provider/id private from the model-facing result.
            console.error(`[session-orchestrator] failed to configure worker category "${categoryName}": ${error instanceof Error ? error.message : error}`);
            const cleanedUp = await cleanupCreatedSession(sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: `ERROR: failed to configure the model for category "${categoryName}". Valid categories: ${validCategories.join(", ") || "(none configured)"}. ${cleanupReport(sessionId, cleanedUp)}`,
                },
              ],
              isError: true,
              details: { sessionId, validCategories, categoryName, cleanedUp },
            };
          }
        }

        // ====================================================================
        // Phase 5: Dispatch task
        // ====================================================================

        const prompt = [
          `${WORKER_MARKER} You are a worker session spawned by session ${parentId} to do one task. Work autonomously; the spawner cannot answer questions mid-task, so make reasonable assumptions and note them.`,
          `Lead your final report with four short labelled lines: Outcome: what you did/found; Changed: files touched (with paths); Verified: checks and results; Blocked: remaining issues or none. Keep these lines concise, then add details if needed. Do not spawn other sessions.`,
          ``,
          `TASK: ${params.task}`,
        ].join("\n");
        const dispatchId = randomUUID();
        spawnedWorkers.add(sessionId);
        try { watch(sessionId, params.name, categoryName || "Default", dispatchId, true); }
        catch (error) {
          spawnedWorkers.delete(sessionId);
          await cleanupCreatedSession(sessionId);
          throw new Error(`Could not persist dispatch intent; no task was sent: ${error instanceof Error ? error.message : error}`);
        }
        const intent = watched.get(sessionId)!;
        try {
          const receipt = await api("POST", "/api/prompt", { sessionId, message: prompt, waitFor: "admission", dispatchId });
          if (receipt.admission !== "accepted") throw new Error("Prompt admission was not confirmed");
        } catch (error) {
          console.error(`[session-orchestrator] failed to dispatch worker ${sessionId}: ${error instanceof Error ? error.message : error}`);
          const definitive = admissionRejected(error);
          if (definitive && isActive(spawnGeneration) && watched.get(sessionId)?.watchId === intent.watchId) { unwatch(sessionId); persist(); }
          const cleanedUp = definitive ? await cleanupCreatedSession(sessionId) : false;
          return {
            content: [{ type: "text", text: `ERROR: failed to confirm task admission for worker session ${sessionId}. ${definitive ? cleanupReport(sessionId, cleanedUp) : "Admission is ambiguous; its durable dispatch intent remains tracked. Do not resend the task blindly."}` }],
            isError: true,
            details: { sessionId, categoryName, cleanedUp },
          };
        }

        if (!isActive(spawnGeneration)) throw new Error("Orchestrator instance was replaced");
        intent.admissionPending = false;
        persist();
        appendLedger(WATCH_ENTRY, sessionId, params.name, categoryName || "Default", true);

        return {
          content: [
            {
              type: "text",
              text: `Spawned worker "${params.name}" (session ${sessionId}, category "${categoryName || "Default"}"). It is running in the background as a normal pi-web session named "${displayName}".${regionSubstituted ? " A region prefix was substituted." : ""} You'll receive a 🔔 wakeup message when it goes idle — do not poll. Continue other work, spawn more workers, or end your turn to wait.`,
            },
          ],
          details: {
            sessionId,
            name: params.name,
            sessions: [{ sessionId, name: params.name }],
            cwd: params.cwd || parentCwd,
            categoryName: categoryName || "Default",
            regionSubstituted,
          } as Record<string, unknown>,
        };
        } finally {
          reservedSpawnSlots -= 1;
        }
        })();
        // The SDK records failure only when execute throws, not from isError.
        if ("isError" in result && result.isError) throw new Error(result.content.map((part: any) => part.text || "").join("\n"));
        return result;
      },
    };
  }

  async function registerTools(ctx: PiWebExtensionContext) {
    try {
      const web = ctx?.ui?.web;
      if (web?.getSettings) {
        const s = await web.getSettings(SETTINGS_ID);
        if (s && typeof s === "object" && s.values) {
          cachedConfig = {
            categories: Array.isArray(s.values.categories) ? s.values.categories : [],
            defaultCategory: String(s.values.defaultCategory || ""),
          };
        }
      }
    } catch {}
    pi.registerTool(buildSpawnTool(ctx));
  }

  pi.on("session_start", async (_event: unknown, ctx: PiWebExtensionContext) => {
    captureSelf(ctx);
    void rearmFromLedger(ctx).catch((error) => console.error("[session-orchestrator] durable watch recovery failed; journal retained", error));
    try {
      const web = ctx?.ui?.web;
      if (web?.registerSettings) {
        await registerTools(ctx);
        const result = await web.registerSettings({
          ...SETTINGS_SCHEMA,
          onChange: () => {
            // Category config changed: rebuild tool to update description.
            void registerTools(ctx);
          },
        });
        if (result && result.registered === false && result.error) {
          console.warn(`[session-orchestrator ${EXT_VERSION}] settings registration rejected: ${result.error}`);
        }
      }
    } catch (error) {
      console.warn(`[session-orchestrator ${EXT_VERSION}] settings registration failed:`, error);
    }
  });
  pi.on("turn_start", (_event: any, ctx: any) => captureSelf(ctx));

  /**
   * On session (re)load: resume watching children that are still running, and
   * deliver catch-up wakeups for children that finished while this session was
   * not in memory (server restart, /reload, idle disposal).
   */
  async function rearmFromLedger(ctx: any, expectedGeneration = generation) {
    if (!isActive(expectedGeneration)) return;
    let restored: Journal | undefined;
    try { restored = JSON.parse(readFileSync(journalPath(), "utf8")); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (restored && restored.version !== 1) throw new Error("Unsupported orchestrator journal version");
    if (restored) {
      // Older v1 journals put quarantined predecessors before active watches.
      // Last child ID wins; frozen batches independently own old watch IDs.
      for (const record of restored.watches) {
        const { anchor: _anchor, ...w } = record as Watched & { anchor?: unknown };
        watched.set(w.id, { ...w, idlePolls: 0, fingerprint: undefined });
      }
      pending = restored.pending.map(({ deliveryId, members, message }) => ({
        deliveryId, message,
        members: members.map(({ id, watchId, resolves }) => ({ id, watchId, resolves })),
      }));
    } else {
      for (const [id, worker] of outstandingWatches(ctx)) {
        watched.set(id, { id, ...worker, watchId: randomUUID(), sawRunning: false, idlePolls: 0, errorPolls: 0, aborted: false, transcriptFailures: 0 });
        if (worker.spawned) spawnedWorkers.add(id);
      }
    }
    // Spawn membership is lineage, not prompt-watch capacity.
    for (const w of watched.values()) if (w.spawned) spawnedWorkers.add(w.id);
    persist();
    reportWatchedDependencies();
    ensureTimer();
    await poll(expectedGeneration);
  }

  async function flushPending(expectedGeneration: number) {
    for (const delivery of [...pending]) {
      if (!isActive(expectedGeneration)) return;
      // Deliver on the active parent branch. Old reports cannot resolve renewed watches.
      const receipt = await api("POST", "/api/session/completion", {
        sessionId: selfSessionId, deliveryId: delivery.deliveryId, message: delivery.message,
      });
      if (!isActive(expectedGeneration)) return;
      if (receipt.state !== "saved") continue;
      for (const member of delivery.members) {
        const w = watched.get(member.id);
        if (w?.watchId !== member.watchId) continue;
        if (member.resolves) {
          appendLedger(RESOLVED_ENTRY, member.id);
          unwatch(member.id);
          markChildRead(member.id);
        } else w.unavailableReported = true;
      }
      pending = pending.filter((p) => p.deliveryId !== delivery.deliveryId);
      persist();
      reportWatchedDependencies();
      stopTimerIfIdle();
    }
  }

  async function poll(expectedGeneration = generation) {
    if (!isActive(expectedGeneration) || pollInFlight) return;
    pollInFlight = true;
    try {
      await flushPending(expectedGeneration);
      const completed: { w: Watched; summary: WorkerReport }[] = [];
      for (const w of [...watched.values()]) {
        if (!isActive(expectedGeneration)) return;
        if (!current(w) || pending.some((p) => p.members.some((m) => m.watchId === w.watchId))) continue;
        try {
          const state = await api("GET", `/api/state?sessionId=${encodeURIComponent(w.id)}`);
          if (!isActive(expectedGeneration) || !current(w)) continue;
          w.errorPolls = 0;
          const running = Boolean(state?.runtime?.isRunning ?? (state?.isStreaming || state?.isCompacting));
          if (running || Number(state?.runtime?.pendingMessageCount || 0) > 0) {
            w.idlePolls = 0; w.fingerprint = undefined; continue;
          }
          let messages: any[];
          try { messages = await fetchMessages(w.id, w.dispatchId); }
          catch {
            if (!isActive(expectedGeneration) || !current(w)) continue;
            w.idlePolls = 0;
            const summary = trackTranscriptReport(w, workerReport(null));
            if (!w.unavailableReported || w.transcriptFailures >= MAX_TRANSCRIPT_FAILURES) completed.push({ w, summary });
            continue;
          }
          if (!isActive(expectedGeneration) || !current(w)) continue;
          w.transcriptFailures = 0;
          const marker = w.dispatchId ? `[pi-web-dispatch:${w.dispatchId}]` : undefined;
          const boundary = marker ? messages.findIndex((m) => m.role === "user" && String(m.text ?? "").includes(marker)) : -1;
          const fingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
          w.idlePolls = w.fingerprint === fingerprint ? w.idlePolls + 1 : 1;
          w.fingerprint = fingerprint;
          if (marker && boundary < 0) {
            if (w.idlePolls >= MAX_MISSING_MARKER_POLLS) completed.push({ w, summary: { outcome: "report unavailable", isError: false, attributionUnavailable: true, text: `Task attribution unavailable: dispatch marker was absent after ${MAX_MISSING_MARKER_POLLS} stable idle observations. No older reply has been attributed to this task. The watch will be released after this report is saved; inspect or explicitly reassign the task.` } });
            continue;
          }
          if (w.admissionPending && boundary >= 0) { w.admissionPending = false; persist(); }
          const activity = marker ? messages.slice(boundary + 1) : [];
          if (w.idlePolls < 3) continue;
          let summary = marker ? workerReport(activity) : { text: "Task attribution unavailable: this legacy watch has no dispatch watermark. Inspect the worker transcript.", outcome: "report unavailable" as const, isError: false };
          if (!marker && w.unavailableReported) continue;
          const last = activity.at(-1);
          if (["pending", "deferred"].includes(last?.raw?.stopReason ?? last?.stopReason)) continue;
          if (completed.length < WAKEUP_BATCH_WORKERS) completed.push({ w, summary });
        } catch (error) {
          if (!isActive(expectedGeneration)) return;
          if (!current(w)) continue;
          w.errorPolls += 1;
          if ((error instanceof ApiError && error.status === 404) || w.errorPolls >= 20) {
            w.transcriptFailures = MAX_TRANSCRIPT_FAILURES;
            completed.push({ w, summary: { outcome: "report unavailable", isError: false, text: `Lost track of worker "${w.name}": status unavailable${error instanceof ApiError && error.status === 404 ? " (session not found)" : " after repeated retries"}. This watch is being released after this report is saved.` } });
          }
          console.error("[session-orchestrator] completion observation failed", error);
        }
      }
      const eligible = completed.filter(({ w }) => current(w)).slice(0, WAKEUP_BATCH_WORKERS);
      if (eligible.length && isActive(expectedGeneration)) {
        const details = {
          kind: "wakeup",
          workers: eligible.map(({ w, summary }) => ({ sessionId: w.id, name: w.name, watchId: w.watchId, status: summary.isError || summary.outcome === "report unavailable" ? "error" : summary.outcome === "interrupted" ? "aborted" : "idle" })),
          presentation: reportPresentation(eligible.length === 1 ? `${eligible[0].w.name} · ${eligible[0].summary.outcome}` : `${eligible.length} workers · outcomes reported`, eligible.map(({ summary }) => summary.text).join(" · "), eligible.some(({ summary }) => summary.isError) ? "danger" : "accent"),
        };
        const deliveryId = randomUUID();
        pending.push({ deliveryId, members: eligible.map(({ w, summary }) => ({ id: w.id, watchId: w.watchId, resolves: !!summary.attributionUnavailable || !w.dispatchId || summary.outcome !== "report unavailable" || w.transcriptFailures >= MAX_TRANSCRIPT_FAILURES })), message: {
          customType: WAKEUP_CUSTOM_TYPE, display: true,
          content: `🔔 [orchestrator] ${eligible.length} worker outcome(s) reported.\n\n` + eligible.map(({ w, summary }) => `Worker "${w.name}" (session ${w.id}, assignment ${w.watchId}): ${summary.outcome}.\n${formatWorkerReport(summary, w.id)}`).join("\n\n---\n\n"),
          details: { ...details, deliveryId },
        } });
        try { persist(); } catch (error) { pending = pending.filter((p) => p.deliveryId !== deliveryId); throw error; }
        await flushPending(expectedGeneration);
      }
    } catch (error) {
      console.error("[session-orchestrator] durable completion retry pending", error);
    } finally { pollInFlight = false; }
  }

  // =========================================================================
  // Other tools (unchanged from original)
  // =========================================================================

  // -------------------------------------------------------------------------
  // sessions_status
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "sessions_status",
    label: "Worker session status",
    description: "Get a one-line status (running/idle, category, cost, message counts) for worker sessions. With no ids, reports all workers spawned from this session that are still tracked. Prefer waiting for wakeup messages over calling this in a loop.",
    promptSnippet: "Check status of spawned worker sessions",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "Session ids to check (defaults to all tracked workers)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const ids: string[] = params.ids?.length ? params.ids : Array.from(watched.keys());
      if (ids.length === 0) {
        return { content: [{ type: "text", text: "No tracked workers. (Workers you already received a wakeup for are untracked; pass their session id explicitly to check them.)" }], details: {} };
      }
      const lines: string[] = [];
      for (const id of ids) {
        try {
          const state = await api("GET", `/api/state?sessionId=${encodeURIComponent(id)}`);
          const running = Boolean(state?.runtime?.isRunning);
          const stats = state?.stats || {};
          const name = state?.sessionName || state?.sessionTitle || shortId(id);
          const categoryName = watched.get(id)?.categoryName || "Unknown";
          const admission = watched.get(id)?.admissionPending ? " — admission unconfirmed; waiting for task marker" : "";
          lines.push(`${running ? "⏳ RUNNING" : "✔ idle"} — "${name}" (${id}) — category "${categoryName}" — $${Number(stats.cost || 0).toFixed(2)} — ${Number(stats.assistantMessages || 0)} assistant msgs${admission}${state?.runtime?.pendingMessageCount ? ` — ${state.runtime.pendingMessageCount} queued` : ""}`);
        } catch (error) {
          lines.push(`? — ${id} — status unavailable (${error instanceof Error ? error.message : error})`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // sessions_prompt
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "sessions_prompt",
    label: "Message worker session",
    description: "Send a natural-language message to another session. Registered SDK slash commands/templates/skills are unsupported for tracked dispatch; paths and unknown slash literals are allowed. Mid-turn messages are delivered as steering after current tool calls; set interrupt=true to abort the current turn first. You'll receive a wakeup when it next goes idle.",
    promptSnippet: "Send a follow-up or steering message to a worker session (interrupt optional)",
    parameters: Type.Object({
      id: Type.String({ description: "Session id" }),
      message: Type.String({ description: "The message to deliver" }),
      interrupt: Type.Optional(Type.Boolean({ description: "Abort the session's current turn before delivering (default false)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const expectedGeneration = generation;
      const previous = dispatchQueues.get(params.id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
        // Commands may consume/expand input without an attributable user entry.
        // Lookup must succeed before aborting or replacing the durable intent.
        await checkTrackedMessage(params.id, params.message);
        if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
        dispatching.add(params.id);
        try {
          if (params.interrupt) {
            const aborted = await api("POST", "/api/abort", { sessionId: params.id, waitFor: "idle" });
            if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
            if (aborted.idle !== true) throw new Error("Abort did not confirm idle; redirect not sent");
          }
          const dispatchId = randomUUID();
          const old = watched.get(params.id);
          watch(params.id, old?.name || shortId(params.id), old?.categoryName, dispatchId, true);
          const intent = watched.get(params.id)!;
          try {
            const receipt = await api("POST", "/api/prompt", { sessionId: params.id, message: params.message, mode: "steer", waitFor: "admission", dispatchId });
            if (receipt.admission !== "accepted") throw new ApiError("Prompt admission was not confirmed", 409);
          } catch (error) {
            if (admissionRejected(error) && isActive(expectedGeneration) && watched.get(params.id)?.watchId === intent.watchId) {
              if (old) watched.set(params.id, old); else watched.delete(params.id);
              persist(); reportWatchedDependencies();
            }
            throw error;
          }
          if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
          intent.admissionPending = false;
          persist();
          appendLedger(WATCH_ENTRY, params.id, intent.name, intent.categoryName, spawnedWorkers.has(params.id));
          return { content: [{ type: "text" as const, text: `Task admitted to session ${params.id}. You'll get a 🔔 wakeup after its outcome is saved.` }], details: {} };
        } finally { dispatching.delete(params.id); }
      });
      dispatchQueues.set(params.id, operation);
      try { return await operation; }
      finally { if (dispatchQueues.get(params.id) === operation) dispatchQueues.delete(params.id); }
    },
  });

  // -------------------------------------------------------------------------
  // sessions_abort
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "sessions_abort",
    label: "Abort worker session",
    description: "Abort another session's current turn and stop tracking it. The session itself remains in the sidebar and can be resumed later with sessions_prompt.",
    promptSnippet: "Abort a worker session's current turn",
    parameters: Type.Object({
      id: Type.String({ description: "Session id" }),
    }),
    async execute(_toolCallId: string, params: any) {
      const expectedGeneration = generation;
      const previous = dispatchQueues.get(params.id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
        dispatching.add(params.id);
        const watchId = watched.get(params.id)?.watchId;
        try {
          const receipt = await api("POST", "/api/abort", { sessionId: params.id, waitFor: "idle" });
          if (!isActive(expectedGeneration)) throw new Error("Orchestrator instance was replaced");
          if (receipt.idle !== true) throw new Error("Abort did not confirm idle");
          if (watchId && watched.get(params.id)?.watchId === watchId) {
            appendLedger(RESOLVED_ENTRY, params.id);
            unwatch(params.id);
            persist();
          }
          return { content: [{ type: "text" as const, text: `Aborted session ${params.id} and stopped tracking that assignment.` }], details: {} };
        } finally { dispatching.delete(params.id); }
      });
      dispatchQueues.set(params.id, operation);
      try { return await operation; }
      finally { if (dispatchQueues.get(params.id) === operation) dispatchQueues.delete(params.id); }
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", () => {
    // Keep the last atomic declaration across reload and idle disposal. The
    // durable ledger lets the replacement instance re-report or resolve it.
    client?.dispose();
    client = undefined;
    disposed = true;
    generation += 1;
    if (timer) clearInterval(timer);
    timer = undefined;
    watched.clear();
    spawnedWorkers.clear();
  });
}
