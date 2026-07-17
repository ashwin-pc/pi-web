import type { ApiHeaders } from "../app/api.js";
import { iconElement, type IconName } from "../app/icons.js";
import type { AttachedImage, Role } from "../app/types.js";
import { attachImageActions } from "../components/imageActions.js";
import type { MarkdownRenderer } from "../markdown/render.js";
import { assistantErrorBody, cleanThinkingText, imageFileName, imagesFromRawContent, isRetryableAssistantError, messageText, normalizeAssistantError, shouldCollapseMessage, stripImagePathNote, thinkingTextSegments } from "./content.js";

export type AddToolHistoryCard = (toolName: string, isError: boolean, result: unknown, args?: Record<string, unknown>) => void;
export type AddPendingToolCard = (toolCallId: string | undefined, toolName: string, args: Record<string, unknown>, startedAt?: string | number | Date) => void;
export type AddRuntimeErrorCard = (title: string, subtitle: string, body: string) => HTMLDivElement;
export type MessageActionKind = "edit" | "rerun" | "continue";
export type MessageActionContext = {
  action: MessageActionKind;
  entryId: string;
  role: "user" | "assistant";
  text: string;
};
export type MessageMetadata = {
  entryId?: string;
  copyText?: string;
};

export type TranscriptTerminalFailure = {
  text: string;
  body: string;
  raw: string;
  attempts: number;
};

export type TranscriptIncomplete = {
  reason: "toolResult" | "aborted";
  text: string;
  body: string;
};

export type TranscriptRuntimeState = {
  terminalFailure?: TranscriptTerminalFailure;
  incomplete?: TranscriptIncomplete;
};

type ToolCallSummary = {
  id?: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAt?: string | number;
};

export type MessageList = {
  addMessage: (role: Role, text: string, extraClass?: string, images?: AttachedImage[], metadata?: MessageMetadata) => HTMLDivElement;
  appendStreamingDelta: (delta: string) => void;
  startStreamingThinking: (contentIndex?: number | string) => void;
  appendStreamingThinkingDelta: (delta: string, contentIndex?: number | string) => void;
  endStreamingThinking: (content?: string, contentIndex?: number | string) => void;
  clear: () => void;
  beginStreamFollow: () => void;
  endStreamFollow: () => void;
  refreshMessages: (options: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    isStreaming?: boolean;
    updateEmptyCwdChooser?: () => void;
    onTranscriptRuntimeState?: (state: TranscriptRuntimeState) => void;
  }) => Promise<void>;
  resetStreamingAssistant: () => void;
  invalidateRefreshes: () => void;
  scrollToBottom: () => void;
};

function appendAttachedImage(container: HTMLElement, img: AttachedImage) {
  if (img.data && img.mimeType) {
    const el = document.createElement("img");
    el.className = "messageImageThumb";
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.alt = imageFileName(img.path);
    container.append(el);
    attachImageActions(el);
    return;
  }

  const missing = document.createElement("span");
  missing.className = "messageImageMissing";
  missing.title = img.path || "unknown path";
  missing.textContent = `🖼️ ${imageFileName(img.path, "missing image")}`;
  container.append(missing);
}

function rawContent(message: any) {
  return message?.raw?.content ?? message?.content;
}

function partText(part: unknown) {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function partThinkingText(part: unknown) {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  if (value.type !== "thinking") return "";
  if (typeof value.thinking === "string") return value.thinking.trim();
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.content === "string") return value.content.trim();
  return "";
}

function toolCallFromPart(part: unknown): ToolCallSummary | undefined {
  if (!part || typeof part !== "object") return undefined;
  const value = part as Record<string, unknown>;
  if (value.type !== "toolCall") return undefined;
  const args = value.arguments && typeof value.arguments === "object"
    ? value.arguments as Record<string, unknown>
    : value.args && typeof value.args === "object"
      ? value.args as Record<string, unknown>
      : {};
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    toolName: typeof value.toolName === "string" ? value.toolName : typeof value.name === "string" ? value.name : "tool",
    args,
    startedAt: typeof value.startedAt === "string" || typeof value.startedAt === "number" ? value.startedAt : undefined,
  };
}

function rawAssistantError(message: any) {
  return String(message?.raw?.errorMessage || message?.errorMessage || "").trim();
}

function assistantStopReason(message: any) {
  return String(message?.raw?.stopReason || message?.stopReason || "").trim();
}

