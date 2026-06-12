import hljs from "highlight.js/lib/common";
import { renderEditDiff } from "../components/editDiff.js";
import { textFromRawContent } from "../messages/content.js";

export type ToolCards = {
  addToolCard: (toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date) => HTMLDivElement;
  updateToolCard: (card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) => void;
  addToolHistoryCard: (toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) => void;
  addRuntimeErrorCard: (title: string, subtitle: string, body: string) => void;
  startTool: (toolCallId: string | undefined, toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date) => void;
  updateToolProgress: (toolCallId: string | undefined, toolName: string, partialResult?: unknown, args?: Record<string, unknown>, startedAt?: string | number | Date) => void;
  endTool: (toolCallId: string | undefined, toolName: string, isError: boolean, result?: unknown) => void;
  clearActiveToolCards: () => void;
};

function toolSubtitle(toolName: string, args: Record<string, unknown>): string {
  if (!args) return "";
  const order = ["path", "command", "pattern", "query", "url"];
  for (const key of order) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  for (const val of Object.values(args)) {
    if (typeof val === "string") return val;
  }
  return "";
}

function isCompactDensity() {
  return document.documentElement.dataset.density === "compact";
}

function updateCompactToggle(toggle: HTMLButtonElement, collapsed: boolean) {
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.setAttribute("aria-label", collapsed ? "Show tool details" : "Hide tool details");
  toggle.title = collapsed ? "Show tool details" : "Hide tool details";
  toggle.setAttribute("aria-expanded", String(!collapsed));
}

function setCompactCollapsed(card: HTMLDivElement, collapsed: boolean) {
  card.classList.toggle("toolCard--compactCollapsed", collapsed);
  const toggle = card.querySelector<HTMLButtonElement>(".toolCardExpandToggle");
  if (toggle) updateCompactToggle(toggle, collapsed);
}

function addToolArgsDetails(card: HTMLDivElement, args?: Record<string, unknown>) {
  if (!args || Object.keys(args).length === 0) return;

  const details = document.createElement("details");
  details.className = "toolCardDetails";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "toolCardSummary";
  summary.textContent = "Arguments";

  const pre = document.createElement("pre");
  pre.className = "toolCardArgs";
  pre.textContent = JSON.stringify(args, null, 2);

  details.append(summary, pre);
  card.append(details);
}

function addCardHeader(card: HTMLDivElement, title: string, subtitleText = "") {
  const header = document.createElement("div");
  header.className = "toolCardHeader";

  const statusIcon = document.createElement("span");
  statusIcon.className = "toolCardIcon";
  statusIcon.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "toolCardLabel";

  const name = document.createElement("span");
  name.className = "toolCardName";
  name.textContent = title;
  label.append(name);

  if (subtitleText) {
    const subtitle = document.createElement("span");
    subtitle.className = "toolCardSubtitle";
    subtitle.textContent = subtitleText;
    label.append(subtitle);
    label.addEventListener("click", (event) => {
      if (isCompactDensity()) return;
      event.stopPropagation();
      label.classList.toggle("expanded");
    });
  }

  const expandToggle = document.createElement("button");
  expandToggle.type = "button";
  expandToggle.className = "toolCardExpandToggle";
  updateCompactToggle(expandToggle, true);
  expandToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setCompactCollapsed(card, !card.classList.contains("toolCard--compactCollapsed"));
  });

  header.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (!isCompactDensity() || target?.closest("button")) return;
    setCompactCollapsed(card, !card.classList.contains("toolCard--compactCollapsed"));
  });

  header.append(statusIcon, label, expandToggle);
  card.append(header);
  setCompactCollapsed(card, true);
}

function addToolHeader(card: HTMLDivElement, toolName: string, args?: Record<string, unknown>) {
  addCardHeader(card, toolName, args ? toolSubtitle(toolName, args) : "");
  addToolArgsDetails(card, args);
}

function highlightToolResult(pre: HTMLPreElement, text: string) {
  const code = document.createElement("code");
  code.classList.add("hljs");
  const result = hljs.highlightAuto(text);
  code.innerHTML = result.value;
  pre.append(code);
}

function shouldCollapseToolResult(text: string) {
  return text.length > 600 || text.split("\n").length > 10;
}

function addToolResultBody(card: HTMLDivElement, result: string) {
  const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n…" : result;
  const collapsible = shouldCollapseToolResult(truncated);
  const body = document.createElement("pre");
  body.className = `toolCardBody${collapsible ? " collapsed" : ""}`;
  highlightToolResult(body, truncated);
  card.append(body);
  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toolCardCollapseToggle";
    const setCollapsed = (collapsed: boolean) => {
      body.classList.toggle("collapsed", collapsed);
      toggle.textContent = collapsed ? "▾" : "▴";
      toggle.setAttribute("aria-label", collapsed ? "Show more" : "Show less");
      toggle.title = collapsed ? "Show more" : "Show less";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };
    setCollapsed(true);
    body.addEventListener("click", () => setCollapsed(!body.classList.contains("collapsed")));
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setCollapsed(!body.classList.contains("collapsed"));
    });
    card.append(toggle);
  }
}

