/**
 * session-orchestrator — experimental pi-web extension
 *
 * Gives every pi-web session the same orchestration verbs a human has in the
 * UI: spawn sibling sessions, check on them, read their transcripts, steer or
 * interrupt them, and abort them. Workers are ordinary first-class pi-web
 * sessions (full history, visible in the sidebar, resumable).
 *
 * Wakeups: after spawning/prompting a worker, the parent does NOT block. A
 * background watcher (plain JS polling — zero tokens) injects a user message
 * into the parent session when a worker goes idle, which starts a new parent
 * turn. The parent can end its turn and "sleep" while workers run.
 *
 * Everything goes through the same local HTTP API the web UI uses.
 *
 * Reversible install: this lives in .pi/extensions/session-orchestrator/ —
 * delete that directory (and .pi/skills/session-orchestration/) to remove the
 * feature entirely. No AGENTS.md or server changes.
 */

import { Type } from "typebox";
import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebSettingsSchema } from "@ashwin-pc/pi-web/extensions";

const WORKER_MARKER = "[pi-web orchestrated worker]";
const EXT_VERSION = "v9";
const WAKEUP_CUSTOM_TYPE = "session-orchestrator";
// Durable watch ledger: appended to the parent's session file so a freshly
// re-materialized parent (server restart, /reload, idle disposal) can re-arm
// its watchers or deliver catch-up wakeups. Resolved = wakeup was DELIVERED.
const WATCH_ENTRY = "orchestrator-watch";
const RESOLVED_ENTRY = "orchestrator-watch-resolved";
const MAX_WORKERS = 4;
const POLL_MS = 2500;
const WAKEUP_SUMMARY_CHARS = 2000;

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

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PI_WEB_TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;

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

  // 2. Same provider + same normalized base id + parent region prefix (Bedrock case).
  if (parentRegionPrefix) {
    const baseId = normalizeBedrockId(id);
    const withPrefix = parentRegionPrefix + baseId.slice(baseId.match(/^(us|eu|au|apac|global)\./)  ?.[0]?.length || 0);
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

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(`${method} ${path} failed (${res.status}): ${json?.error || "unknown error"}`);
  }
  return json;
}

