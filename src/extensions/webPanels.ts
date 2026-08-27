import { iconElement, isIconName } from "../app/icons.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";

type WebPanelEntry = {
  key: string;
  title: string;
  label: string;
  icon: string;
};

type WebPanelView = {
  title?: string;
  html?: string;
};

export type WebPanelEvent = { action?: string; payload?: unknown; fields?: Record<string, string | string[]> };

export type WebPanelsController = {
  setPanels(value: unknown, sessionId: string): void;
  entries(): WebPanelEntry[];
  open(key: string, initialEvent?: WebPanelEvent): void;
  update(key: string): void;
  isOpen(): boolean;
};

export function parsePanelDeepLink(href: string): { key: string; payload: Record<string, string> } | undefined {
  if (!href.startsWith("#panel:")) return undefined;
  const separator = href.indexOf(":", 7);
  if (separator <= 7 || separator === href.length - 1) return undefined;
  const key = href.slice(7, separator);
  const query = href.slice(separator + 1);
  const parts = query.split("&");
  if (parts.some((part) => !part || part.indexOf("=") <= 0)) return undefined;
  try {
    for (const part of parts) decodeURIComponent(part.replace(/\+/g, " "));
    return { key, payload: Object.fromEntries(new URLSearchParams(query)) };
  } catch { return undefined; }
}

export function openPanelDeepLink(href: string, open: (key: string, event: WebPanelEvent) => void) {
  const link = parsePanelDeepLink(href);
  if (!link) return false;
  open(link.key, { action: "deep-link", payload: link.payload });
  return true;
}

function normalizePanels(value: unknown): WebPanelEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw): WebPanelEntry[] => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : key;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : title;
    const icon = typeof entry.icon === "string" && isIconName(entry.icon) ? entry.icon : "square-pen";
    return [{ key, title, label, icon }];
  });
}

function parsePayload(value: string | undefined) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function formFields(form: HTMLFormElement | null) {
  if (!form) return undefined;
  const fields: Record<string, string | string[]> = {};
  for (const [key, value] of new FormData(form)) {
    if (typeof value !== "string") continue;
    const current = fields[key];
    if (current === undefined) fields[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else fields[key] = [current, value];
  }
  return fields;
}

type WebPanelTreeIcon = "folder" | "file" | "note" | "pin" | "link";
export type WebPanelTreeNode = {
  id: string;
  label: string;
  meta?: string;
  icon?: WebPanelTreeIcon;
  children?: WebPanelTreeNode[];
  open?: boolean;
  action?: string;
  payload?: unknown;
  selected?: boolean;
};

const webPanelTreeIcons = new Set<WebPanelTreeIcon>(["folder", "file", "note", "pin", "link"]);

function normalizeWebPanelTreeNode(value: unknown): WebPanelTreeNode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.label !== "string") return undefined;
  if (raw.meta !== undefined && typeof raw.meta !== "string") return undefined;
  if (raw.children !== undefined && !Array.isArray(raw.children)) return undefined;
  if (raw.open !== undefined && typeof raw.open !== "boolean") return undefined;
  if (raw.action !== undefined && typeof raw.action !== "string") return undefined;
  if (raw.selected !== undefined && typeof raw.selected !== "boolean") return undefined;
  let children: WebPanelTreeNode[] | undefined;
  if (Array.isArray(raw.children)) {
    children = [];
    for (const child of raw.children) {
      const normalized = normalizeWebPanelTreeNode(child);
      if (!normalized) return undefined;
      children.push(normalized);
    }
  }
  const icon = typeof raw.icon === "string" && webPanelTreeIcons.has(raw.icon as WebPanelTreeIcon)
    ? raw.icon as WebPanelTreeIcon : "file";
  return {
    id: raw.id,
    label: raw.label,
    ...(raw.meta !== undefined ? { meta: raw.meta as string } : {}),
    icon,
    ...(children ? { children } : {}),
    ...(raw.open !== undefined ? { open: raw.open as boolean } : {}),
    ...(raw.action !== undefined ? { action: raw.action as string } : {}),
    ...("payload" in raw ? { payload: raw.payload } : {}),
    ...(raw.selected !== undefined ? { selected: raw.selected as boolean } : {}),
  };
}

export function parseWebPanelTree(value: string): WebPanelTreeNode[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const nodes: WebPanelTreeNode[] = [];
    for (const value of values) {
      const node = normalizeWebPanelTreeNode(value);
      if (!node) return undefined;
      nodes.push(node);
    }
    return nodes;
  } catch { return undefined; }
}

