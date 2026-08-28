/**
 * agent-health connector that runs each test case in a real pi-web session.
 *
 * This file intentionally uses local structural types instead of importing
 * agent-health internals, so the config can load it from either a source
 * checkout or an installed agent-health package.
 */

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type TrajectoryStep = {
  id: string;
  timestamp: number;
  type: "tool_result" | "assistant" | "action" | "response" | "thinking";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: unknown;
  status?: "SUCCESS" | "FAILURE";
  latencyMs?: number;
};

type ConnectorRequest = {
  testCase: {
    name: string;
    initialPrompt: string;
    context?: Array<{
      description: string;
      value: string;
      disposition?: "prompt" | "connector" | "documentation";
    }>;
  };
  modelId: string;
  connectorConfig?: Record<string, unknown>;
};

type ConnectorResponse = {
  trajectory: TrajectoryStep[];
  runId: string | null;
  rawEvents?: unknown[];
  metadata?: Record<string, unknown>;
};

type ProgressCallback = (step: TrajectoryStep) => void;
type RawEventCallback = (event: unknown) => void;

type PiWebConnectorConfig = {
  cwd?: string;
  model?: string | { provider: string; id: string };
  token?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  settleMs?: number;
  keepSession?: boolean;
};

type PiWebMessage = {
  role?: string;
  text?: string;
  timestamp?: string;
  isError?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCalls?: Array<{
    id?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    startedAt?: string;
  }>;
  raw?: {
    content?: unknown;
    [key: string]: unknown;
  };
};

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SETTLE_MS = 20_000;
const API_TIMEOUT_MS = 30_000;
const BENCHMARK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function timestampMs(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** A standalone, structurally typed implementation of agent-health's connector contract. */
export class PiWebConnector {
  readonly type = "pi-web" as any;
  readonly name = "pi-web Session";
  readonly supportsStreaming = false;

  buildPayload(request: ConnectorRequest): { message: string } {
    const context = Array.isArray(request.testCase.context)
      ? request.testCase.context.filter(
          item => item?.description && item?.value
            && item.disposition !== "connector"
            && item.disposition !== "documentation"
            // Backward compatibility with cases authored before dispositions.
            && item.description !== "fixture",
        )
      : [];
    if (context.length === 0) return { message: request.testCase.initialPrompt };

    const renderedContext = context
      .map(item => `### ${item.description}\n${item.value}`)
      .join("\n\n");
    return {
      message: `Context supplied by the benchmark:\n\n${renderedContext}\n\n---\n\n${request.testCase.initialPrompt}`,
    };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    _auth: unknown,
    onProgress?: ProgressCallback,
    onRawEvent?: RawEventCallback,
  ): Promise<ConnectorResponse> {
    const config = (request.connectorConfig ?? {}) as PiWebConnectorConfig;
    const token = config.token || process.env.PI_WEB_TOKEN;
    const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollIntervalMs = Number(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const settleMs = Number(config.settleMs ?? DEFAULT_SETTLE_MS);
    const keepSession = config.keepSession !== false;
    const baseUrl = endpoint.replace(/\/$/, "");
    const rawEvents: unknown[] = [];
    let sessionId = "";
    let timedOut = false;
    let fixtureTempPath: string | undefined;

    const fixture = request.testCase.context?.find(
      item => item?.description === "fixture"
        && (item.disposition === "connector" || item.disposition === undefined),
    );
    const fixtureManifest = request.testCase.context?.find(
      item => item.disposition === "documentation" && item.description.startsWith("Fixture manifest:"),
    );
    const fixtureSha256 = fixtureManifest?.value.match(/Whole-fixture SHA-256:\*\* `([a-f0-9]{64})`/)?.[1];
    let cwd = config.cwd || process.cwd();
    if (fixture?.value) {
      const fixturesDir = resolve(BENCHMARK_DIR, "fixtures");
      const fixtureSource = resolve(fixturesDir, fixture.value);
      if (!fixtureSource.startsWith(`${fixturesDir}${sep}`)) {
        throw new Error(`Fixture resolves outside fixtures directory: ${fixture.value}`);
      }
      fixtureTempPath = mkdtempSync(join(tmpdir(), "pi-web-benchmark-"));
      cpSync(fixtureSource, fixtureTempPath, { recursive: true, dereference: true });
      cwd = fixtureTempPath;
    }

    const record = (kind: string, data: unknown): void => {
      const event = { kind, timestamp: new Date().toISOString(), data };
      rawEvents.push(event);
      onRawEvent?.(event);
    };

    const api = async (method: string, path: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const text = await response.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { text };
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(
          `${method} ${path} failed (${response.status}): ${data?.error || text || response.statusText}`,
        );
      }
      const eventData = path === "/api/session-ui-state"
        ? {
            ok: data?.ok,
            sessionOriginCount: Array.isArray(data?.sessionUiState?.sessionOrigins)
              ? data.sessionUiState.sessionOrigins.length
              : 0,
          }
        : data;
      record(`${method} ${path.split("?")[0]}`, eventData);
      return data;
    };

    const created = await api("POST", "/api/new-chat", { cwd });
    sessionId = String(created.sessionId || "");
    if (!sessionId) throw new Error("POST /api/new-chat did not return a sessionId");

    const sessionName = truncate(`bench: ${request.testCase.name}`, 80);
    await api("POST", "/api/session/name", { sessionId, name: sessionName });

    if (config.model) {
      const available = await api("GET", `/api/models?sessionId=${encodeURIComponent(sessionId)}`);
      const models = Array.isArray(available.models) ? available.models : [];
      const requestedModel = config.model;
      const selected = typeof requestedModel === "string"
        ? models.find((model: any) =>
            model?.id === requestedModel || `${model?.provider}:${model?.id}` === requestedModel,
          )
        : models.find((model: any) =>
            model?.provider === requestedModel.provider && model?.id === requestedModel.id,
          );
      if (!selected) {
        throw new Error(`Configured pi-web model was not found: ${contentText(config.model)}`);
      }
      await api("POST", "/api/model", {
        sessionId,
        provider: selected.provider,
        id: selected.id,
      });
    }

    const payload = this.buildPayload(request);
    await api("POST", "/api/prompt", { sessionId, message: payload.message });

    // A parent can briefly go idle while an orchestrated worker is still
    // running. The worker watcher subsequently injects a wakeup through
    // /api/prompt and starts another parent turn. Wait for the complete
    // parent/child tree to become idle, then require the parent's transcript
    // count to remain stable for a settle window so that wakeup delivery and
    // its follow-up turn cannot land after harvesting.
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + Math.max(1, timeoutMs);
    const childSessionIds = new Set<string>();
    let stableMessageCount: number | undefined;
    let settleStartedAt: number | undefined;
    let quiescent = false;

    const isRunning = (state: any): boolean => Boolean(
      state?.runtime?.isRunning ?? (state?.isStreaming || state?.isCompacting),
    ) || Number(state?.runtime?.pendingMessageCount || 0) > 0;

    while (Date.now() < deadline) {
      const uiState = await api("GET", "/api/session-ui-state");
      const origins = Array.isArray(uiState?.sessionUiState?.sessionOrigins)
        ? uiState.sessionUiState.sessionOrigins
        : [];

      // Include descendants as well as direct children. The installed
      // orchestrator currently caps worker depth at one, but walking the
      // recorded lineage keeps this detector correct if that policy changes.
      const ancestors = new Set<string>([sessionId, ...childSessionIds]);
      let discovered = true;
      while (discovered) {
        discovered = false;
        for (const origin of origins) {
          const childId = typeof origin?.sessionId === "string" ? origin.sessionId : "";
          const parentId = typeof origin?.originSessionId === "string"
            ? origin.originSessionId
            : "";
          if (childId && ancestors.has(parentId) && !ancestors.has(childId)) {
            ancestors.add(childId);
            childSessionIds.add(childId);
            discovered = true;
          }
        }
      }

      const [parentState, parentTranscript, ...childStates] = await Promise.all([
        api("GET", `/api/state?sessionId=${encodeURIComponent(sessionId)}`),
        api("GET", `/api/messages?sessionId=${encodeURIComponent(sessionId)}`),
        ...Array.from(childSessionIds, childId =>
          api("GET", `/api/state?sessionId=${encodeURIComponent(childId)}`),
        ),
      ]);
      const messageCount = Array.isArray(parentTranscript?.messages)
        ? parentTranscript.messages.length
        : 0;
      const allIdle = !isRunning(parentState) && childStates.every(state => !isRunning(state));

      if (!allIdle || stableMessageCount !== messageCount) {
        stableMessageCount = messageCount;
        settleStartedAt = allIdle ? Date.now() : undefined;
      } else if (settleStartedAt === undefined) {
        settleStartedAt = Date.now();
      } else if (Date.now() - settleStartedAt >= Math.max(0, settleMs)) {
        quiescent = true;
        break;
      }

      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }

    if (!quiescent) timedOut = true;
    const settledAfterMs = Date.now() - waitStartedAt;

    // Harvest only after full quiescence. This intentionally refetches rather
    // than reusing a settling poll so the returned trajectory is the newest
    // transcript available at the quiescence boundary.
    const transcript = await api(
      "GET",
      `/api/messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    const trajectory = this.parseResponse({ messages });
    trajectory.forEach(step => onProgress?.(step));

    if (!keepSession) {
      await api("POST", "/api/sessions/delete", { sessionId });
    }

    return {
      trajectory,
      runId: sessionId,
      rawEvents,
      metadata: {
        sessionId,
        sessionName,
        timedOut,
        keepSession,
        workspaceDir: cwd,
        childSessions: Array.from(childSessionIds),
        settledAfterMs,
        ...(fixtureTempPath ? { fixtureTempPath } : {}),
        ...(fixtureSha256 ? { fixtureSha256 } : {}),
        ...(timedOut
          ? { note: `pi-web did not reach full parent/child quiescence within ${timeoutMs}ms; trajectory is partial` }
          : {}),
      },
    };
  }

  parseResponse(rawResponse: any): TrajectoryStep[] {
    const messages: PiWebMessage[] = Array.isArray(rawResponse)
      ? rawResponse
      : Array.isArray(rawResponse?.messages)
        ? rawResponse.messages
        : [];
    const finalAssistantIndex = messages.findLastIndex(
      message => message?.role === "assistant" && Boolean(message.text?.trim()),
    );
    const steps: TrajectoryStep[] = [];
    let sequence = 0;
    const fallbackStart = Date.now();

    const add = (
      type: TrajectoryStep["type"],
      content: string,
      message: PiWebMessage,
      extra: Partial<TrajectoryStep> = {},
      explicitTimestamp?: unknown,
    ): void => {
      if (!content.trim() && type !== "action") return;
      sequence += 1;
      steps.push({
        id: `pi-web-step-${sequence}`,
        timestamp: timestampMs(explicitTimestamp ?? message.timestamp, fallbackStart + sequence),
        type,
        content,
        ...extra,
      });
    };

    messages.forEach((message, messageIndex) => {
      if (!message || typeof message !== "object") return;

      if (message.role === "assistant") {
        const rawContent = message.raw?.content;
        const parts = Array.isArray(rawContent) ? rawContent : [];

        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const block = part as Record<string, any>;
          if (block.type === "thinking") {
            add("thinking", contentText(block.thinking ?? block.text), message);
          } else if (block.type === "toolCall") {
            const toolName = String(block.toolName || block.name || "tool");
            add("action", `Calling ${toolName}...`, message, {
              toolName,
              toolArgs: (block.arguments || block.args || {}) as Record<string, unknown>,
            }, block.startedAt);
          }
        }

        // The simplified transcript's text is the authoritative visible text;
        // its raw content is used above only for hidden thinking and tool calls.
        if (message.text?.trim()) {
          add(
            messageIndex === finalAssistantIndex ? "response" : "assistant",
            message.text.trim(),
            message,
          );
        }

        // Older transcripts may not retain raw content. Fall back to the DTO's
        // projected toolCalls, but do not duplicate calls already mapped above.
        if (parts.every((part: any) => part?.type !== "toolCall")) {
          for (const call of message.toolCalls || []) {
            const toolName = String(call.toolName || "tool");
            add("action", `Calling ${toolName}...`, message, {
              toolName,
              toolArgs: call.args || {},
            }, call.startedAt);
          }
        }
      } else if (message.role === "toolResult") {
        const output = message.text || "";
        add("tool_result", output, message, {
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          toolOutput: output,
          status: message.isError ? "FAILURE" : "SUCCESS",
        });
      }
    });

    return steps;
  }
}

export default PiWebConnector;
