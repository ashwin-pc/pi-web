import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState, PiEvent } from "../app/types.js";
import { activeSessionState, sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import type { MessageDto } from "../../server/session/dto.js";
import { reconnectDelayMs } from "../app/types.js";
import type { ComposerController } from "../composer/composer.js";
import { messageText } from "../messages/content.js";
import type { MessageList, TranscriptRuntimeState, TranscriptIncomplete } from "../messages/messageList.js";
import type { ModelSettings } from "../models/modelSettings.js";
import type { SessionsController } from "../sessions/sessionDrawer.js";
import type { SettingsController } from "../settings/settings.js";
import type { StatusBar } from "../status/statusBar.js";
import type { ToolCards } from "../tools/toolCards.js";
import type { ConversationTreeController } from "../tree/conversationTree.js";
import { assistantErrorBody, normalizeAssistantError } from "../messages/content.js";
import { playCompletionAlerts } from "../app/completionAlerts.js";

export function shouldRefreshSessionsForPiEvent(event: PiEvent | undefined) {
  return event?.type === "message_end";
}

export type RealtimeController = {
  connect: () => void;
  handlePiEvent: (event: PiEvent) => void;
  applyTranscriptRuntimeState: (transcriptState: TranscriptRuntimeState) => void;
};

type AssistantErrorInfo = {
  text: string;
  body: string;
  raw: string;
  attempt?: number;
  maxAttempts?: number;
  attempts?: number;
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
  sessionState: SessionStateController;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  updateWebContribution?: (key: string, sessionId: string) => void;
  addMessage: (role: "system", text: string, extraClass?: string) => HTMLDivElement;
}): RealtimeController {
  const { state, elements, api, composer, messages, models, sessions, settings, status, tools, conversationTree, sessionState, refreshMessages, refreshState, updateWebContribution, addMessage } = options;
  let compactionMessage: HTMLDivElement | null = null;
  let retryErrorCard: HTMLDivElement | null = null;
  let terminalFailureCard: HTMLDivElement | null = null;
  let terminalFailureInfo: AssistantErrorInfo | null = null;
  let terminalFailureSessionId = "";
  let incompleteResponseCard: HTMLDivElement | null = null;
  let incompleteResponseInfo: TranscriptIncomplete | null = null;
  let incompleteResponseSessionId = "";
  let lastAssistantError: AssistantErrorInfo | null = null;
  let retryFinalError: AssistantErrorInfo | null = null;
  let runAborted = false;
  const abortedRuns = new Map<string, boolean>();
  let latestRetryAttempt: number | undefined;
  let latestRetryMaxAttempts: number | undefined;
  let sessionRefreshTimer: number | undefined;
  let replayTranscriptRefreshTimer: number | undefined;
  let sessionRefreshInFlight = false;
  let sessionRefreshQueued = false;
  const terminalRuntimeSessions = new Set<string>();

  function eventWillRetry(event: PiEvent | undefined) {
    return Boolean(event?.willRetry);
  }

  function noteRuntimeEvent(sessionKey: string, event: PiEvent | undefined) {
    if (!sessionKey) return;
    switch (event?.type) {
      case "agent_start":
      case "compaction_start":
        terminalRuntimeSessions.delete(sessionKey);
        break;
      case "agent_end":
        if (!eventWillRetry(event)) terminalRuntimeSessions.add(sessionKey);
        break;
      case "compaction_end":
        if (!eventWillRetry(event)) terminalRuntimeSessions.add(sessionKey);
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

  async function respondInteraction(id: string, response: Record<string, unknown>) {
    const res = await fetch("/api/interactions/respond", {
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

  function handleInteractionRequest(envelope: any) {
    if (envelope.sessionId && envelope.sessionId !== state.currentSessionId) return;
    const id = String(envelope.id || "");
    const data = { ...(envelope.payload || {}), method: envelope.kind };

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
        respondInteraction(id, value === undefined ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "confirm": {
        const confirmed = window.confirm(`${String(data.title || "Confirm")}\n\n${String(data.message || "")}`);
        respondInteraction(id, { confirmed }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "input": {
        const value = window.prompt(String(data.title || "Input"), String(data.placeholder || ""));
        respondInteraction(id, value === null ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      case "editor": {
        const value = window.prompt(String(data.title || "Edit"), String(data.prefill || ""));
        respondInteraction(id, value === null ? { cancelled: true } : { value }).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
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

  function distinctAssistantErrorBody(rawError: unknown, fallback = "") {
    const body = assistantErrorBody(rawError, fallback).trim();
    return body && body !== fallback.trim() ? body : "";
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
      body: distinctAssistantErrorBody(raw || text, text),
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
      body: distinctAssistantErrorBody(raw || text, text),
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

  function expandRuntimeErrorCard(card: HTMLDivElement) {
    card.classList.remove("toolCard--compactCollapsed");
    const toggle = card.querySelector<HTMLButtonElement>(".toolCardExpandToggle");
    if (!toggle) return;
    toggle.textContent = "";
    toggle.setAttribute("aria-label", "Hide tool details");
    toggle.title = "Hide tool details";
    toggle.setAttribute("aria-expanded", "true");
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
    incompleteResponseCard?.remove();
    incompleteResponseCard = null;
    incompleteResponseInfo = null;
    incompleteResponseSessionId = "";
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
    const retryTarget = event.source === "branchSummary" ? "branch summary" : event.source === "compaction" ? "compaction summary" : event.source === "summarization" ? "summary" : "assistant request";
    const retryText = `retrying${attemptText ? ` (${attemptText})` : ""}${delayText ? ` in ${delayText}` : ""}…`;
    status.markActivityProgress(`${info.text} — ${retryText}`, event.lastActivityAt);
    const card = ensureRetryErrorCard(info);
    setRuntimeCardKind(card, "running");
    setRuntimeErrorCardText(
      card,
      `retrying ${retryTarget}`,
      `${info.text} · ${retryText}`,
      `pi is retrying ${retryTarget} automatically.${attemptText ? `\n${attemptText}` : ""}${delayText ? `\nBackoff: ${delayText}` : ""}`,
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
    setRuntimeErrorCardText(card, "retry failed", `${info.text}${attemptText ? ` · ${attemptText}` : ""}`, info.body);
  }

  function terminalErrorFromAgentEnd(event: PiEvent) {
    if (retryFinalError) return retryFinalError;
    const eventMessages = Array.isArray(event.messages) ? event.messages : [];
    for (let index = eventMessages.length - 1; index >= 0; index -= 1) {
      const message = messageFromEvent(eventMessages[index]);
      if (String(message?.role || message?.raw?.role || "") !== "assistant") continue;
      const info = assistantErrorInfoFromMessage(message);
      const attempts = info?.attempts || info?.maxAttempts || info?.attempt || 0;
      if (info && attempts >= 2) return info;
    }
    const attempts = lastAssistantError?.attempts || lastAssistantError?.maxAttempts || lastAssistantError?.attempt || 0;
    return attempts >= 2 ? lastAssistantError : null;
  }

  function focusComposerWith(text: string) {
    composer.setPromptText(text);
    elements.promptEl.focus();
    elements.promptEl.setSelectionRange(elements.promptEl.value.length, elements.promptEl.value.length);
  }

  async function resumeFromTerminalCard(button: HTMLButtonElement, busyText = "Retrying…") {
    button.disabled = true;
    const previousText = button.textContent || "Retry";
    button.textContent = busyText;
    try {
      const res = await fetch("/api/session/retry", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    } catch (error) {
      button.disabled = false;
      button.textContent = previousText;
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function appendTerminalFailureAction(parent: HTMLElement, label: string, title: string, onClick: (button: HTMLButtonElement) => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "runtimeErrorAction";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => onClick(button));
    parent.append(button);
  }

  function addTerminalFailureCard(info: AssistantErrorInfo) {
    terminalFailureCard?.remove();
    const failedAfter = info.attempts || info.maxAttempts || info.attempt;
    const subtitle = failedAfter ? `${info.text} · failed after ${failedAfter} attempts` : info.text;
    const body = [
      failedAfter ? "The model request failed after pi exhausted automatic retries." : "The model request failed.",
      "Retry the failed model request from the last good context without adding a new user message, or switch models if this provider remains rate-limited or overloaded.",
    ].join("\n");
    terminalFailureCard = tools.addRuntimeErrorCard("response failed", subtitle, body);
    expandRuntimeErrorCard(terminalFailureCard);
    const actions = document.createElement("div");
    actions.className = "runtimeErrorActions";
    if (activeSessionState(state)?.capabilities?.retry !== false) appendTerminalFailureAction(actions, "Retry", "Retry the failed model request without adding a user message", (button) => resumeFromTerminalCard(button, "Retrying…"));
    appendTerminalFailureAction(actions, "Switch model", "Use /model to switch providers or models", () => focusComposerWith("/model "));
    terminalFailureCard.append(actions);
    messages.scrollToBottom();
  }

  function addIncompleteResponseCard(info: TranscriptIncomplete) {
    incompleteResponseCard?.remove();
    incompleteResponseCard = tools.addRuntimeErrorCard("response incomplete", info.text, [
      info.body,
      "Continue from the current context without adding a new user message, or switch models if this provider remains unreliable.",
    ].filter(Boolean).join("\n"));
    expandRuntimeErrorCard(incompleteResponseCard);
    const actions = document.createElement("div");
    actions.className = "runtimeErrorActions";
    if (activeSessionState(state)?.capabilities?.retry !== false) appendTerminalFailureAction(actions, "Continue", "Continue the incomplete turn without adding a user message", (button) => resumeFromTerminalCard(button, "Continuing…"));
    appendTerminalFailureAction(actions, "Switch model", "Use /model to switch providers or models", () => focusComposerWith("/model "));
    incompleteResponseCard.append(actions);
    messages.scrollToBottom();
  }

  function restoreTerminalFailureCard() {
    const runtime = sessionRuntime(state);
    if (!terminalFailureInfo || terminalFailureSessionId !== (state.currentSessionId || "") || runtime.isStreaming || runtime.isRetrying) return;
    if (!terminalFailureCard?.isConnected) addTerminalFailureCard(terminalFailureInfo);
  }

  function restoreIncompleteResponseCard() {
    const runtime = sessionRuntime(state);
    if (!incompleteResponseInfo || incompleteResponseSessionId !== (state.currentSessionId || "") || runtime.isStreaming || runtime.isRetrying) return;
    if (!incompleteResponseCard?.isConnected) addIncompleteResponseCard(incompleteResponseInfo);
  }

  function rememberTerminalFailure(info: AssistantErrorInfo | null) {
    terminalFailureInfo = info;
    terminalFailureSessionId = info ? state.currentSessionId || "" : "";
    if (info) {
      incompleteResponseCard?.remove();
      incompleteResponseInfo = null;
      incompleteResponseSessionId = "";
      restoreTerminalFailureCard();
    } else {
      terminalFailureCard?.remove();
      terminalFailureCard = null;
    }
  }

  function rememberIncompleteResponse(info: TranscriptIncomplete | null) {
    incompleteResponseInfo = info;
    incompleteResponseSessionId = info ? state.currentSessionId || "" : "";
    if (info) {
      terminalFailureCard?.remove();
      terminalFailureInfo = null;
      terminalFailureSessionId = "";
      restoreIncompleteResponseCard();
    } else {
      incompleteResponseCard?.remove();
      incompleteResponseCard = null;
    }
  }

  function applyTranscriptRuntimeState(transcriptState: TranscriptRuntimeState) {
    const runtime = sessionRuntime(state);
    if (runtime.isStreaming || runtime.isRetrying) return;
    if (transcriptState.terminalFailure) {
      rememberTerminalFailure({
        text: transcriptState.terminalFailure.text,
        body: transcriptState.terminalFailure.body,
        raw: transcriptState.terminalFailure.raw,
        attempts: transcriptState.terminalFailure.attempts,
      });
      return;
    }
    rememberTerminalFailure(null);
    rememberIncompleteResponse(transcriptState.incomplete || null);
  }

  function handlePiEvent(event: PiEvent, isReplay = false, envelope?: { clientMessageId?: string; sourceClientId?: string }) {
    switch (event.type) {
      case "session_info_changed":
        if ("name" in event) sessionState.applySnapshot({ sessionId: state.currentSessionId, sessionName: event.name });
        break;
      case "agent_start":
        runAborted = false;
        clearTransientFailureUi();
        sessionState.patchRuntime(state.currentSessionId, {
          loaded: true,
          isStreaming: true,
          isRetrying: false,
          isCompacting: false,
          startedAt: event.startedAt,
          lastActivityAt: event.lastActivityAt,
        }, { kind: "start", label: "starting", startedAt: event.startedAt, lastActivityAt: event.lastActivityAt });
        messages.resetStreamingAssistant();
        messages.beginStreamFollow();
        break;
      case "message_start":
        if (event.message?.role === "assistant") messages.beginStreamingAssistant();
        break;
      case "message_update": {
        const deltaEvent = event.assistantMessageEvent;
        if (deltaEvent?.type === "text_start") messages.startStreamingText(deltaEvent.contentIndex);
        else if (deltaEvent?.type === "text_delta") messages.appendStreamingDelta(deltaEvent.delta || "", deltaEvent.contentIndex);
        else if (deltaEvent?.type === "text_end") messages.endStreamingText(deltaEvent.content, deltaEvent.contentIndex);
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
      case "queue_update":
        if (activeSessionState(state)?.capabilities?.queue !== false) sessionState.applySnapshot({ sessionId: state.currentSessionId, queue: { steering: event.steering, followUp: event.followUp } }, { activity: { kind: "preserve" } });
        break;
      case "message_end": {
        const deliveredMessage = messageFromEvent(event.message);
        const deliveredRole = String(deliveredMessage?.role || deliveredMessage?.raw?.role || "");
        if (deliveredRole === "user") {
          composer.handleUserMessage(messageText(deliveredMessage), envelope?.clientMessageId, envelope?.sourceClientId, deliveredMessage.attachments || []);
        }
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
        sessionState.patchRuntime(state.currentSessionId, { isStreaming: false, isRetrying: true }, { kind: "preserve" });
        updateRetryStart(event);
        break;
      case "auto_retry_end":
        sessionState.patchRuntime(state.currentSessionId, { isRetrying: false }, { kind: "preserve" });
        updateRetryEnd(event);
        break;
      case "agent_end": {
        runAborted = Boolean(event.aborted);
        if (eventWillRetry(event)) {
          sessionState.patchRuntime(state.currentSessionId, { isRetrying: true }, { kind: "progress", label: "waiting to retry", lastActivityAt: event.lastActivityAt });
          break;
        }
        // agent_end closes one low-level loop, but extensions and post-run
        // continuations may still run. agent_settled is the idle boundary.
        rememberTerminalFailure(terminalErrorFromAgentEnd(event));
        break;
      }
      case "agent_settled": {
        sessionState.patchRuntime(state.currentSessionId, { isStreaming: false, isRetrying: false }, { kind: "end" });
        messages.resetStreamingAssistant();
        messages.endStreamFollow();
        tools.clearActiveToolCards();
        if (!isReplay) refreshMessages()
          .then(() => {
            retryErrorCard = null;
            restoreTerminalFailureCard();
            restoreIncompleteResponseCard();
            return sessions.markSessionRead();
          })
          .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        if (!isReplay && conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
        status.refreshSessionTitle();
        break;
      }
      case "compaction_start":
        sessionState.patchRuntime(state.currentSessionId, {
          loaded: true,
          isStreaming: false,
          isRetrying: false,
          isCompacting: true,
          startedAt: event.startedAt,
          lastActivityAt: event.lastActivityAt,
        }, { kind: "start", label: "compacting", startedAt: event.startedAt, lastActivityAt: event.lastActivityAt });
        break;
      case "compaction_end": {
        if (eventWillRetry(event)) {
          sessionState.patchRuntime(state.currentSessionId, { isCompacting: false, isRetrying: true }, { kind: "progress", label: "waiting to retry", lastActivityAt: event.lastActivityAt });
          break;
        }
        sessionState.patchRuntime(state.currentSessionId, { isCompacting: false, isRetrying: false }, { kind: "end" });
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
        if (activeSessionState(state)?.capabilities?.thinkingLevel === false) break;
        sessionState.applySnapshot({ sessionId: state.currentSessionId, thinkingLevel: event.level || state.currentThinkingLevel });
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
        const appliesToCurrentSession = !data.sessionId || !state.currentSessionId || data.sessionId === state.currentSessionId;
        sessionState.applySnapshot(data, { activate: data.type === "hello" && !state.currentSessionId });
        if (!appliesToCurrentSession) return;
        if (data.thinkingLevels) models.updateThinkingOptions(data.thinkingLevels);
        if (elements.modelSelectEl.options.length) elements.modelSelectEl.value = state.currentModelKey;
        if (data.type === "state_changed" && !isReplay && data.sourceClientId !== api.clientId) {
          refreshMessages()
            .then(() => {
              restoreTerminalFailureCard();
              restoreIncompleteResponseCard();
            })
            .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          scheduleSessionRefresh();
        }
        return;
      }
      if (data.type === "session_deleted") {
        if (!isReplay) sessions.removeSession(String(data.sessionId || ""));
        return;
      }
      if (data.type === "session_runtime_changed") {
        const key = String(data.sessionId || data.sessionFile || "");
        if (isStaleRunningRuntimeAfterTerminal(key, data.runtime)) return;
        if (key && (!data.runtime?.isRunning || typeof data.runtime?.startedAt === "string")) terminalRuntimeSessions.delete(key);
        if (!data.sessionId) return;
        const transition = sessionState.replaceRuntime(String(data.sessionId), data.runtime);
        // Any runtime change (including a spawned child's) can flip the
        // current session's derived "waiting on spawned sessions" state.
        status.updateWaitingStatus(sessions.waitingInfoFor(state.currentSessionId || ""));
        if (transition.isActive && transition.previous.isRunning && !transition.next.isRunning) {
          refreshMessages()
            .then(() => {
              restoreTerminalFailureCard();
              restoreIncompleteResponseCard();
              return sessions.markSessionRead();
            })
            .catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          status.refreshSessionTitle();
        }
        return;
      }
      if (data.type === "models_updated") {
        if (!data.sessionId || data.sessionId === state.currentSessionId) models.populateModelSelect(data.models || [], state.currentModelKey);
        return;
      }
      if (data.type === "session_stats_changed") {
        sessionState.updateStats(String(data.sessionId || state.currentSessionId), data.stats);
        return;
      }
      if (data.type === "settings_updated") {
        settings.applySettings(data.settings);
        return;
      }
      if (data.type === "web_settings_schemas_changed") {
        settings.applyWebSettingsSchemas(data.webSettingsSchemas);
        return;
      }
      if (data.type === "session_ui_state_changed") {
        sessions.applySessionUiState(data.sessionUiState);
        status.updateWaitingStatus(sessions.waitingInfoFor(state.currentSessionId || ""));
        return;
      }
      if (data.type === "interaction_request" || data.type === "interaction_effect") {
        handleInteractionRequest(data);
        return;
      }
      if (data.type === "web_contributions_changed") {
        sessionState.applySnapshot(data);
        return;
      }
      if (data.type === "web_contribution_updated") {
        const sessionId = String(data.sessionId || "");
        const key = typeof data.key === "string" ? data.key : "";
        if (key && sessionId === state.currentSessionId) updateWebContribution?.(key, sessionId);
        return;
      }
      if (data.type === "committed_message") {
        const appliesToCurrentSession = !data.sessionId || data.sessionId === state.currentSessionId;
        if (isReplay && appliesToCurrentSession) {
          if (replayTranscriptRefreshTimer !== undefined) window.clearTimeout(replayTranscriptRefreshTimer);
          replayTranscriptRefreshTimer = window.setTimeout(() => {
            replayTranscriptRefreshTimer = undefined;
            void refreshMessages().catch((error) => console.error("Could not reconcile replayed transcript messages", error));
          }, 100);
          return;
        }
        const committed = data.message as MessageDto | undefined;
        if (committed && appliesToCurrentSession && !["user", "assistant", "toolResult"].includes(committed.role)) {
          messages.appendCommittedMessage(committed, {
            addToolHistoryCard: tools.addToolHistoryCard,
            addPendingToolCard: tools.startTool,
            addRuntimeErrorCard: tools.addRuntimeErrorCard,
            isStreaming: sessionRuntime(state).isStreaming || sessionRuntime(state).isRetrying,
          });
        }
        return;
      }
      if (data.type === "agent_event") {
        const eventSessionKey = String(data.sessionId || data.sessionFile || "");
        noteRuntimeEvent(eventSessionKey, data.event);
        if (data.event?.type === "agent_start") abortedRuns.set(eventSessionKey, false);
        if (data.event?.type === "agent_end") abortedRuns.set(eventSessionKey, Boolean(data.event.aborted));
        if (!isReplay && data.event?.type === "agent_settled" && !abortedRuns.get(eventSessionKey)) playCompletionAlerts();
        if (data.event?.type === "agent_settled") abortedRuns.delete(eventSessionKey);
        if (!isReplay && data.event?.type === "session_info_changed") {
          sessions.updateSessionName(String(data.sessionId || ""), String(data.event.name || ""));
        } else if (!isReplay && shouldRefreshSessionsForPiEvent(data.event)) scheduleSessionRefresh();
        const appliesToCurrentSession = !data.sessionId || data.sessionId === state.currentSessionId;
        if (data.sessionId && !appliesToCurrentSession) {
          if (data.event?.type === "agent_start") {
            sessionState.replaceRuntime(String(data.sessionId), { loaded: true, isRunning: true, isStreaming: true, isRetrying: false, isCompacting: false, startedAt: data.event.startedAt, lastActivityAt: data.event.lastActivityAt, pendingMessageCount: 0 }, { kind: "preserve" });
          } else if (data.event?.type === "agent_end" && eventWillRetry(data.event)) {
            sessionState.patchRuntime(String(data.sessionId), { isRetrying: true }, { kind: "preserve" });
          } else if (data.event?.type === "agent_settled") {
            sessionState.replaceRuntime(String(data.sessionId), { loaded: true, isRunning: false, isStreaming: false, isRetrying: false, isCompacting: false, lastActivityAt: data.event.lastActivityAt, pendingMessageCount: 0 }, { kind: "preserve" });
          } else if (data.event?.type === "compaction_start") {
            sessionState.replaceRuntime(String(data.sessionId), { loaded: true, isRunning: true, isStreaming: false, isRetrying: false, isCompacting: true, startedAt: data.event.startedAt, lastActivityAt: data.event.lastActivityAt, pendingMessageCount: 0 }, { kind: "preserve" });
          } else if (data.event?.type === "compaction_end") {
            sessionState.replaceRuntime(String(data.sessionId), { loaded: true, isRunning: eventWillRetry(data.event), isStreaming: false, isRetrying: eventWillRetry(data.event), isCompacting: false, lastActivityAt: data.event.lastActivityAt, pendingMessageCount: 0 }, { kind: "preserve" });
          } else if (data.event?.type === "queue_update") {
            sessionState.applySnapshot({ sessionId: data.sessionId, queue: { steering: data.event.steering, followUp: data.event.followUp } }, { activity: { kind: "preserve" } });
          }
        }
        if (appliesToCurrentSession) handlePiEvent(data.event, isReplay, data);
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

  return { connect, handlePiEvent, applyTranscriptRuntimeState };
}