function trunc(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

// ---------------------------------------------------------------------------
// Transcript helpers (uses /api/messages simplified message shape)
// ---------------------------------------------------------------------------

async function fetchMessages(sessionId: string): Promise<any[]> {
  const json = await api("GET", `/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
  return Array.isArray(json.messages) ? json.messages : [];
}

function lastAssistantText(messages: any[]): { text: string; isError: boolean } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && typeof m.text === "string" && m.text.trim()) {
      return { text: m.text.trim(), isError: Boolean(m.isError) };
    }
  }
  return { text: "", isError: false };
}

function shortArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    parts.push(`${key}: ${trunc(typeof value === "string" ? value : JSON.stringify(value), 60)}`);
    if (parts.join(", ").length > 140) break;
  }
  return trunc(parts.join(", "), 160);
}

function formatTranscript(messages: any[], tail: number): string {
  const slice = messages.slice(-tail);
  const lines: string[] = [];
  if (messages.length > slice.length) lines.push(`… (${messages.length - slice.length} earlier entries omitted; increase tail to see more)`);
  for (const m of slice) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      lines.push(`[user] ${trunc(m.text, 400)}`);
    } else if (m.role === "assistant") {
      if (m.text) lines.push(`[assistant] ${trunc(m.text, 700)}`);
      for (const call of m.toolCalls || []) {
        lines.push(`  → ${call.toolName}(${shortArgs(call.args)})`);
      }
    } else if (m.role === "toolResult") {
      lines.push(`  ${m.isError ? "✗" : "✓"} ${m.toolName}: ${trunc(m.text, 200)}`);
    } else if (m.role === "bashExecution") {
      lines.push(`  $ ${trunc(m.command, 160)}`);
      if (m.output) lines.push(`    ${trunc(m.output, 200)}`);
    }
  }
  return lines.join("\n") || "(no messages)";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sessionOrchestrator(pi: PiWebExtensionAPI) {
  type Watched = {
    id: string;
    name: string;
    categoryName: string;
    sawRunning: boolean;
    idlePolls: number;
    errorPolls: number;
    aborted: boolean;
  };

  const watched = new Map<string, Watched>();
  let cachedConfig: { categories: any[]; defaultCategory: string } = { categories: [], defaultCategory: "" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  let selfSessionId = "";
  let disposed = false;
  let generation = 0;

  function isActive(expectedGeneration = generation): boolean {
    return !disposed && generation === expectedGeneration;
  }

  // Capture our own session id whenever context is available; used to route
  // wakeups through /api/prompt (the same battle-tested path the web UI uses
  // for steering), which works both when the parent is idle and mid-turn.
  function captureSelf(ctx: PiWebExtensionContext) {
    const id = ownSessionId(ctx);
    if (id && id !== "unknown") selfSessionId = id;
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
    if (!isActive() || timer || watched.size === 0) return;
    const timerGeneration = generation;
    timer = setInterval(() => {
      if (isActive(timerGeneration)) void poll(timerGeneration);
    }, POLL_MS);
  }

  function stopTimerIfIdle() {
    if (timer && watched.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function watch(id: string, name: string, categoryName = "Unknown") {
    if (!isActive()) return;
    watched.set(id, { id, name, categoryName, sawRunning: false, idlePolls: 0, errorPolls: 0, aborted: false });
    ensureTimer();
  }

  function unwatch(id: string) {
    watched.delete(id);
    stopTimerIfIdle();
  }

  function appendLedger(customType: string, childId: string, name?: string, categoryName?: string) {
    try {
      pi.appendEntry(customType, { childId, ...(name ? { name } : {}), ...(categoryName ? { categoryName } : {}) });
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

  function outstandingWatches(ctx: any): Map<string, { name: string; categoryName: string }> {
    const watches = new Map<string, { name: string; categoryName: string }>();
    try {
      for (const entry of ctx.sessionManager?.getBranch?.() || []) {
        if (entry?.type !== "custom") continue;
        const childId = typeof entry.data?.childId === "string" ? entry.data.childId : "";
        if (!childId) continue;
        if (entry.customType === WATCH_ENTRY) {
          watches.set(childId, {
            name: typeof entry.data?.name === "string" ? entry.data.name : childId.slice(-8),
            categoryName: typeof entry.data?.categoryName === "string" ? entry.data.categoryName : "Unknown",
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
        if (watched.size >= MAX_WORKERS) {
          return {
            content: [{ type: "text", text: `Refused: already tracking ${watched.size} running workers (cap ${MAX_WORKERS}). Wait for a wakeup or abort one first.` }],
            isError: true,
            details: {},
          };
        }

        const parentId = ownSessionId(ctx);
        const parentCwd = ownCwd(ctx);

        // ====================================================================
        // Phase 1: Resolve category → canonical {provider, id} from config
        // ====================================================================

        let resolvedToken: { provider: string; id: string } | null = null;
        let categoryName = params.category || "";
        let validCategories: string[] = [];

        try {
          const web = ctx?.ui?.web;
          if (web?.getSettings) {
            const settings = await web.getSettings(SETTINGS_ID);
            if (settings && typeof settings === "object") {
              const values = settings.values || {};
              cachedConfig = { categories: Array.isArray(values.categories) ? values.categories : [], defaultCategory: String(values.defaultCategory || "") };
              const categories = Array.isArray(values.categories) ? values.categories : [];
              const defaultCategory = String(values.defaultCategory || "");

              // Empty config → virtual Default, skip resolution, use session default.
              if (categories.length === 0) {
                resolvedToken = null; // Signals: use session default
                categoryName = "Default";
                validCategories = [categoryName];
              } else {
                // Collect valid names.
                for (const cat of categories) {
                  if (cat && typeof cat === "object" && cat.name) {
                    validCategories.push(String(cat.name));
                  }
                }

                // Resolve category name.
                if (!categoryName) {
                  categoryName = defaultCategory;
                }

                if (!categoryName) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `ERROR: category omitted and no default is configured. Valid categories: ${validCategories.join(", ") || "(none configured)"}. Set a default in extension settings or pass an explicit category name.`,
                      },
                    ],
                    isError: true,
                    details: { validCategories },
                  };
                }

                // Find matching category.
                const matching = categories.find(
                  (cat: any) => cat && typeof cat === "object" && cat.name && String(cat.name).toLowerCase() === String(categoryName).toLowerCase(),
                );
                if (!matching || !matching.model) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `ERROR: category "${categoryName}" not found or has no model configured. Valid categories: ${validCategories.join(", ") || "(none configured)"}`,
                      },
                    ],
                    isError: true,
                    details: { validCategories, categoryName },
                  };
                }

                resolvedToken = parseToken(String(matching.model));
                if (!resolvedToken) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `ERROR: the model configured for category "${categoryName}" is malformed. Check extension settings. Valid categories: ${validCategories.join(", ") || "(none configured)"}`,
                      },
                    ],
                    isError: true,
                    details: { validCategories },
                  };
                }
              }
            }
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `ERROR: failed to read category config: ${error instanceof Error ? error.message : error}. Categories unavailable; please check extension settings.`,
              },
            ],
            isError: true,
            details: {},
          };
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
          `When finished, end your final message with a concise report: what you did/found, files touched (with paths), and how you verified it. Do not spawn other sessions.`,
          ``,
          `TASK: ${params.task}`,
        ].join("\n");
        try {
          await api("POST", "/api/prompt", { sessionId, message: prompt });
        } catch (error) {
          console.error(`[session-orchestrator] failed to dispatch worker ${sessionId}: ${error instanceof Error ? error.message : error}`);
          const cleanedUp = await cleanupCreatedSession(sessionId);
          return {
            content: [{ type: "text", text: `ERROR: failed to dispatch the task to worker session ${sessionId}; no work was dispatched. ${cleanupReport(sessionId, cleanedUp)}` }],
            isError: true,
            details: { sessionId, categoryName, cleanedUp },
          };
        }

        watch(sessionId, params.name, categoryName || "Default");
        appendLedger(WATCH_ENTRY, sessionId, params.name, categoryName || "Default");

        return {
          content: [
            {
              type: "text",
              text: `Spawned worker "${params.name}" (session ${sessionId}, category "${categoryName || "Default"}") [ext ${EXT_VERSION}]. It is running in the background as a normal pi-web session named "${displayName}".${regionSubstituted ? " A region prefix was substituted." : ""} You'll receive a 🔔 wakeup message when it goes idle — do not poll. Continue other work, spawn more workers, or end your turn to wait.`,
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
    void rearmFromLedger(ctx);
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
    const outstanding = outstandingWatches(ctx);
    for (const id of watched.keys()) outstanding.delete(id);
    if (outstanding.size === 0) return;

    const finished: { id: string; name: string; categoryName: string; summary: { text: string; isError: boolean } }[] = [];
    for (const [childId, worker] of outstanding) {
      if (!isActive(expectedGeneration)) return;
      try {
        const state = await api("GET", `/api/state?sessionId=${encodeURIComponent(childId)}`);
        if (!isActive(expectedGeneration)) return;
        const running = Boolean(state?.runtime?.isRunning) || Number(state?.runtime?.pendingMessageCount || 0) > 0;
        if (running) {
          watch(childId, worker.name, worker.categoryName);
          continue;
        }
        let summary = { text: "", isError: false };
        try {
          const messages = await fetchMessages(childId);
          if (!isActive(expectedGeneration)) return;
          summary = lastAssistantText(messages);
        } catch {
          if (!isActive(expectedGeneration)) return;
          // Transcript fetch is best effort.
        }
        finished.push({ id: childId, name: worker.name, categoryName: worker.categoryName, summary });
      } catch {
        if (!isActive(expectedGeneration)) return;
        // Child gone (deleted?) — resolve so we don't retry forever.
        appendLedger(RESOLVED_ENTRY, childId);
      }
    }
    if (!isActive(expectedGeneration) || finished.length === 0) return;

    const details = {
      kind: "wakeup",
      catchUp: true,
      workers: finished.map((f) => ({ sessionId: f.id, name: f.name, status: f.summary.isError ? "error" : "idle" })),
      stillRunning: Array.from(watched.values()).map((o) => ({ sessionId: o.id, name: o.name })),
    };
    const sections = finished.map((f) => [
      `Worker "${f.name}" (session ${f.id}) finished while this session was offline.`,
      f.summary.text
        ? `${f.summary.isError ? "⚠️ Its last turn ENDED WITH AN ERROR (task likely incomplete):\n" : "Final message:\n"}${trunc(f.summary.text, WAKEUP_SUMMARY_CHARS)}`
        : `(no final message captured)`,
    ].join("\n"));
    const ok = await deliverWakeup([
      `🔔 [orchestrator] Catch-up: ${finished.length === 1 ? "a worker" : `${finished.length} workers`} finished while this session was not loaded.`,
      ``,
      sections.join("\n\n---\n\n"),
      ``,
      `You can inspect details with sessions_read, follow up or redirect with sessions_prompt, or continue with your task.`,
    ].join("\n"), details, expectedGeneration);
    if (!isActive(expectedGeneration)) return;
    if (ok) {
      for (const f of finished) {
        appendLedger(RESOLVED_ENTRY, f.id);
        markChildRead(f.id);
      }
    } else {
      // Keep completed workers live in the watcher until a later poll can
      // successfully deliver their wakeup.
      for (const f of finished) watch(f.id, f.name, f.categoryName);
    }
  }

  /** Deliver a wakeup to this session. Returns true only if delivery succeeded. */
  async function deliverWakeup(text: string, details?: Record<string, unknown>, expectedGeneration = generation): Promise<boolean> {
    if (!isActive(expectedGeneration)) return false;
    // Preferred: pi custom message — typed, persisted, reaches the LLM as a
    // user message, and carries structured details for the pi-web UI card.
    try {
      await pi.sendMessage(
        { customType: WAKEUP_CUSTOM_TYPE, content: text, display: true, details },
        { triggerTurn: true, deliverAs: "steer" },
      );
      if (!isActive(expectedGeneration)) return false;
      return true;
    } catch (error) {
      if (!isActive(expectedGeneration)) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (/stale/i.test(message)) {
        // This extension instance was replaced (e.g. /reload). The new
        // instance re-arms from the persisted watch ledger and owns delivery
        // now — falling back here would double-deliver. Go silent and stop.
        console.error("[session-orchestrator] instance is stale after reload; stopping watcher (ledger hands off to the new instance)");
        disposed = true;
        generation += 1;
        if (timer) clearInterval(timer);
        timer = undefined;
        watched.clear();
        return false;
      }
      console.error(`[session-orchestrator] custom-message wakeup failed, falling back to /api/prompt: ${message}`);
    }
    if (!isActive(expectedGeneration)) return false;
    if (selfSessionId) {
      try {
        await api("POST", "/api/prompt", { sessionId: selfSessionId, message: text, mode: "steer" });
        if (!isActive(expectedGeneration)) return false;
        return true;
      } catch (error) {
        if (!isActive(expectedGeneration)) return false;
        console.error(`[session-orchestrator] wakeup via /api/prompt failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!isActive(expectedGeneration)) return false;
    try {
      pi.sendUserMessage(text);
      return true;
    } catch {
      try {
        pi.sendUserMessage(text, { deliverAs: "steer" });
        return true;
      } catch (error) {
        console.error(`[session-orchestrator] wakeup delivery failed entirely: ${error instanceof Error ? error.message : error}`);
      }
    }
    return false;
  }

  async function poll(expectedGeneration = generation) {
    if (!isActive(expectedGeneration) || pollInFlight) return;
    pollInFlight = true;
    try {
      const completed: { w: Watched; summary: { text: string; isError: boolean } }[] = [];
      for (const w of Array.from(watched.values())) {
        if (!isActive(expectedGeneration)) return;
        try {
          const state = await api("GET", `/api/state?sessionId=${encodeURIComponent(w.id)}`);
          if (!isActive(expectedGeneration)) return;
          const running = Boolean(state?.runtime?.isRunning ?? (state?.isStreaming || state?.isCompacting));
          const pending = Number(state?.runtime?.pendingMessageCount || 0);
          w.errorPolls = 0;
          if (running || pending > 0) {
            w.sawRunning = true;
            w.idlePolls = 0;
            continue;
          }
          w.idlePolls += 1;
          // Fast tasks may finish between polls; if we never saw it running,
          // wait a few polls before concluding it is done.
          const settled = w.sawRunning ? w.idlePolls >= 1 : w.idlePolls >= 4;
          if (!settled) continue;

          let summary = { text: "", isError: false };
          try {
            const messages = await fetchMessages(w.id);
            if (!isActive(expectedGeneration)) return;
            summary = lastAssistantText(messages);
          } catch {
            if (!isActive(expectedGeneration)) return;
            // Transcript fetch is best-effort.
          }
          completed.push({ w, summary });
        } catch {
          if (!isActive(expectedGeneration)) return;
          w.errorPolls += 1;
          if (w.errorPolls >= 20) {
            const ok = await deliverWakeup(
              `🔔 [orchestrator] Lost track of worker "${w.name}" (session ${w.id}): status polling kept failing (it may have been deleted). Check it with sessions_status or in the sidebar.`,
              { kind: "wakeup", workers: [{ sessionId: w.id, name: w.name, status: "error" }] },
              expectedGeneration,
            );
            if (!isActive(expectedGeneration)) return;
            if (ok) {
              unwatch(w.id);
              appendLedger(RESOLVED_ENTRY, w.id);
            }
          }
        }
      }

      // Batch all completions from this poll cycle into ONE message. Sending
      // two user messages back-to-back while the parent is idle races the
      // turn-start and can drop the second message.
      if (completed.length > 0) {
        const completedIds = new Set(completed.map(({ w }) => w.id));
        const activeWorkers = Array.from(watched.values()).filter((w) => !completedIds.has(w.id));
        const stillRunning = activeWorkers.map((o) => `"${o.name}"`).join(", ");
        const details = {
          kind: "wakeup",
          workers: completed.map(({ w, summary }) => ({
            sessionId: w.id,
            name: w.name,
            status: w.aborted ? "aborted" : summary.isError ? "error" : "idle",
          })),
          stillRunning: activeWorkers.map((o) => ({ sessionId: o.id, name: o.name })),
        };
        const sections = completed.map(({ w, summary }) => [
          `Worker "${w.name}" (session ${w.id}) is now ${w.aborted ? "stopped (aborted)" : "idle"}.`,
          summary.text
            ? `${summary.isError ? "⚠️ Its last turn ENDED WITH AN ERROR (task likely incomplete — inspect with sessions_read, then retry or fix):\n" : "Final message:\n"}${trunc(summary.text, WAKEUP_SUMMARY_CHARS)}`
            : `(no final message captured)`,
        ].join("\n"));
        const ok = await deliverWakeup([
          `🔔 [orchestrator] ${completed.length === 1 ? "A worker finished." : `${completed.length} workers finished.`}`,
          ``,
          sections.join("\n\n---\n\n"),
          ``,
          stillRunning ? `Still running: ${stillRunning}.` : `No other workers are running.`,
          `You can inspect details with sessions_read, follow up or redirect with sessions_prompt, or continue with your task.`,
        ].join("\n"), details, expectedGeneration);
        if (!isActive(expectedGeneration)) return;
        if (ok) {
          for (const { w } of completed) {
            unwatch(w.id);
            appendLedger(RESOLVED_ENTRY, w.id);
            // The report was consumed by this session on the user's behalf —
            // clear the child's unread dot via the normal read endpoint.
            markChildRead(w.id);
          }
        }
        // On total delivery failure, leave every completed worker watched. The
        // next normal poll interval retries without creating a tight loop.
      }
    } finally {
      pollInFlight = false;
    }
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
          lines.push(`${running ? "⏳ RUNNING" : "✔ idle"} — "${name}" (${id}) — category "${categoryName}" — $${Number(stats.cost || 0).toFixed(2)} — ${Number(stats.assistantMessages || 0)} assistant msgs${state?.runtime?.pendingMessageCount ? ` — ${state.runtime.pendingMessageCount} queued` : ""}`);
        } catch (error) {
          lines.push(`? — ${id} — status unavailable (${error instanceof Error ? error.message : error})`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // sessions_read
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "sessions_read",
    label: "Read worker transcript",
    description: "Read the tail of a session's transcript (compact rendering: user/assistant text, tool calls one-line each). Use to review a worker's work or diagnose one that's going down the wrong path. Keep tails small — don't pull a worker's full process back into your context.",
    promptSnippet: "Read the recent transcript of another session",
    parameters: Type.Object({
      id: Type.String({ description: "Session id" }),
      tail: Type.Optional(Type.Number({ description: "How many trailing entries to include (default 20)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const messages = await fetchMessages(params.id);
      const text = formatTranscript(messages, Math.max(1, Math.min(200, params.tail || 20)));
      return { content: [{ type: "text", text }], details: { sessionId: params.id, totalMessages: messages.length } };
    },
  });

  // -------------------------------------------------------------------------
  // sessions_prompt
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "sessions_prompt",
    label: "Message worker session",
    description: "Send a message to another session, exactly like a user typing into it. If it is mid-turn the message is delivered as steering after the current tool calls; set interrupt=true to abort its current turn first (use when it's going down the wrong path). You'll receive a wakeup when it next goes idle.",
    promptSnippet: "Send a follow-up or steering message to a worker session (interrupt optional)",
    parameters: Type.Object({
      id: Type.String({ description: "Session id" }),
      message: Type.String({ description: "The message to deliver" }),
      interrupt: Type.Optional(Type.Boolean({ description: "Abort the session's current turn before delivering (default false)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.interrupt) {
        await api("POST", "/api/abort", { sessionId: params.id });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await api("POST", "/api/prompt", { sessionId: params.id, message: params.message, mode: "steer" });
      if (!watched.has(params.id)) {
        let name = shortId(params.id);
        try {
          const state = await api("GET", `/api/state?sessionId=${encodeURIComponent(params.id)}`);
          name = String(state?.sessionName || state?.sessionTitle || name).replace(/^[⑂⤑]\s*/, "");
        } catch { /* best effort */ }
        watch(params.id, name);
        appendLedger(WATCH_ENTRY, params.id, name);
      }
      return { content: [{ type: "text", text: `${params.interrupt ? "Interrupted and redirected" : "Message delivered to"} session ${params.id}. You'll get a 🔔 wakeup when it goes idle.` }], details: {} };
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
      await api("POST", "/api/abort", { sessionId: params.id });
      unwatch(params.id);
      appendLedger(RESOLVED_ENTRY, params.id);
      return { content: [{ type: "text", text: `Aborted session ${params.id} and stopped tracking it.` }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", () => {
    disposed = true;
    generation += 1;
    if (timer) clearInterval(timer);
    timer = undefined;
    watched.clear();
  });
}