function isAssistantMessage(message: any) {
  return String(message?.raw?.role || message?.role || "") === "assistant";
}

function retryableAssistantErrorInfo(message: any) {
  if (!isAssistantMessage(message)) return undefined;
  const raw = rawAssistantError(message);
  if (!raw || !isRetryableAssistantError(raw)) return undefined;
  const text = normalizeAssistantError(raw) || messageText(message) || "Assistant error";
  const body = distinctAssistantErrorBody(raw, text);
  return { text, body, raw };
}

function distinctAssistantErrorBody(rawError: unknown, fallback = "") {
  const body = assistantErrorBody(rawError, fallback).trim();
  return body && body !== fallback.trim() ? body : "";
}

function retryableAssistantErrorGroup(messages: any[], startIndex: number) {
  const group = [] as Array<{ message: any; text: string; body: string; raw: string }>;
  for (let index = startIndex; index < messages.length; index += 1) {
    const info = retryableAssistantErrorInfo(messages[index]);
    if (!info) break;
    group.push({ message: messages[index], ...info });
  }
  return group;
}

function retryErrorGroupBody(group: Array<{ text: string; body: string }>) {
  const distinctTexts = Array.from(new Set(group.map((item) => item.text).filter(Boolean)));
  const distinctBodies = Array.from(new Set(group.map((item) => item.body).filter((body) => body && !distinctTexts.includes(body))));
  if (distinctBodies.length > 0) return distinctBodies.join("\n\n");
  return distinctTexts.length > 1 ? `Earlier transient errors: ${distinctTexts.slice(0, -1).join(", ")}` : "";
}

function toolCallIndex(content: unknown, toolCallId: string) {
  if (!Array.isArray(content)) return -1;
  return content.findIndex((part) => toolCallFromPart(part)?.id === toolCallId);
}

function assistantHasTextAfterToolCall(message: any, toolCallId: string) {
  const content = rawContent(message);
  const index = toolCallIndex(content, toolCallId);
  if (index < 0 || !Array.isArray(content)) return false;
  return content.slice(index + 1).some((part) => partText(part).trim());
}

function trailingToolResultLooksIncomplete(messages: any[]) {
  const last = messages[messages.length - 1];
  if (last?.role !== "toolResult") return false;
  const toolCallId = String(last.toolCallId || last.raw?.toolCallId || "");
  if (!toolCallId) return true;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    if (assistantHasTextAfterToolCall(message, toolCallId)) return false;
    if (toolCallIndex(rawContent(message), toolCallId) >= 0) return true;
  }
  return true;
}

function transcriptRuntimeState(messages: any[], isStreaming?: boolean): TranscriptRuntimeState {
  if (isStreaming || messages.length === 0) return {};
  const last = messages[messages.length - 1];
  if (trailingToolResultLooksIncomplete(messages)) {
    const toolName = String(last.toolName || last.raw?.toolName || "tool");
    return {
      incomplete: {
        reason: "toolResult",
        text: "Response incomplete",
        body: `The turn ended after the ${toolName} tool returned, before the assistant wrote a final response.`,
      },
    };
  }
  if (isAssistantMessage(last) && assistantStopReason(last) === "aborted") {
    return {
      incomplete: {
        reason: "aborted",
        text: "Response incomplete",
        body: "The assistant response was interrupted before the turn completed.",
      },
    };
  }

  let firstTrailingRetryError = messages.length;
  while (firstTrailingRetryError > 0 && retryableAssistantErrorInfo(messages[firstTrailingRetryError - 1])) firstTrailingRetryError -= 1;
  const trailingGroup = messages.slice(firstTrailingRetryError).map((message) => retryableAssistantErrorInfo(message)).filter(Boolean) as Array<{ text: string; body: string; raw: string }>;
  if (trailingGroup.length >= 2) {
    const lastError = trailingGroup[trailingGroup.length - 1];
    return {
      terminalFailure: {
        text: lastError.text,
        body: retryErrorGroupBody(trailingGroup) || lastError.body,
        raw: lastError.raw,
        attempts: trailingGroup.length,
      },
    };
  }
  return {};
}

