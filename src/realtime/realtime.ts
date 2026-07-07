import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState, PiEvent } from "../app/types.js";
import { reconnectDelayMs } from "../app/types.js";
import type { ComposerController } from "../composer/composer.js";
import type { MessageList } from "../messages/messageList.js";
import type { ModelSettings } from "../models/modelSettings.js";
import type { SessionsController } from "../sessions/sessionDrawer.js";
import type { SettingsController } from "../settings/settings.js";
import type { StatusBar } from "../status/statusBar.js";
import type { ToolCards } from "../tools/toolCards.js";
import type { ConversationTreeController } from "../tree/conversationTree.js";
import { renderWebFooters } from "../extensions/webFooter.js";
import { assistantErrorBody, normalizeAssistantError } from "../messages/content.js";

export type RealtimeController = {
  connect: () => void;
  handlePiEvent: (event: PiEvent) => void;
};

type AssistantErrorInfo = {
  text: string;
  body: string;
  raw: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
};

export function createRealtime(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  composer: ComposerController;
  messages: MessageList;
  models: ModelSettings;
  sessions: SessionsController;
  settings: SettingsController;
  status: StatusBar;
  tools: ToolCards;
  conversationTree?: ConversationTreeController;
  updateMeta: (data: any) => void;
  updateSessionStats: (stats: any) => void;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  addMessage: (role: "system", text: string, extraClass?: string) => HTMLDivElement;
}): RealtimeController {
  const { state, elements, api, composer, messages, models, sessions, settings, status, tools, conversationTree, updateMeta, updateSessionStats, refreshMessages, refreshState, addMessage } = options;
  let compactionMessage: HTMLDivElement | null = null;
  let retryErrorCard: HTMLDivElement | null = null;
  let terminalFailureCard: HTMLDivElement | null = null;
  let terminalFailureInfo: AssistantErrorInfo | null = null;
  let terminalFailureSessionId = "";
  let lastAssistantError: AssistantErrorInfo | null = null;
  let retryFinalError: AssistantErrorInfo | null = null;
  let latestRetryAttempt: number | undefined;
  let latestRetryMaxAttempts: number | undefined;
  let sessionRefreshTimer: number | undefined;
  let sessionRefreshInFlight = false;
  let sessionRefreshQueued = false;
  const sessionRuntimeKeys = new Map<string, string>();
  const terminalRuntimeSessions = new Set<string>();

  function runtimeKey(runtime: any) {
    return [
      Boolean(runtime?.isRunning),
      Boolean(runtime?.isStreaming),
      Boolean(runtime?.isCompacting),
    ].join(":");
  }

  function shouldRefreshSessionsForPiEvent(event: PiEvent | undefined) {
    switch (event?.type) {
      case "session_info_changed":
      case "message_end":
      case "agent_end":
      case "compaction_end":
        return true;
      default:
        return false;
    }
  }

  function noteRuntimeEvent(sessionKey: string, event: PiEvent | undefined) {
    if (!sessionKey) return;
    switch (event?.type) {
      case "agent_start":
      case "compaction_start":
        terminalRuntimeSessions.delete(sessionKey);
        break;
      case "agent_end":
      case "compaction_end":
        terminalRuntimeSessions.add(sessionKey);
        break;
    }
  }

  function isStaleRunningRuntimeAfterTerminal(sessionKey: string, runtime: any) {
    return Boolean(sessionKey)
      && terminalRuntimeSessions.has(sessionKey)
      && Boolean(runtime?.isRunning)
      && !(typeof runtime?.startedAt === "string" && runtime.startedAt.trim());
  }

  function scheduleSessionRefresh(delay = 250) {
    if (elements.sessionDrawer.hidden) return;
    if (sessionRefreshTimer !== undefined) return;
    sessionRefreshTimer = window.setTimeout(() => {
      sessionRefreshTimer = undefined;
      void runSessionRefresh();
    }, delay);
  }

  async function runSessionRefresh() {
    if (elements.sessionDrawer.hidden) return;
    if (sessionRefreshInFlight) {
      sessionRefreshQueued = true;
      return;
    }
    sessionRefreshInFlight = true;
    try {
      await sessions.refreshSessions();
    } catch (_error) {
      // Drawer metadata is best-effort; current session state/messages are synced separately.
    } finally {
      sessionRefreshInFlight = false;
      if (sessionRefreshQueued) {
        sessionRefreshQueued = false;
        scheduleSessionRefresh(500);
      }
    }
  }

  function formatTokenCount(tokens: unknown) {
    return typeof tokens === "number" && Number.isFinite(tokens) ? tokens.toLocaleString() : "unknown";
  }

  function compactionStartText(event: PiEvent) {
    if (event.reason === "manual") return "Compacting context…";
    if (event.reason === "overflow") return "Context overflow detected. Auto-compacting context…";
    return "Auto-compacting context…";
  }

  function compactionEndText(event: PiEvent) {
    if (event.aborted) return event.reason === "manual" ? "Compaction cancelled." : "Auto-compaction cancelled.";
    if (event.errorMessage) return `Compaction failed: ${event.errorMessage}`;
    const result = event.result || {};
    const header = `Context compacted from ${formatTokenCount(result.tokensBefore)} tokens.`;
    return result.summary ? `${header}\n\n${result.summary}` : header;
  }

  async function abortCompaction(button: HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "Cancelling…";
    try {
      const res = await fetch("/api/compaction/abort", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    } catch (error) {
      button.disabled = false;
      button.textContent = "Cancel";
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function respondExtensionUi(id: string, response: Record<string, unknown>) {
    const res = await fetch("/api/extension-ui/respond", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ id, ...response }),
    });
    if (!res.ok) throw new Error(await res.text());
  }

  function promptForSelect(title: string, options: string[]) {
    const answer = window.prompt(
      `${title}\n\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\nEnter a number or exact value:`,
      options[0] || "",
    );
    if (answer === null) return undefined;
    const numeric = Number(answer.trim());
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return options[numeric - 1];
    return options.find((option) => option === answer) || answer;
  }

  function handleExtensionUiRequest(data: any) {
    if (data.sessionId && data.sessionId !== state.currentSessionId) return;
    const id = String(data.id || "");

    switch (data.method) {
      case "notify":
        addMessage("system", String(data.message || ""), data.notifyType === "error" ? "error" : undefined);
        return;
      case "set_editor_text":
        composer.setPromptText(String(data.text || ""));
        return;
      case "setTitle":
        document.title = String(data.title || "pi web");
        return;
      case "select": {
        const options = Array.isArray(data.options) ? data.options.map(String) : [];
        const value = promptForSelect(String(data.title || "Select"), options);
        respondExtensionUi(id, value === undefined ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "confirm": {
        const confirmed = window.confirm(`${String(data.title || "Confirm")}\n\n${String(data.message || "")}`);
        respondExtensionUi(id, { confirmed }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "input": {
        const value = window.prompt(String(data.title || "Input"), String(data.placeholder || ""));
        respondExtensionUi(id, value === null ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "editor": {
        const value = window.prompt(String(data.title || "Edit"), String(data.prefill || ""));
        respondExtensionUi(id, value === null ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
    }
  }

  function setCompactionMessage(text: string, extraClass = "compaction", cancellable = false) {
    const target = compactionMessage?.isConnected ? compactionMessage : addMessage("system", "", extraClass);
    compactionMessage = target;
    target.className = `message system ${extraClass}`.trim();
    target.querySelector(".compactionCancel")?.remove();
    const body = target.querySelector<HTMLElement>(".body");
    if (body) body.textContent = text;
    if (cancellable) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "compactionCancel";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => abortCompaction(cancelButton));
      target.append(cancelButton);
    }
    messages.scrollToBottom();
  }

  function numericEventValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  function formatRetryDelay(delayMs?: number) {
    if (!delayMs || delayMs <= 0) return "";
    const totalSeconds = Math.max(1, Math.round(delayMs / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  }

  function retryAttemptText(attempt?: number, maxAttempts?: number) {
    if (!attempt) return "";
    return maxAttempts ? `attempt ${attempt}/${maxAttempts}` : `attempt ${attempt}`;
  }

  function messageFromEvent(value: any) {
    return value?.message && typeof value.message === "object" && value.message.message ? value.message.message : value?.message || value;
  }

  function assistantErrorInfoFromMessage(value: any): AssistantErrorInfo | null {
    const message = messageFromEvent(value);
    const role = String(message?.raw?.role || message?.role || "");
    const raw = String(message?.raw?.errorMessage || message?.errorMessage || "").trim();
    const stopReason = String(message?.raw?.stopReason || message?.stopReason || "").trim();
    if (role && role !== "assistant") return null;
    if (!raw && stopReason !== "error") return null;
    const text = normalizeAssistantError(raw || stopReason) || "Assistant error";
    return {
      text,
      body: assistantErrorBody(raw || text, text),
      raw: raw || text,
      attempt: latestRetryAttempt,
      maxAttempts: latestRetryMaxAttempts,
    };
  }

  function assistantErrorInfoFromRetryEvent(event: PiEvent): AssistantErrorInfo {
    const attempt = numericEventValue(event.attempt) ?? latestRetryAttempt;
    const maxAttempts = numericEventValue(event.maxAttempts) ?? numericEventValue(event.maxRetries) ?? latestRetryMaxAttempts;
    const delayMs = numericEventValue(event.delayMs);
    const raw = String(event.errorMessage || event.finalError || lastAssistantError?.raw || "").trim();
    const text = normalizeAssistantError(raw) || lastAssistantError?.text || "Transient model error";
    return {
      text,
      body: assistantErrorBody(raw || text, text),
      raw: raw || text,
      attempt,
      maxAttempts,
      delayMs,
    };
  }

  function setRuntimeCardKind(card: HTMLDivElement, kind: "error" | "running" | "success") {
    card.classList.remove("toolCard--error", "toolCard--running", "toolCard--success");
    card.classList.add(kind === "running" ? "toolCard--running" : kind === "success" ? "toolCard--success" : "toolCard--error");
  }

  function setRuntimeErrorCardText(card: HTMLDivElement, title: string, subtitle: string, body: string) {
    const name = card.querySelector<HTMLElement>(".toolCardName");
    if (name) name.textContent = title;
    const label = card.querySelector<HTMLElement>(".toolCardLabel");
    let subtitleEl = card.querySelector<HTMLElement>(".toolCardSubtitle");
    if (subtitle) {
      if (!subtitleEl && label) {
        subtitleEl = document.createElement("span");
        subtitleEl.className = "toolCardSubtitle";
        label.append(subtitleEl);
      }
      if (subtitleEl) subtitleEl.textContent = subtitle;
    } else {
      subtitleEl?.remove();
    }

    card.querySelector(".toolCardCollapseToggle")?.remove();
    let bodyEl = card.querySelector<HTMLElement>(".toolCardBody");
    if (!body) {
      bodyEl?.remove();
    } else {
      if (!bodyEl) {
        bodyEl = document.createElement("pre");
        bodyEl.className = "toolCardBody";
        card.append(bodyEl);
      }
      bodyEl.classList.remove("collapsed");
      bodyEl.textContent = body;
    }
    messages.scrollToBottom();
  }

  function ensureRetryErrorCard(info: AssistantErrorInfo) {
    if (!retryErrorCard?.isConnected) {
      messages.invalidateRefreshes();
      retryErrorCard = tools.addRuntimeErrorCard("assistant error", info.text, info.body);
    }
    return retryErrorCard;
  }

  function clearTransientFailureUi() {
    retryErrorCard?.remove();
    retryErrorCard = null;
    terminalFailureCard?.remove();
    terminalFailureCard = null;
    terminalFailureInfo = null;
    terminalFailureSessionId = "";
    lastAssistantError = null;
    retryFinalError = null;
    latestRetryAttempt = undefined;
    latestRetryMaxAttempts = undefined;
  }

  function updateRetryStart(event: PiEvent) {
    const info = assistantErrorInfoFromRetryEvent(event);
    latestRetryAttempt = info.attempt;
    latestRetryMaxAttempts = info.maxAttempts;
    lastAssistantError = info;
    retryFinalError = null;
    const attemptText = retryAttemptText(info.attempt, info.maxAttempts);
    const delayText = formatRetryDelay(info.delayMs);
    const retryText = `retrying${attemptText ? ` (${attemptText})` : ""}${delayText ? ` in ${delayText}` : ""}…`;
    status.markActivityProgress(`${info.text} — ${retryText}`, event.lastActivityAt);
    const card = ensureRetryErrorCard(info);
    setRuntimeCardKind(card, "running");
    setRuntimeErrorCardText(
      card,
      "retrying assistant request",
      `${info.text} · ${retryText}`,
      `pi is retrying automatically after a transient provider error.${attemptText ? `\n${attemptText}` : ""}${delayText ? `\nBackoff: ${delayText}` : ""}`,
    );
  }

  function updateRetryEnd(event: PiEvent) {
    const info = assistantErrorInfoFromRetryEvent(event);
    latestRetryAttempt = info.attempt;
    latestRetryMaxAttempts = info.maxAttempts;
    if (event.success) {
      retryFinalError = null;
      lastAssistantError = null;
      status.markActivityProgress("responding", event.lastActivityAt);
      if (retryErrorCard?.isConnected) {
        setRuntimeCardKind(retryErrorCard, "success");
        const attemptText = retryAttemptText(info.attempt, info.maxAttempts);
        setRuntimeErrorCardText(retryErrorCard, "retry recovered", attemptText ? `resumed after ${attemptText}` : "assistant request resumed", info.text ? `Earlier error: ${info.text}` : "");
      }
      return;
    }

    retryFinalError = info;
    lastAssistantError = info;
    status.markActivityProgress("retry failed", event.lastActivityAt);
    const card = ensureRetryErrorCard(info);
    setRuntimeCardKind(card, "error");
    const attemptText = retryAttemptText(info.attempt, info.maxAttempts);
    setRuntimeErrorCardText(card, "retry failed", `${info.text}${attemptText ? ` · ${attemptText}` : ""}`, info.body || info.text);
  }

  function terminalErrorFromAgentEnd(event: PiEvent) {
    const eventMessages = Array.isArray(event.messages) ? event.messages : [];
    for (let index = eventMessages.length - 1; index >= 0; index -= 1) {
      const message = messageFromEvent(eventMessages[index]);
      if (String(message?.role || message?.raw?.role || "") !== "assistant") continue;
      return assistantErrorInfoFromMessage(message);
    }
    return retryFinalError || lastAssistantError;
  }

  function focusComposerWith(text: string) {
    composer.setPromptText(text);
    elements.promptEl.focus();
    elements.promptEl.setSelectionRange(elements.promptEl.value.length, elements.promptEl.value.length);
  }

  function appendTerminalFailureAction(parent: HTMLElement, label: string, title: string, text: string) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "runtimeErrorAction";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => focusComposerWith(text));
    parent.append(button);
  }

  function addTerminalFailureCard(info: AssistantErrorInfo) {
    terminalFailureCard?.remove();
    const failedAfter = info.maxAttempts || info.attempt;
    const subtitle = failedAfter ? `${info.text} · failed after ${failedAfter} retries` : info.text;
    const body = [
      failedAfter ? "The model request failed after pi exhausted automatic retries." : "The model request failed.",
      "Try again, or switch models if this provider is rate-limited or overloaded.",
    ].join("\n");
    terminalFailureCard = tools.addRuntimeErrorCard("response failed", subtitle, body);
    const actions = document.createElement("div");
    actions.className = "runtimeErrorActions";
    appendTerminalFailureAction(actions, "Retry", "Fill the composer with a retry request", "Please retry the previous request.");
    appendTerminalFailureAction(actions, "Switch model", "Use /model to switch providers or models", "/model ");
    terminalFailureCard.append(actions);
    messages.scrollToBottom();
  }

  function restoreTerminalFailureCard() {
    if (!terminalFailureInfo || terminalFailureSessionId !== (state.currentSessionId || "") || state.isStreaming) return;
    if (!terminalFailureCard?.isConnected) addTerminalFailureCard(terminalFailureInfo);
  }

  function rememberTerminalFailure(info: AssistantErrorInfo | null) {
    terminalFailureInfo = info;
    terminalFailureSessionId = info ? state.currentSessionId || "" : "";
    if (info) restoreTerminalFailureCard();
  }

  function handlePiEvent(event: PiEvent, isReplay = false) {
    switch (event.type) {
      case "session_info_changed":
        if ("name" in event) status.setStatusTitle(event.name || "New session");
        break;
      case "agent_start":
        clearTransientFailureUi();
        state.isStreaming = true;
        status.markActivityStart("starting", event.startedAt, event.lastActivityAt);
        composer.updatePrimaryAction();
        messages.resetStreamingAssistant();
        messages.beginStreamFollow();
        break;
      case "message_update": {
        const deltaEvent = event.assistantMessageEvent;
        if (deltaEvent?.type === "text_delta") messages.appendStreamingDelta(deltaEvent.delta || "");
        else if (deltaEvent?.type === "thinking_start") messages.startStreamingThinking(deltaEvent.contentIndex);
        else if (deltaEvent?.type === "thinking_delta") messages.appendStreamingThinkingDelta(deltaEvent.delta || "", deltaEvent.contentIndex);
        else if (deltaEvent?.type === "thinking_end") messages.endStreamingThinking(deltaEvent.content || deltaEvent.thinking, deltaEvent.contentIndex);
        status.markActivityProgress(deltaEvent?.type?.startsWith("thinking") ? "thinking" : "responding", event.lastActivityAt);
        break;
      }
      case "tool_execution_start":
        messages.invalidateRefreshes();
        tools.startTool(event.toolCallId, event.toolName || "tool", event.args || {}, event.startedAt);
        status.markActivityProgress(`tool: ${event.toolName || "tool"}`, event.lastActivityAt);
        break;
      case "tool_execution_update":
        messages.invalidateRefreshes();
        tools.updateToolProgress(event.toolCallId, event.toolName || "tool", event.partialResult, event.args || {}, event.startedAt);
        status.markActivityProgress(`tool: ${event.toolName || "tool"}`, event.lastActivityAt);
        break;
      case "tool_execution_end":
        messages.invalidateRefreshes();
        tools.endTool(event.toolCallId, event.toolName || "tool", Boolean(event.isError), event.result);
        status.markActivityProgress("waiting for assistant", event.lastActivityAt);
        break;
      case "message_end": {
        const errorInfo = assistantErrorInfoFromMessage(event.message);
        if (errorInfo) {
          lastAssistantError = errorInfo;
          const card = ensureRetryErrorCard(errorInfo);
          setRuntimeCardKind(card, "error");
          setRuntimeErrorCardText(card, "assistant error", errorInfo.text, errorInfo.body);
        } else {
          const message = messageFromEvent(event.message);
          if (String(message?.role || message?.raw?.role || "") === "assistant") {
            lastAssistantError = null;
            retryFinalError = null;
          }
        }
        break;
      }
      case "auto_retry_start":
        updateRetryStart(event);
        break;
      case "auto_retry_end":
        updateRetryEnd(event);
        break;
      case "agent_end": {
        const terminalError = terminalErrorFromAgentEnd(event);
        state.isStreaming = false;
        rememberTerminalFailure(terminalError);
        status.markActivityEnd();
        composer.updatePrimaryAction();
        messages.resetStreamingAssistant();
        messages.endStreamFollow();
        tools.clearActiveToolCards();
        if (!isReplay) refreshMessages()
          .then(() => {
            retryErrorCard = null;
            restoreTerminalFailureCard();
            return sessions.markSessionRead();
          })
          .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        if (!isReplay && conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
        status.refreshSessionTitle();
        break;
      }
      case "compaction_start":
        state.isCompacting = true;
        status.markActivityStart("compacting", event.startedAt, event.lastActivityAt);
        updateSessionStats(state.stats);
        break;
      case "compaction_end": {
        state.isCompacting = false;
        status.markActivityEnd();
        updateSessionStats(state.stats);
        const extraClass = event.errorMessage && !event.aborted ? "compaction error" : "compaction";
        setCompactionMessage(compactionEndText(event), extraClass);
        compactionMessage = null;
        if (event.result) {
          if (!isReplay) refreshMessages()
            .then(() => sessions.markSessionRead())
            .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (!isReplay && conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          status.refreshSessionTitle();
        }
        break;
      }
      case "thinking_level_changed":
        state.currentThinkingLevel = event.level || state.currentThinkingLevel;
        elements.thinkingSelectEl.value = state.currentThinkingLevel;
        models.updateSummary();
        refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        break;
    }
  }

  function connect() {
    const ws = new WebSocket(api.wsUrl());
    ws.addEventListener("open", () => {
      status.markWebSocketOpen();
      composer.updatePrimaryAction();
    });
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (typeof data.seq === "number" && Number.isFinite(data.seq) && data.seq > state.lastRealtimeSeq) {
        state.lastRealtimeSeq = data.seq;
      }
      if (data.type === "sync_required") {
        if (typeof data.latestSeq === "number" && Number.isFinite(data.latestSeq) && data.latestSeq >= 0) {
          state.lastRealtimeSeq = data.latestSeq;
        }
        status.markSyncRequired();
        return;
      }
      const isReplay = data.replay === true;
      if (data.type === "hello" || data.type === "state_changed") {
        if (data.sessionId && state.currentSessionId && data.sessionId !== state.currentSessionId) return;
        updateMeta(data);
        state.isStreaming = Boolean(data.isStreaming);
        state.isCompacting = Boolean(data.isCompacting);
        if (state.isStreaming || state.isCompacting) status.markActivityStart(
          state.isCompacting ? "compacting" : "active",
          data.runtimeStartedAt || data.runtime?.startedAt,
          data.runtimeLastActivityAt || data.runtime?.lastActivityAt,
        );
        else status.markActivityEnd();
        updateSessionStats(state.stats);
        composer.updatePrimaryAction();
        if (data.thinkingLevels) models.updateThinkingOptions(data.thinkingLevels);
        if (elements.modelSelectEl.options.length) elements.modelSelectEl.value = state.currentModelKey;
        if (data.type === "state_changed" && !isReplay && data.sourceClientId !== api.clientId) {
          refreshMessages()
            .then(restoreTerminalFailureCard)
            .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          scheduleSessionRefresh();
        }
        return;
      }
      if (data.type === "session_deleted") {
        if (!isReplay) scheduleSessionRefresh();
        return;
      }
      if (data.type === "session_runtime_changed") {
        const key = String(data.sessionId || data.sessionFile || "");
        if (isStaleRunningRuntimeAfterTerminal(key, data.runtime)) return;
        if (key && (!data.runtime?.isRunning || typeof data.runtime?.startedAt === "string")) terminalRuntimeSessions.delete(key);
        const nextRuntimeKey = runtimeKey(data.runtime);
        if (key && sessionRuntimeKeys.get(key) !== nextRuntimeKey) {
          sessionRuntimeKeys.set(key, nextRuntimeKey);
          sessions.updateSessionRuntime(String(data.sessionId || ""), data.runtime);
        }
        if (data.sessionId && data.sessionId === state.currentSessionId) {
          const wasRunning = state.isStreaming || state.isCompacting;
          const isRunning = Boolean(data.runtime?.isRunning);
          state.isStreaming = Boolean(data.runtime?.isStreaming);
          state.isCompacting = Boolean(data.runtime?.isCompacting);
          if (isRunning) {
            if (wasRunning) status.markActivityProgress(undefined, data.runtime?.lastActivityAt);
            else status.markActivityStart(state.isCompacting ? "compacting" : "active", data.runtime?.startedAt, data.runtime?.lastActivityAt);
          } else status.markActivityEnd();
          composer.updatePrimaryAction();
          if (wasRunning && !isRunning) {
            refreshMessages()
              .then(() => {
                restoreTerminalFailureCard();
                return sessions.markSessionRead();
              })
              .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
            if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
            status.refreshSessionTitle();
          }
        }
        return;
      }
      if (data.type === "models_updated") {
        if (!data.sessionId || data.sessionId === state.currentSessionId) models.populateModelSelect(data.models || [], state.currentModelKey);
        return;
      }
      if (data.type === "session_stats_changed") {
        if (!data.sessionId || data.sessionId === state.currentSessionId) updateSessionStats(data.stats);
        return;
      }
      if (data.type === "settings_updated") {
        settings.applySettings(data.settings);
        return;
      }
      if (data.type === "session_ui_state_changed") {
        sessions.applySessionUiState(data.sessionUiState);
        return;
      }
      if (data.type === "extension_ui_request") {
        handleExtensionUiRequest(data);
        return;
      }
      if (data.type === "web_footer_changed") {
        if (!data.sessionId || data.sessionId === state.currentSessionId) renderWebFooters(elements.extensionFooterEl, data.webFooters);
        return;
      }
      if (data.type === "web_header_actions_changed") {
        if (!data.sessionId || data.sessionId === state.currentSessionId) updateMeta(data);
        return;
      }
      if (data.type === "pi_event") {
        const eventSessionKey = String(data.sessionId || data.sessionFile || "");
        noteRuntimeEvent(eventSessionKey, data.event);
        if (!isReplay && shouldRefreshSessionsForPiEvent(data.event)) scheduleSessionRefresh();
        if (data.sessionId) {
          if (data.event?.type === "agent_start") {
            sessions.updateSessionRuntime(String(data.sessionId), { loaded: true, isRunning: true, isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
          } else if (data.event?.type === "agent_end") {
            sessions.updateSessionRuntime(String(data.sessionId), { loaded: true, isRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
          } else if (data.event?.type === "compaction_start") {
            sessions.updateSessionRuntime(String(data.sessionId), { loaded: true, isRunning: true, isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
          } else if (data.event?.type === "compaction_end") {
            sessions.updateSessionRuntime(String(data.sessionId), { loaded: true, isRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
          }
        }
        if (!data.sessionId || data.sessionId === state.currentSessionId) handlePiEvent(data.event, isReplay);
        return;
      }
      if (data.type === "server_error" && (!data.sessionId || data.sessionId === state.currentSessionId)) addMessage("system", data.error, "error");
    });
    ws.addEventListener("close", () => {
      status.markWebSocketClosed();
      composer.updatePrimaryAction();
      window.setTimeout(connect, reconnectDelayMs);
    });
  }

  return { connect, handlePiEvent };
}
