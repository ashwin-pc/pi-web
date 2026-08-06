import type { ApiHeaders } from "../app/api.js";
import { iconElement, type IconName } from "../app/icons.js";
import type { MarkdownRenderer } from "../markdown/render.js";

type HeaderAction = { key?: unknown; icon?: unknown; title?: unknown; label?: unknown };

type Options = {
  container: HTMLElement;
  headers: ApiHeaders;
  getSessionId: () => string;
  markdown: MarkdownRenderer;
  /** Open an extension panel by key (header actions may return `openPanel`). */
  openPanel?: (key: string) => void;
};

const knownIcons = new Set<IconName>([
  "bookmark", "brain", "corner-down-right", "flag", "git-branch", "git-fork", "key-round", "menu", "more-vertical",
  "paperclip", "pin", "route", "scroll-text", "send-horizontal", "settings", "square", "square-pen", "star", "trash-2", "maximize-2", "minimize-2", "x",
]);

export function createWebHeaderActions({ container, headers, getSessionId, markdown, openPanel }: Options) {
  let activeKey: string | undefined;
  let popover: HTMLDivElement | undefined;

  function close() {
    popover?.remove();
    popover = undefined;
    activeKey = undefined;
    container.querySelectorAll("button.active").forEach((button) => button.classList.remove("active"));
  }

  function showPopover(label: string, body: string, isMarkdown = false) {
    popover?.remove();
    popover = document.createElement("div");
    popover.className = "webHeaderActionPopover";
    const header = document.createElement("div");
    header.className = "webHeaderActionPopoverHeader";
    const title = document.createElement("strong");
    title.textContent = label;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "iconButton";
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    header.append(title, closeButton);
    const content = document.createElement("div");
    content.className = "webHeaderActionPopoverBody markdownBody";
    if (isMarkdown) markdown.renderAssistantMarkdown(content, body);
    else content.textContent = body;
    popover.append(header, content);
    document.body.append(popover);
  }

  async function invoke(action: { key: string; label: string; title: string }, button: HTMLButtonElement) {
    if (activeKey === action.key) return close();
    close();
    activeKey = action.key;
    button.classList.add("active");
    showPopover(action.label || action.title, "Loading…");
    const invokedSessionId = getSessionId();
    try {
      const res = await fetch("/api/web-contributions/invoke", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ sessionId: invokedSessionId, slot: "header-action", key: action.key }),
      });
      const data = await res.json().catch(() => ({}));
      if (getSessionId() !== invokedSessionId) return;
      if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
      const openPanelEffect = Array.isArray(data.effects)
        ? data.effects.find((effect: any) => effect?.type === "open-panel" && typeof effect.key === "string")
        : undefined;
      const responseMarkdown = typeof data.markdown === "string" && data.markdown ? data.markdown : undefined;
      if (openPanelEffect) {
        close();
        openPanel?.(openPanelEffect.key);
      }
      if (responseMarkdown) showPopover(String(data.label || action.label || action.title), responseMarkdown, true);
    } catch (error) {
      if (getSessionId() !== invokedSessionId) return;
      showPopover(action.label || action.title, error instanceof Error ? error.message : String(error));
    }
  }

  function render(actions: unknown) {
    close();
    container.textContent = "";
    if (!Array.isArray(actions)) return;
    for (const raw of actions) {
      const action = raw as HeaderAction;
      if (typeof action.key !== "string" || !action.key) continue;
      const title = typeof action.title === "string" && action.title.trim() ? action.title.trim() : action.key;
      const label = typeof action.label === "string" && action.label.trim() ? action.label.trim() : title;
      const icon = typeof action.icon === "string" && knownIcons.has(action.icon as IconName) ? action.icon as IconName : "star";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "iconButton statusBarButton webHeaderActionButton";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.append(iconElement(icon));
      button.addEventListener("click", () => invoke({ key: action.key as string, title, label }, button));
      container.append(button);
    }
  }

  return { render, close };
}