function textFromToolResult(result: unknown): string {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const text = textFromToolResult(parsed);
        if (text) return text;
      } catch {
        // Plain text that only looks like JSON; render it as-is.
      }
    }
    return result;
  }

  if (!result || typeof result !== "object") return result == null ? "" : String(result);
  const value = result as Record<string, unknown>;
  return textFromRawContent(value.content) || textFromRawContent(value.raw) || JSON.stringify(result, null, 2);
}

const toolQuietNoticeMs = 30_000;
const toolQuietWarnMs = 120_000;

function runningToolKey(toolCallId: string | undefined, toolName: string) {
  return toolCallId || toolName;
}

function formatToolDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseToolTimestamp(value: string | number | Date | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function latestPartialText(text: string) {
  const maxPartialOutputLength = 4000;
  return text.length > maxPartialOutputLength ? `…\n${text.slice(-maxPartialOutputLength)}` : text;
}

function removePartialToolOutput(card: HTMLDivElement) {
  card.querySelector(".toolCardPartialLabel")?.remove();
  card.querySelector(".toolCardPartialBody")?.remove();
}

function finalizePartialToolOutput(card: HTMLDivElement) {
  card.querySelector(".toolCardPartialLabel")?.remove();
  card.querySelector(".toolCardPartialBody")?.classList.remove("toolCardPartialBody");
}

export function createToolCards(messagesEl: HTMLDivElement, scrollToBottom: () => void = () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}): ToolCards {
  const activeToolCards = new Map<string, HTMLDivElement>();
  const knownToolStartedAts = new Map<string, number>();
  const runningToolStates = new WeakMap<HTMLDivElement, { startedAt?: number; lastActivityAt: number; timer: number }>();

  function updateRunningToolProgress(card: HTMLDivElement) {
    const state = runningToolStates.get(card);
    const progress = card.querySelector<HTMLElement>(".toolCardProgress");
    if (!state || !progress) return;

    const now = Date.now();
    const quietFor = now - state.lastActivityAt;
    const quiet = quietFor >= toolQuietNoticeMs;
    const stale = quietFor >= toolQuietWarnMs;
    const hasPartialOutput = Boolean(card.querySelector<HTMLElement>(".toolCardPartialBody")?.textContent?.trim());
    const elapsedText = state.startedAt ? ` ${formatToolDuration(now - state.startedAt)}` : "";
    progress.textContent = `running${elapsedText}${quiet ? ` · ${hasPartialOutput ? "no output" : "no result"} ${formatToolDuration(quietFor)}` : ""}`;
    progress.title = state.startedAt
      ? `Still waiting for ${card.dataset.toolName || "tool"} to finish. Last tool update ${formatToolDuration(quietFor)} ago.`
      : `Still waiting for ${card.dataset.toolName || "tool"} to finish. Original start time unavailable.`;
    progress.classList.toggle("quiet", quiet);
    progress.classList.toggle("stale", stale);
    card.classList.toggle("toolCard--quiet", quiet);
    card.classList.toggle("toolCard--stale", stale);
  }

  function startRunningToolProgress(card: HTMLDivElement, startedAt?: number) {
    const header = card.querySelector<HTMLElement>(".toolCardHeader");
    if (!header) return;
    const progress = document.createElement("span");
    progress.className = "toolCardProgress";
    const toggle = header.querySelector(".toolCardExpandToggle");
    header.insertBefore(progress, toggle || null);

    const now = Date.now();
    const timer = window.setInterval(() => updateRunningToolProgress(card), 1000);
    runningToolStates.set(card, { startedAt, lastActivityAt: now, timer });
    updateRunningToolProgress(card);
  }

  function setRunningToolStartedAt(card: HTMLDivElement, startedAt?: number) {
    if (!startedAt) return;
    const state = runningToolStates.get(card);
    if (!state || state.startedAt) return;
    state.startedAt = startedAt;
    updateRunningToolProgress(card);
  }

  function stopRunningToolProgress(card: HTMLDivElement) {
    const state = runningToolStates.get(card);
    if (state) window.clearInterval(state.timer);
    runningToolStates.delete(card);
    card.querySelector(".toolCardProgress")?.remove();
    card.classList.remove("toolCard--quiet", "toolCard--stale");
  }

  function updatePartialToolOutput(card: HTMLDivElement, partialResult: unknown) {
    const resultStr = textFromToolResult(partialResult);
    if (!resultStr.trim()) return;

    let label = card.querySelector<HTMLElement>(".toolCardPartialLabel");
    if (!label) {
      label = document.createElement("div");
      label.className = "toolCardPartialLabel";
      label.textContent = "Partial output";
      card.append(label);
    }

    let body = card.querySelector<HTMLPreElement>(".toolCardPartialBody");
    if (!body) {
      body = document.createElement("pre");
      body.className = "toolCardBody toolCardPartialBody";
      card.append(body);
    }
    body.textContent = latestPartialText(resultStr);
    body.scrollTop = body.scrollHeight;
  }

  function noteToolActivity(card: HTMLDivElement, partialResult?: unknown) {
    const state = runningToolStates.get(card);
    if (state) state.lastActivityAt = Date.now();
    if (partialResult !== undefined) updatePartialToolOutput(card, partialResult);
    updateRunningToolProgress(card);
    scrollToBottom();
  }

  function addToolCard(toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "toolCard toolCard--running";
    addToolHeader(card, toolName, args);
    if (toolName === "edit") renderEditDiff(card, args);
    card.dataset.toolName = toolName;
    startRunningToolProgress(card, parseToolTimestamp(startedAt));
    messagesEl.append(card);
    scrollToBottom();
    return card;
  }

  function updateToolCard(card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) {
    stopRunningToolProgress(card);
    card.classList.remove("toolCard--running");
    card.classList.add(isError ? "toolCard--error" : "toolCard--success");

    card.querySelector(".toolCardBadge")?.remove();

    const resultStr = textFromToolResult(result);
    if (resultStr && (isError || card.dataset.toolName !== "edit")) {
      removePartialToolOutput(card);
      addToolResultBody(card, resultStr);
    } else {
      finalizePartialToolOutput(card);
    }

    scrollToBottom();
  }

  function addToolHistoryCard(toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) {
    const card = document.createElement("div");
    card.className = `toolCard ${isError ? "toolCard--error" : "toolCard--success"}`;
    addToolHeader(card, toolName, args);
    if (toolName === "edit" && args) renderEditDiff(card, args);
    else if (result) addToolResultBody(card, result);
    messagesEl.append(card);
  }

  function addRuntimeErrorCard(title: string, subtitle: string, body: string) {
    const card = document.createElement("div");
    card.className = "toolCard toolCard--error runtimeErrorCard";
    addCardHeader(card, title, subtitle);
    if (body) addToolResultBody(card, body);
    messagesEl.append(card);
  }

  function startedAtForCard(cardKey: string, startedAt?: string | number | Date) {
    const parsed = parseToolTimestamp(startedAt);
    if (parsed) knownToolStartedAts.set(cardKey, parsed);
    return knownToolStartedAts.get(cardKey);
  }

  function startTool(toolCallId: string | undefined, toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date) {
    const cardKey = runningToolKey(toolCallId, toolName);
    const knownStartedAt = startedAtForCard(cardKey, startedAt);
    const existing = activeToolCards.get(cardKey);
    if (existing?.isConnected) {
      setRunningToolStartedAt(existing, knownStartedAt);
      return;
    }
    const card = addToolCard(toolName, args, knownStartedAt);
    activeToolCards.set(cardKey, card);
  }

  function updateToolProgress(toolCallId: string | undefined, toolName: string, partialResult?: unknown, args: Record<string, unknown> = {}, startedAt?: string | number | Date) {
    const cardKey = runningToolKey(toolCallId, toolName);
    const knownStartedAt = startedAtForCard(cardKey, startedAt);
    let card = activeToolCards.get(cardKey);
    if (!card?.isConnected && Object.keys(args).length > 0) {
      card = addToolCard(toolName, args, knownStartedAt);
      activeToolCards.set(cardKey, card);
    }
    if (!card?.isConnected) return;
    setRunningToolStartedAt(card, knownStartedAt);
    noteToolActivity(card, partialResult);
  }

  function endTool(toolCallId: string | undefined, toolName: string, isError: boolean, result?: unknown) {
    const cardKey = runningToolKey(toolCallId, toolName);
    const card = activeToolCards.get(cardKey);
    if (!card) return;
    updateToolCard(card, toolName, isError, result);
    activeToolCards.delete(cardKey);
    knownToolStartedAts.delete(cardKey);
  }

  return {
    addToolCard,
    updateToolCard,
    addToolHistoryCard,
    addRuntimeErrorCard,
    startTool,
    updateToolProgress,
    endTool,
    clearActiveToolCards() {
      for (const card of activeToolCards.values()) stopRunningToolProgress(card);
      activeToolCards.clear();
    },
  };
}