function treeStateKey(panelKey: string, nodeId: string) { return `${panelKey}\u0000${nodeId}`; }

function webPanelTreeIcon(document: Document, name: WebPanelTreeIcon) {
  const host = document.createElement("span");
  host.className = `webPanelTreeIcon${name === "pin" ? " webPanelTreePin" : ""}`;
  host.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const paths: Record<WebPanelTreeIcon, string[]> = {
    folder: ["M3 6h6l2 2h10v10H3z"],
    file: ["M6 2h8l4 4v16H6z", "M14 2v5h5"],
    note: ["M6 3h9l3 3v15H6z", "M9 11h6", "M9 15h6", "M14 3v4h4"],
    pin: ["M12 17v5", "M5 17h14", "M7 3h10l-1 8 3 3H5l3-3-1-8Z"],
    link: ["M10 13a4 4 0 0 0 5.7.1l2-2A4 4 0 0 0 12 5.4l-1.1 1.1", "M14 11a4 4 0 0 0-5.7-.1l-2 2a4 4 0 0 0 5.7 5.7l1.1-1.1"],
  };
  for (const data of paths[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  host.append(svg);
  return host;
}

function setTreeAction(element: HTMLElement, node: WebPanelTreeNode) {
  if (!node.action) return;
  element.dataset.webAction = node.action;
  if (node.payload !== undefined) element.dataset.webPayload = JSON.stringify(node.payload);
}

function visibleTreeRows(tree: HTMLElement) {
  return [...tree.querySelectorAll<HTMLElement>(".webPanelTreeDirLabel, .webPanelTreeItem")].filter((row) => {
    for (let ancestor = row.parentElement; ancestor && ancestor !== tree; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DETAILS" && !(ancestor as HTMLDetailsElement).open
        && ancestor.firstElementChild !== row && !ancestor.firstElementChild?.contains(row)) return false;
    }
    return true;
  });
}

function installTreeKeyboard(tree: HTMLElement, expansionState: Map<string, boolean>, panelKey: string) {
  const rows = [...tree.querySelectorAll<HTMLElement>(".webPanelTreeDirLabel, .webPanelTreeItem")];
  for (const row of rows) row.tabIndex = -1;
  if (rows[0]) rows[0].tabIndex = 0;
  const focus = (row: HTMLElement) => {
    for (const candidate of rows) candidate.tabIndex = candidate === row ? 0 : -1;
    row.focus();
  };
  const setOpen = (summary: HTMLElement, open: boolean) => {
    const details = summary.parentElement as HTMLDetailsElement | null;
    if (!details || details.tagName !== "DETAILS") return;
    details.open = open;
    summary.setAttribute("aria-expanded", String(open));
    expansionState.set(treeStateKey(panelKey, details.dataset.webTreeNodeId || ""), open);
  };
  tree.addEventListener("focusin", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".webPanelTreeDirLabel, .webPanelTreeItem") : null;
    if (row && tree.contains(row)) for (const candidate of rows) candidate.tabIndex = candidate === row ? 0 : -1;
  });
  tree.addEventListener("keydown", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".webPanelTreeDirLabel, .webPanelTreeItem") : null;
    if (!row || !tree.contains(row)) return;
    const visible = visibleTreeRows(tree);
    const index = visible.indexOf(row);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) focus(next);
      event.preventDefault();
      return;
    }
    const summary = row.classList.contains("webPanelTreeDirLabel") ? row : null;
    if (event.key === "ArrowRight" && summary) {
      const details = summary.parentElement as HTMLDetailsElement;
      if (!details.open) setOpen(summary, true);
      else if (visible[index + 1]) focus(visible[index + 1]);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft") {
      if (summary && (summary.parentElement as HTMLDetailsElement).open) setOpen(summary, false);
      else {
        const group = row.parentElement?.closest<HTMLElement>(".webPanelTreeChildren");
        const parentSummary = group?.parentElement?.querySelector<HTMLElement>(":scope > .webPanelTreeDirLabel");
        if (parentSummary) focus(parentSummary);
      }
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && summary) {
      const action = summary.querySelector<HTMLElement>("[data-web-action]");
      if (action) action.click();
      else setOpen(summary, !(summary.parentElement as HTMLDetailsElement).open);
      event.preventDefault();
    }
  });
}

