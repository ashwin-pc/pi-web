import hljs from "highlight.js/lib/common";
import { renderEditDiff } from "../components/editDiff.js";
import { textFromRawContent } from "../messages/content.js";
import type { ApiHeaders } from "../app/api.js";

export type ToolCards = {
  addToolCard: (toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date) => HTMLDivElement;
  updateToolCard: (card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) => void;
  addToolHistoryCard: (toolName: string, isError: boolean, result: unknown, args?: Record<string, unknown>) => void;
  addRuntimeErrorCard: (title: string, subtitle: string, body: string) => HTMLDivElement;
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

function formatArgValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function appendHighlightedCode(parent: HTMLElement, text: string) {
  const pre = document.createElement("pre");
  pre.className = "toolCardArgCode";
  const code = document.createElement("code");
  code.className = "hljs";
  code.innerHTML = hljs.highlightAuto(text).value;
  pre.append(code);
  parent.append(pre);
}

function addToolArgsDetails(card: HTMLDivElement, args?: Record<string, unknown>) {
  if (!args || Object.keys(args).length === 0) return;

  const details = document.createElement("details");
  details.className = "toolCardDetails";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "toolCardSummary";
  summary.textContent = "Arguments";

  const argsEl = document.createElement("div");
  argsEl.className = "toolCardArgs";

  for (const [key, value] of Object.entries(args)) {
    const row = document.createElement("div");
    row.className = "toolCardArgRow";

    const keyEl = document.createElement("div");
    keyEl.className = "toolCardArgKey";
    keyEl.textContent = key;

    const valueEl = document.createElement("div");
    valueEl.className = "toolCardArgValue";
    const text = formatArgValue(value);
    if (text.includes("\n")) appendHighlightedCode(valueEl, text);
    else valueEl.textContent = text;

    row.append(keyEl, valueEl);
    argsEl.append(row);
  }

  details.append(summary, argsEl);
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

function addBashHeader(card: HTMLDivElement, result: unknown, args?: Record<string, unknown>) {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const command = typeof args?.command === "string" ? args.command : typeof value.command === "string" ? value.command : "";
  const context = value.excludeFromContext ? "not in agent context" : "in agent context";
  addCardHeader(card, "bash", command ? `${command} · ${context}` : context);
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

function parseJsonLikeResult(result: unknown): unknown {
  if (typeof result !== "string") return result;
  const trimmed = result.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return result;
  try {
    return JSON.parse(trimmed);
  } catch {
    return result;
  }
}

export function textFromToolResult(result: unknown): string {
  result = parseJsonLikeResult(result);
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result == null ? "" : String(result);
  const value = result as Record<string, unknown>;
  if (typeof value.output === "string") {
    const sections: string[] = [];
    const output = value.output.replace(/\s+$/, "");
    sections.push(output || "(no output)");
    if (value.cancelled) sections.push("Command cancelled.");
    else if (typeof value.exitCode === "number" && value.exitCode !== 0) sections.push(`Command exited with code ${value.exitCode}`);
    if (value.truncated) sections.push(typeof value.fullOutputPath === "string" ? `Output truncated. Full output: ${value.fullOutputPath}` : "Output truncated.");
    return sections.join("\n\n");
  }
  if (typeof value.text === "string") return value.text;
  const raw = value.raw && typeof value.raw === "object" ? value.raw as Record<string, unknown> : undefined;
  return textFromRawContent(value.content) || textFromRawContent(raw?.content) || textFromRawContent(value.raw) || JSON.stringify(result, null, 2);
}

type ToolImage = { src: string; alt: string; needsAuth?: boolean };

export function collectToolImages(result: unknown): ToolImage[] {
  result = parseJsonLikeResult(result);
  const images: ToolImage[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (obj.type === "image") {
      const source = obj.source && typeof obj.source === "object" ? obj.source as Record<string, unknown> : undefined;
      const mimeType = [obj.mimeType, obj.mediaType, obj.mime_type, source?.media_type].find((v): v is string => typeof v === "string") || "image/png";
      const alt = typeof obj.name === "string" ? obj.name : "tool result image";
      const data = typeof obj.data === "string" ? obj.data : typeof source?.data === "string" ? source.data : undefined;
      const url = typeof obj.url === "string" ? obj.url : typeof source?.url === "string" ? source.url : undefined;
      if (data) images.push({ src: `data:${mimeType};base64,${data}`, alt });
      else if (url) images.push({ src: url, alt, needsAuth: url.startsWith("/") });
      else if (typeof obj.path === "string") images.push({ src: `/api/artifacts/${encodeURIComponent(obj.path.split("/").pop() || obj.path)}`, alt, needsAuth: true });
    } else if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
      const imageUrl = obj.image_url as Record<string, unknown>;
      if (typeof imageUrl.url === "string") images.push({ src: imageUrl.url, alt: "tool result image", needsAuth: imageUrl.url.startsWith("/") });
    }
    visit(obj.content);
    visit(obj.raw);
    visit(obj.source);
  };
  visit(result);
  return images;
}

function addToolImagePreviews(card: HTMLDivElement, result: unknown, apiHeaders?: ApiHeaders) {
  const images = collectToolImages(result);
  if (images.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "toolCardImage";
  for (const image of images) {
    const img = document.createElement("img");
    img.alt = image.alt;
    if (image.needsAuth && apiHeaders) {
      fetch(image.src, { headers: apiHeaders() })
        .then((res) => res.ok ? res.blob() : Promise.reject(new Error(res.statusText)))
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          img.src = objectUrl;
          img.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
        })
        .catch(() => { img.alt = `${image.alt} (failed to load)`; });
    } else img.src = image.src;
    wrap.append(img);
  }
  card.append(wrap);
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
}, apiHeaders?: ApiHeaders): ToolCards {
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
    addToolImagePreviews(card, result, apiHeaders);

    scrollToBottom();
  }

  function addToolHistoryCard(toolName: string, isError: boolean, result: unknown, args?: Record<string, unknown>) {
    const card = document.createElement("div");
    card.className = `toolCard ${isError ? "toolCard--error" : "toolCard--success"}`;
    if (toolName === "bash") addBashHeader(card, result, args);
    else addToolHeader(card, toolName, args);
    const resultStr = textFromToolResult(result);
    if (toolName === "edit" && args) renderEditDiff(card, args);
    else if (resultStr) addToolResultBody(card, resultStr);
    addToolImagePreviews(card, result, apiHeaders);
    messagesEl.append(card);
  }

  function addRuntimeErrorCard(title: string, subtitle: string, body: string) {
    const card = document.createElement("div");
    card.className = "toolCard toolCard--error runtimeErrorCard";
    addCardHeader(card, title, subtitle);
    if (body) addToolResultBody(card, body);
    messagesEl.append(card);
    return card;
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