export function createMessageList(options: {
  messagesEl: HTMLDivElement;
  markdown: MarkdownRenderer;
  onMessageAction?: (context: MessageActionContext) => void | Promise<void>;
}): MessageList {
  const { messagesEl, markdown, onMessageAction } = options;
  let streamingAssistant: HTMLDivElement | null = null;
  const streamingThinkingCards = new Map<string, HTMLDivElement>();
  const thinkingCardRawText = new WeakMap<HTMLDivElement, string>();
  let currentStreamingThinkingKey = "current";
  let isStreaming = false;
  let shouldFollowStream = true;
  let programmaticScroll = false;
  let userScrollIntent = false;
  let refreshSerial = 0;
  let mutationSerial = 0;
  let applyingRefresh = false;
  let bulkRendering = false;
  const bottomThreshold = 48;
  const resumeBottomThreshold = bottomThreshold;
  const jumpButtonGap = 16;

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "jumpToLatestButton";
  jumpButton.textContent = "Jump to latest";
  jumpButton.setAttribute("aria-label", "Jump to latest message");
  jumpButton.hidden = true;
  document.querySelector(".app")?.append(jumpButton);

  const actionMenu = document.createElement("div");
  actionMenu.className = "messageActionMenu";
  actionMenu.setAttribute("role", "menu");
  actionMenu.hidden = true;
  document.body.append(actionMenu);
  let actionMenuAnchor: HTMLElement | null = null;
  let longPressTimer: number | undefined;
  let suppressNextMessageClick = false;
  const messageActionHandlers = new WeakMap<HTMLButtonElement, () => void>();

  function updateJumpButtonOffset() {
    const composerEl = document.querySelector<HTMLElement>(".composer");
    if (!composerEl) return;
    const composerRect = composerEl.getBoundingClientRect();
    const bottom = Math.max(jumpButtonGap, window.innerHeight - composerRect.top + jumpButtonGap);
    jumpButton.style.setProperty("--jump-to-latest-bottom", `${Math.ceil(bottom)}px`);
  }

  updateJumpButtonOffset();
  window.addEventListener("resize", updateJumpButtonOffset);
  const composerEl = document.querySelector<HTMLElement>(".composer");
  if (composerEl && "ResizeObserver" in window) {
    new ResizeObserver(updateJumpButtonOffset).observe(composerEl);
  }

  function invalidatePendingRefreshes() {
    if (!applyingRefresh) mutationSerial++;
  }

  function invalidateExternalRefreshes() {
    mutationSerial++;
  }

  function distanceFromBottom() {
    return Math.max(0, messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight);
  }

  function isNearBottom() {
    return distanceFromBottom() <= bottomThreshold;
  }

  function isAtBottom() {
    return distanceFromBottom() <= resumeBottomThreshold;
  }

  function setJumpButtonVisible(visible: boolean) {
    jumpButton.hidden = !visible;
  }

  function showJumpButtonIfAwayFromBottom() {
    if (isAtBottom()) {
      setJumpButtonVisible(false);
      return false;
    }
    setJumpButtonVisible(true);
    return true;
  }

  function forceScrollToBottom() {
    programmaticScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    window.setTimeout(() => {
      programmaticScroll = false;
    }, 0);
  }

  function scrollToBottom() {
    if (bulkRendering) return;
    if (!shouldFollowStream) {
      if (isAtBottom() && !userScrollIntent) {
        shouldFollowStream = true;
        setJumpButtonVisible(false);
      } else {
        setJumpButtonVisible(true);
      }
      return;
    }
    forceScrollToBottom();
    setJumpButtonVisible(false);
  }

  function beginStreamFollow() {
    invalidatePendingRefreshes();
    isStreaming = true;
    shouldFollowStream = true;
    userScrollIntent = false;
    forceScrollToBottom();
    setJumpButtonVisible(false);
  }

  function endStreamFollow() {
    isStreaming = false;
    if (isAtBottom()) setJumpButtonVisible(false);
  }

  function isScrollIntentAwayFromBottom(event: Event) {
    if (event instanceof WheelEvent) return event.deltaY < 0;
    if (event instanceof KeyboardEvent) {
      return event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey);
    }
    return false;
  }

  function pauseStreamFollow(event: Event) {
    if (programmaticScroll) return;
    userScrollIntent = true;
    if (!isStreaming) return;
    if (isAtBottom() && !isScrollIntentAwayFromBottom(event)) return;
    shouldFollowStream = false;
    setJumpButtonVisible(true);
  }

  messagesEl.addEventListener("wheel", pauseStreamFollow, { passive: true });
  messagesEl.addEventListener("touchstart", pauseStreamFollow, { passive: true });
  messagesEl.addEventListener("pointerdown", pauseStreamFollow);
  messagesEl.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseStreamFollow(event);
  });
  messagesEl.addEventListener("scroll", () => {
    if (!actionMenu.hidden) closeActionMenu();
    if (programmaticScroll) return;
    if (shouldFollowStream && !isNearBottom()) {
      shouldFollowStream = false;
      setJumpButtonVisible(true);
      return;
    }
    if (!shouldFollowStream && isAtBottom()) {
      shouldFollowStream = true;
      userScrollIntent = false;
      setJumpButtonVisible(false);
    }
  }, { passive: true });
  jumpButton.addEventListener("click", () => {
    shouldFollowStream = true;
    userScrollIntent = false;
    forceScrollToBottom();
    setJumpButtonVisible(false);
  });

  function isMobileActionMenuEnabled() {
    return window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  }

  function cancelLongPress() {
    if (longPressTimer !== undefined) {
      window.clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  }

  function closeActionMenu() {
    actionMenu.hidden = true;
    actionMenu.textContent = "";
    actionMenuAnchor = null;
  }

  function positionActionMenu(anchor: HTMLElement, clientX?: number) {
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = actionMenu.getBoundingClientRect();
    const safeGap = 8;
    const centerX = typeof clientX === "number" ? clientX : anchorRect.left + anchorRect.width / 2;
    const left = Math.min(
      window.innerWidth - menuRect.width - safeGap,
      Math.max(safeGap, centerX - menuRect.width / 2),
    );
    let top = anchorRect.top - menuRect.height - safeGap;
    if (top < safeGap) top = Math.min(window.innerHeight - menuRect.height - safeGap, anchorRect.bottom + safeGap);
    actionMenu.style.left = `${Math.round(Math.max(safeGap, left))}px`;
    actionMenu.style.top = `${Math.round(Math.max(safeGap, top))}px`;
  }

  function showActionMenu(anchor: HTMLElement, actions: HTMLElement, clientX?: number) {
    const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>(".messageActionButton"));
    if (buttons.length === 0) return;
    cancelLongPress();
    actionMenu.textContent = "";
    actionMenuAnchor = anchor;
    for (const sourceButton of buttons) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "messageActionMenuItem";
      item.setAttribute("role", "menuitem");
      item.textContent = sourceButton.dataset.menuLabel || sourceButton.title || sourceButton.getAttribute("aria-label") || "Action";
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        const handler = messageActionHandlers.get(sourceButton);
        closeActionMenu();
        handler?.();
      });
      actionMenu.append(item);
    }
    actionMenu.hidden = false;
    positionActionMenu(anchor, clientX);
  }

  function isInteractiveMessageTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest("button, a, input, textarea, select, summary, .imageFrame, .imageActions, .messageActions, .messageActionMenu"));
  }

  function hasTextSelectionInMessage(messageEl: HTMLElement) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      const start = range.startContainer;
      const end = range.endContainer;
      if (messageEl.contains(start) || messageEl.contains(end) || range.intersectsNode(messageEl)) return true;
    }
    return false;
  }

  document.addEventListener("pointerdown", (event) => {
    if (actionMenu.hidden) return;
    const target = event.target;
    if (target instanceof Node && (actionMenu.contains(target) || actionMenuAnchor?.contains(target))) return;
    closeActionMenu();
  }, true);
  window.addEventListener("resize", closeActionMenu);

  async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the textarea-based fallback.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function renderMessageActionIcon(button: HTMLButtonElement, icon: IconName, title: string) {
    button.textContent = "";
    button.append(iconElement(icon));
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  function flashActionButton(button: HTMLButtonElement, icon: IconName, title: string) {
    renderMessageActionIcon(button, icon, title);
    window.setTimeout(() => {
      const defaultIcon = button.dataset.defaultIcon as IconName | undefined;
      const defaultTitle = button.dataset.defaultTitle;
      if (button.isConnected && defaultIcon && defaultTitle) renderMessageActionIcon(button, defaultIcon, defaultTitle);
    }, 1200);
  }

  function appendMessageActionButton(actions: HTMLElement, icon: IconName, title: string, menuLabel: string, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "messageActionButton";
    button.dataset.defaultIcon = icon;
    button.dataset.defaultTitle = title;
    button.dataset.menuLabel = menuLabel;
    renderMessageActionIcon(button, icon, title);
    messageActionHandlers.set(button, onClick);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    actions.append(button);
    return button;
  }

  function bindMobileActionMenu(messageEl: HTMLDivElement, actions: HTMLElement) {
    let startX = 0;
    let startY = 0;
    const moveThreshold = 10;
    const longPressMs = 520;

    messageEl.addEventListener("pointerdown", (event) => {
      if (!isMobileActionMenuEnabled() || event.button !== 0 || !event.isPrimary || isInteractiveMessageTarget(event.target)) return;
      closeActionMenu();
      startX = event.clientX;
      startY = event.clientY;
      cancelLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = undefined;
        if (hasTextSelectionInMessage(messageEl)) return;
        suppressNextMessageClick = true;
        showActionMenu(messageEl, actions, startX);
        navigator.vibrate?.(8);
      }, longPressMs);
    });
    messageEl.addEventListener("pointermove", (event) => {
      if (longPressTimer === undefined) return;
      if (Math.abs(event.clientX - startX) > moveThreshold || Math.abs(event.clientY - startY) > moveThreshold) cancelLongPress();
    });
    messageEl.addEventListener("pointerup", cancelLongPress);
    messageEl.addEventListener("pointercancel", cancelLongPress);
    messageEl.addEventListener("click", (event) => {
      if (!suppressNextMessageClick) return;
      suppressNextMessageClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    messageEl.addEventListener("contextmenu", (event) => {
      if (!isMobileActionMenuEnabled() || isInteractiveMessageTarget(event.target) || hasTextSelectionInMessage(messageEl)) return;
      event.preventDefault();
      showActionMenu(messageEl, actions, event.clientX || undefined);
    });
  }

  function appendMessageActions(messageEl: HTMLDivElement, role: Role, body: HTMLElement, copyText: string, metadata: MessageMetadata) {
    if (role !== "user" && role !== "assistant") return;

    const actions = document.createElement("div");
    actions.className = "messageActions";

    const actionText = () => copyText || body.textContent || "";
    const entryId = metadata.entryId?.trim();
    if (entryId && onMessageAction) {
      messageEl.dataset.entryId = entryId;
      const runAction = (action: MessageActionKind) => {
        void onMessageAction({ action, entryId, role, text: actionText() });
      };
      if (role === "user") {
        appendMessageActionButton(actions, "square-pen", "Edit message from here", "Edit", () => runAction("edit"));
        appendMessageActionButton(actions, "rotate-ccw", "Rerun message from here", "Rerun", () => runAction("rerun"));
      } else {
        appendMessageActionButton(actions, "corner-down-right", "Continue from this assistant message", "Continue", () => runAction("continue"));
      }
    }

    const copyButton = appendMessageActionButton(actions, "copy", `Copy ${role} message`, "Copy", () => {
      const textToCopy = actionText();
      void copyTextToClipboard(textToCopy).then(
        () => flashActionButton(copyButton, "check", "Copied"),
        () => flashActionButton(copyButton, "x", "Copy failed"),
      );
    });

    messageEl.append(actions);
    bindMobileActionMenu(messageEl, actions);
  }

  function addMessage(role: Role, text: string, extraClass = "", images: AttachedImage[] = [], metadata: MessageMetadata = {}) {
    invalidatePendingRefreshes();
    const div = document.createElement("div");
    const collapsible = shouldCollapseMessage(text);
    div.className = `message ${role} ${extraClass}${collapsible ? " collapsible collapsed" : ""}`.trim();
    const body = document.createElement("div");
    body.className = "body";

    if (role === "user" && images.length > 0) {
      const cleanText = stripImagePathNote(text);
      if (cleanText) {
        const textNode = document.createElement("span");
        textNode.className = "messageText";
        textNode.textContent = cleanText;
        body.append(textNode);
      }

      const imgWrap = document.createElement("div");
      imgWrap.className = "messageImages";
      for (const img of images) appendAttachedImage(imgWrap, img);
      body.append(imgWrap);
    } else if (role === "assistant" && text) {
      body.textContent = text;
      if (collapsible) markdown.queueAssistantMarkdownRender(body, text);
      else markdown.renderAssistantMarkdown(body, text);
    } else {
      body.textContent = text || "";
    }

    div.append(body);

    if (collapsible) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "messageToggle";
      toggle.textContent = "Show more";
      toggle.addEventListener("click", () => {
        const collapsed = div.classList.toggle("collapsed");
        if (!collapsed && role === "assistant" && text && !body.dataset.markdownRendered) {
          markdown.unobserve(body);
          markdown.renderAssistantMarkdown(body, text);
        }
        toggle.textContent = collapsed ? "Show more" : "Show less";
      });
      div.append(toggle);
    }

    appendMessageActions(div, role, body, metadata.copyText ?? text, metadata);
    messagesEl.append(div);
    scrollToBottom();
    return div;
  }

  function thinkingWordCount(text: string) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function renderThinkingBody(body: HTMLElement, text: string) {
    body.replaceChildren();
    for (const segment of thinkingTextSegments(text)) {
      if (segment.type === "heading") {
        const heading = document.createElement("strong");
        heading.className = "toolCardThinkingHeading";
        heading.textContent = segment.text;
        body.append(heading);
      } else {
        body.append(document.createTextNode(segment.text));
      }
    }
  }

  function updateThinkingCardText(card: HTMLDivElement, text: string, streaming = false) {
    thinkingCardRawText.set(card, text);
    const displayText = cleanThinkingText(text);
    card.classList.toggle("toolCard--thinkingEmpty", !displayText.trim());
    const body = card.querySelector<HTMLElement>(".toolCardBody");
    const subtitle = card.querySelector<HTMLElement>(".toolCardSubtitle");
    if (body) {
      renderThinkingBody(body, displayText);
      if (!streaming && (displayText.length > 1200 || displayText.split("\n").length > 16)) body.classList.add("collapsed");
    }
    if (subtitle) {
      const words = thinkingWordCount(displayText);
      subtitle.textContent = streaming
        ? words > 0 ? `${words.toLocaleString()} words · streaming` : "streaming"
        : `${words.toLocaleString()} words`;
    }
  }

  function isCompactDensity() {
    return document.documentElement.dataset.density === "compact";
  }

  function updateThinkingCompactToggle(toggle: HTMLButtonElement, collapsed: boolean) {
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.setAttribute("aria-label", collapsed ? "Show thinking" : "Hide thinking");
    toggle.title = collapsed ? "Show thinking" : "Hide thinking";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  function setThinkingCompactCollapsed(card: HTMLDivElement, collapsed: boolean) {
    card.classList.toggle("toolCard--compactCollapsed", collapsed);
    const toggle = card.querySelector<HTMLButtonElement>(".toolCardExpandToggle");
    if (toggle) updateThinkingCompactToggle(toggle, collapsed);
  }

  function addThinkingCard(text: string, streaming = false) {
    invalidatePendingRefreshes();
    const card = document.createElement("div");
    card.className = `toolCard toolCard--thinking${streaming ? " toolCard--thinkingStreaming" : ""}`;

    const header = document.createElement("div");
    header.className = "toolCardHeader";

    const icon = document.createElement("span");
    icon.className = "toolCardIcon";
    icon.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "toolCardLabel";

    const name = document.createElement("span");
    name.className = "toolCardName";
    name.textContent = "thinking";

    const subtitle = document.createElement("span");
    subtitle.className = "toolCardSubtitle";

    label.append(name, subtitle);

    const expandToggle = document.createElement("button");
    expandToggle.type = "button";
    expandToggle.className = "toolCardExpandToggle";
    updateThinkingCompactToggle(expandToggle, true);
    expandToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setThinkingCompactCollapsed(card, !card.classList.contains("toolCard--compactCollapsed"));
    });

    header.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (!isCompactDensity() || target?.closest("button")) return;
      setThinkingCompactCollapsed(card, !card.classList.contains("toolCard--compactCollapsed"));
    });

    header.append(icon, label, expandToggle);

    const body = document.createElement("pre");
    body.className = `toolCardBody${!streaming && (text.length > 1200 || text.split("\n").length > 16) ? " collapsed" : ""}`;

    card.append(header, body);
    setThinkingCompactCollapsed(card, true);
    updateThinkingCardText(card, text, streaming);

    if (body.classList.contains("collapsed")) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toolCardCollapseToggle";
      const setCollapsed = (collapsed: boolean) => {
        body.classList.toggle("collapsed", collapsed);
        toggle.textContent = collapsed ? "▾" : "▴";
        toggle.setAttribute("aria-label", collapsed ? "Show thinking" : "Hide thinking");
        toggle.title = collapsed ? "Show thinking" : "Hide thinking";
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

    messagesEl.append(card);
    scrollToBottom();
    return card;
  }

  function clearInternal(invalidate = true) {
    if (invalidate) invalidatePendingRefreshes();
    messagesEl.textContent = "";
    streamingAssistant = null;
    streamingThinkingCards.clear();
    currentStreamingThinkingKey = "current";
    setJumpButtonVisible(false);
  }

  function clear() {
    clearInternal(true);
  }

  function resetStreamingAssistant() {
    streamingAssistant = null;
    streamingThinkingCards.clear();
    currentStreamingThinkingKey = "current";
  }

  function appendStreamingDelta(delta: string) {
    invalidatePendingRefreshes();
    // Text after a tool result/thinking card belongs in a new assistant segment.
    // Otherwise all deltas keep appending to the first assistant bubble, so live
    // rendering loses the same interleaving that static history gets from parts.
    if (!streamingAssistant || messagesEl.lastElementChild !== streamingAssistant) {
      streamingAssistant = addMessage("assistant", "");
    }
    const body = streamingAssistant.querySelector<HTMLElement>(".body");
    if (body) body.textContent += delta || "";
    scrollToBottom();
  }

  function thinkingKey(contentIndex?: number | string) {
    return contentIndex === undefined || contentIndex === null ? currentStreamingThinkingKey : String(contentIndex);
  }

  function startStreamingThinking(contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    currentStreamingThinkingKey = key;
    if (!streamingThinkingCards.get(key)?.isConnected) {
      streamingAssistant = null;
      streamingThinkingCards.set(key, addThinkingCard("", true));
    }
  }

  function appendStreamingThinkingDelta(delta: string, contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    currentStreamingThinkingKey = key;
    let card = streamingThinkingCards.get(key);
    if (!card?.isConnected) {
      streamingAssistant = null;
      card = addThinkingCard("", true);
      streamingThinkingCards.set(key, card);
    }
    const rawText = thinkingCardRawText.get(card) ?? card.querySelector<HTMLElement>(".toolCardBody")?.textContent ?? "";
    updateThinkingCardText(card, `${rawText}${delta || ""}`, true);
    scrollToBottom();
  }

  function endStreamingThinking(content?: string, contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    const card = streamingThinkingCards.get(key);
    if (!card?.isConnected) return;
    card.classList.remove("toolCard--thinkingStreaming");
    const finalText = typeof content === "string"
      ? content
      : thinkingCardRawText.get(card) ?? card.querySelector<HTMLElement>(".toolCardBody")?.textContent ?? "";
    if (!cleanThinkingText(finalText).trim()) {
      card.remove();
    } else {
      updateThinkingCardText(card, finalText, false);
    }
    streamingThinkingCards.delete(key);
    streamingAssistant = null;
    scrollToBottom();
  }

  function renderToolResultMessage(message: any, addToolHistoryCard: AddToolHistoryCard, argsOverride?: Record<string, unknown>) {
    const toolName = message.toolName || message.raw?.toolName || message.name || "tool";
    const isError = Boolean(message.isError);
    addToolHistoryCard(toolName, isError, message, argsOverride || message.toolArgs);
  }

  function renderAssistantMessageParts(message: any, options: {
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    completedToolResults: Map<string, any>;
    renderedToolResultIds: Set<string>;
    isStreaming?: boolean;
  }) {
    const { addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, completedToolResults, renderedToolResultIds, isStreaming } = options;
    const content = rawContent(message);
    const text = messageText(message);

    if (message.isError) {
      const rawError = typeof message.raw?.errorMessage === "string" ? message.raw.errorMessage : typeof message.errorMessage === "string" ? message.errorMessage : text;
      addRuntimeErrorCard("assistant error", text, distinctAssistantErrorBody(rawError, text));
      return;
    }

    if (!Array.isArray(content)) {
      if (text) addMessage("assistant", text, message.isError ? "error" : "", [], { entryId: message.entryId });
      return;
    }

    const textParts = content.map(partText).filter(Boolean);
    const textPartsJoined = textParts.join("\n");
    let renderedAnyPart = false;
    for (const part of content) {
      const thinking = partThinkingText(part);
      if (thinking) {
        addThinkingCard(thinking);
        renderedAnyPart = true;
        continue;
      }

      const textPart = partText(part);
      if (textPart) {
        addMessage("assistant", textPart, "", [], { entryId: message.entryId });
        renderedAnyPart = true;
        continue;
      }

      const call = toolCallFromPart(part);
      if (call) {
        renderedAnyPart = true;
        const result = call.id ? completedToolResults.get(call.id) : undefined;
        if (result) {
          renderToolResultMessage(result, addToolHistoryCard, call.args);
          renderedToolResultIds.add(call.id || "");
        } else if (isStreaming) {
          addPendingToolCard(call.id, call.toolName, call.args, call.startedAt);
        }
      }
    }

    // If the server supplied text that did not correspond to individual text
    // parts (for example a stop-reason summary), keep it visible without
    // duplicating normal assistant text parts.
    if (!renderedAnyPart && text) addMessage("assistant", text, message.isError ? "error" : "", [], { entryId: message.entryId });
    else if (text && textPartsJoined && text !== textPartsJoined && text.startsWith(textPartsJoined)) {
      const suffix = text.slice(textPartsJoined.length).trim();
      if (suffix) addMessage("assistant", suffix, message.isError ? "error" : "", [], { entryId: message.entryId });
    }
  }

  async function refreshMessages({ sessionId, headers, addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, clearActiveToolCards, isStreaming, updateEmptyCwdChooser, onTranscriptRuntimeState }: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    isStreaming?: boolean;
    updateEmptyCwdChooser?: () => void;
    onTranscriptRuntimeState?: (state: TranscriptRuntimeState) => void;
  }) {
    const refreshId = ++refreshSerial;
    const mutationAtStart = mutationSerial;
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/messages${query}`, { headers: headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (refreshId !== refreshSerial || mutationAtStart !== mutationSerial) return;

    const wasFollowing = shouldFollowStream;
    const previousScrollTop = messagesEl.scrollTop;
    applyingRefresh = true;
    try {
      clearInternal(false);
      clearActiveToolCards();
      const allMessages = data.messages || [];
      const runtimeState = transcriptRuntimeState(allMessages, isStreaming);
      if (data.runtimeUnavailable) addMessage("system", data.error ? `Runtime unavailable: ${data.error}` : "Runtime unavailable", "error");
      bulkRendering = true;
      const completedToolResults = new Map<string, any>();
      const renderedToolResultIds = new Set<string>();
      for (const message of allMessages) {
        const id = message?.toolCallId || message?.raw?.toolCallId;
        if (message?.role === "toolResult" && typeof id === "string") completedToolResults.set(id, message);
      }
      for (let index = 0; index < allMessages.length; index += 1) {
        const message = allMessages[index];
        const retryGroup = retryableAssistantErrorGroup(allMessages, index);
        if (retryGroup.length >= 2) {
          index += retryGroup.length - 1;
          if (index === allMessages.length - 1) continue;
          const lastError = retryGroup[retryGroup.length - 1];
          addRuntimeErrorCard("assistant error", `${lastError.text} · retried ${retryGroup.length} attempts`, retryErrorGroupBody(retryGroup));
          continue;
        }

        const id = message?.toolCallId || message?.raw?.toolCallId;
        if (message.role === "toolResult") {
          if (typeof id === "string" && renderedToolResultIds.has(id)) continue;
          renderToolResultMessage(message, addToolHistoryCard);
          continue;
        }

        if (message.role === "bashExecution") {
          const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
          addToolHistoryCard("bash", Boolean(message.cancelled || (exitCode !== undefined && exitCode !== 0)), message, { command: String(message.command || "") });
          continue;
        }

        const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
        if (role === "assistant") {
          renderAssistantMessageParts(message, { addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, completedToolResults, renderedToolResultIds, isStreaming });
          continue;
        }

        const text = messageText(message);
        if (text) {
          const rawImages = role === "user" ? imagesFromRawContent(rawContent(message)) : [];
          const extraClass = message.role === "compactionSummary" ? "compaction" : message.isError ? "error" : "";
          addMessage(role, text, extraClass, rawImages, { entryId: message.entryId });
        }
      }
      bulkRendering = false;
      if (wasFollowing) scrollToBottom();
      else {
        programmaticScroll = true;
        messagesEl.scrollTop = previousScrollTop;
        window.setTimeout(() => {
          programmaticScroll = false;
        }, 0);
        showJumpButtonIfAwayFromBottom();
      }
      onTranscriptRuntimeState?.(runtimeState);
      updateEmptyCwdChooser?.();
    } finally {
      bulkRendering = false;
      applyingRefresh = false;
    }
  }

  return {
    addMessage,
    appendStreamingDelta,
    appendStreamingThinkingDelta,
    beginStreamFollow,
    clear,
    endStreamFollow,
    endStreamingThinking,
    refreshMessages,
    resetStreamingAssistant,
    invalidateRefreshes: invalidateExternalRefreshes,
    scrollToBottom,
    startStreamingThinking,
  };
}