/** Expand host-owned tree placeholders after trusted extension HTML is inserted. */
export function expandWebPanelTrees(root: ParentNode, panelKey: string, expansionState: Map<string, boolean>) {
  for (const placeholder of root.querySelectorAll<HTMLElement>("div[data-web-panel-tree]")) {
    placeholder.textContent = "";
    const nodes = parseWebPanelTree(placeholder.dataset.webPanelTree || "");
    if (!nodes) {
      console.warn("pi-web ignored a malformed data-web-panel-tree placeholder");
      continue;
    }
    const document = placeholder.ownerDocument;
    const tree = document.createElement("div");
    tree.className = "webPanelTree";
    tree.setAttribute("role", "tree");
    const accessibleName = placeholder.getAttribute("aria-label");
    if (accessibleName) tree.setAttribute("aria-label", accessibleName);
    const appendNode = (parent: HTMLElement, node: WebPanelTreeNode) => {
      const label = document.createElement("span");
      label.className = "webPanelTreeLabel";
      label.textContent = node.label;
      const meta = node.meta === undefined ? undefined : document.createElement("span");
      if (meta) { meta.className = "webPanelTreeMeta"; meta.textContent = node.meta!; }
      if (node.children) {
        const details = document.createElement("details");
        details.className = "webPanelTreeDir";
        details.dataset.webTreeNodeId = node.id;
        const persisted = expansionState.get(treeStateKey(panelKey, node.id));
        details.open = persisted ?? node.open === true;
        const summary = document.createElement("summary");
        summary.className = "webPanelTreeDirLabel";
        summary.setAttribute("role", "treeitem");
        summary.setAttribute("aria-expanded", String(details.open));
        if (node.selected) summary.setAttribute("aria-selected", "true");
        summary.append(webPanelTreeIcon(document, node.icon || "file"));
        if (node.action) setTreeAction(label, node);
        summary.append(label);
        if (meta) summary.append(meta);
        const group = document.createElement("div");
        group.className = "webPanelTreeChildren";
        group.setAttribute("role", "group");
        for (const child of node.children) appendNode(group, child);
        details.append(summary, group);
        details.addEventListener("toggle", () => {
          summary.setAttribute("aria-expanded", String(details.open));
          expansionState.set(treeStateKey(panelKey, node.id), details.open);
        });
        parent.append(details);
        return;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "webPanelTreeItem";
      item.setAttribute("role", "treeitem");
      item.dataset.webTreeNodeId = node.id;
      if (node.selected) item.setAttribute("aria-selected", "true");
      setTreeAction(item, node);
      item.append(webPanelTreeIcon(document, node.icon || "file"), label);
      if (meta) item.append(meta);
      parent.append(item);
    };
    for (const node of nodes) appendNode(tree, node);
    installTreeKeyboard(tree, expansionState, panelKey);
    placeholder.replaceWith(tree);
  }
}

export function createWebPanels(options: {
  rightPanels: RightPanelManager;
  apiHeaders: () => HeadersInit;
  getSessionId: () => string;
}): WebPanelsController {
  const { rightPanels, apiHeaders, getSessionId } = options;
  const panel = document.createElement("section");
  panel.className = "webPanel";
  panel.id = "webExtensionPanel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "webExtensionPanelTitle");

  const header = document.createElement("header");
  header.className = "webPanelHeader";
  const heading = document.createElement("h2");
  heading.id = "webExtensionPanelTitle";
  const headingIcon = document.createElement("span");
  headingIcon.className = "webPanelTitleIcon";
  const headingText = document.createElement("span");
  heading.append(headingIcon, headingText);
  const close = document.createElement("button");
  close.className = "webPanelClose";
  close.type = "button";
  close.title = "Close panel";
  close.setAttribute("aria-label", "Close panel");
  close.append(iconElement("x"));
  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "webPanelBody";
  panel.append(header, body);
  document.body.append(panel);

  let panels: WebPanelEntry[] = [];
  let sessionId = "";
  let activeKey = "";
  let requestGeneration = 0;
  let updatePending = false;
  let panelHandle: RightPanelHandle;
  const treeExpansionState = new Map<string, boolean>();

  function formControlIsFocused() {
    const active = document.activeElement;
    return active instanceof HTMLElement && body.contains(active)
      && active.matches("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])");
  }

  function activePanel() {
    return panels.find((entry) => entry.key === activeKey);
  }

  function renderHeading(entry: WebPanelEntry, title?: string) {
    headingIcon.textContent = "";
    headingIcon.append(iconElement(isIconName(entry.icon) ? entry.icon : "square-pen"));
    headingText.textContent = title?.trim() || entry.title;
  }

  function renderError(error: unknown) {
    body.textContent = "";
    const message = document.createElement("div");
    message.className = "webPanelError";
    message.setAttribute("role", "alert");
    message.textContent = error instanceof Error ? error.message : String(error);
    body.append(message);
  }

  async function invoke(event?: WebPanelEvent) {
    const entry = activePanel();
    if (!entry) return;
    const generation = ++requestGeneration;
    panel.setAttribute("aria-busy", "true");
    if (!event) body.textContent = "Loading…";
    try {
      const res = await fetch("/api/web-contributions/invoke", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ sessionId: getSessionId(), slot: "panel", key: entry.key, event }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string } & WebPanelView;
      if (!res.ok || !data.ok) throw new Error(data.error || res.statusText || "Panel request failed");
      if (generation !== requestGeneration || activeKey !== entry.key) return;
      if (typeof data.html !== "string") throw new Error("Panel returned no content");
      renderHeading(entry, data.title);
      body.innerHTML = data.html;
      expandWebPanelTrees(body, entry.key, treeExpansionState);
      const autofocus = body.querySelector<HTMLElement>("[autofocus]");
      autofocus?.focus({ preventScroll: true });
      const highlight = body.querySelector<HTMLElement>("[data-web-panel-highlight]");
      if (highlight) {
        highlight.classList.add("webPanelDeepLinkHighlight");
        highlight.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch (error) {
      if (generation === requestGeneration && activeKey === entry.key) renderError(error);
    } finally {
      if (generation === requestGeneration) panel.removeAttribute("aria-busy");
    }
  }

  function open(key: string, initialEvent?: WebPanelEvent) {
    const entry = panels.find((candidate) => candidate.key === key);
    if (!entry) return;
    activeKey = key;
    renderHeading(entry);
    panelHandle.open();
    void invoke(initialEvent);
  }

  function actionTarget(event: Event) {
    return event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-web-action], [data-web-panel-action]")
      : null;
  }

  body.addEventListener("click", (event) => {
    const target = actionTarget(event);
    if (!target || !body.contains(target)) return;
    if ((target instanceof HTMLButtonElement || target instanceof HTMLInputElement)
      && target.type === "submit" && target.form) return;
    event.preventDefault();
    updatePending = false;
    void invoke({
      action: target.dataset.webAction || target.dataset.webPanelAction || "",
      payload: parsePayload(target.dataset.webPayload || target.dataset.webPanelPayload),
      fields: formFields(target.closest("form")),
    });
  });

  body.addEventListener("submit", (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    updatePending = false;
    const submitter = event.submitter instanceof HTMLElement ? event.submitter : undefined;
    void invoke({
      action: submitter?.dataset.webAction || submitter?.dataset.webPanelAction || event.target.dataset.webAction || event.target.dataset.webPanelAction || "",
      payload: parsePayload(submitter?.dataset.webPayload || submitter?.dataset.webPanelPayload || event.target.dataset.webPayload || event.target.dataset.webPanelPayload),
      fields: formFields(event.target),
    });
  });

  body.addEventListener("focusout", () => queueMicrotask(() => {
    if (!updatePending || formControlIsFocused() || !panelHandle.isOpen()) return;
    updatePending = false;
    void invoke();
  }));

  panelHandle = rightPanels.register({
    id: "web-extension",
    side: "right",
    panel,
    closeButton: close,
    width: "480px",
    minWidth: 320,
    maxWidth: 900,
    focusOnOpen: close,
    onClose: () => { requestGeneration += 1; updatePending = false; },
  });

  // Capture at document scope so deep links work from rendered messages, tool
  // cards, extension content, and synthetic in-app anchors. Stop propagation to
  // avoid the older messages-only delegate in main.ts dispatching a second open.
  document.addEventListener("click", (event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#panel:"]') : null;
    if (!anchor || !openPanelDeepLink(anchor.getAttribute("href") || "", open)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  return {
    setPanels(value, nextSessionId) {
      const changedSession = sessionId !== nextSessionId;
      sessionId = nextSessionId;
      panels = normalizePanels(value);
      if (changedSession || (activeKey && !activePanel())) {
        requestGeneration += 1;
        updatePending = false;
        activeKey = "";
        body.textContent = "";
        if (panelHandle.isOpen()) panelHandle.close(false);
      }
    },
    entries: () => [...panels],
    open,
    update: (key) => {
      if (key !== activeKey || !panelHandle.isOpen()) return;
      if (formControlIsFocused()) updatePending = true;
      else void invoke();
    },
    isOpen: () => panelHandle.isOpen(),
  };
}
