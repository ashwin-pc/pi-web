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

export type WebPanelsController = {
  setPanels(value: unknown, sessionId: string): void;
  entries(): WebPanelEntry[];
  open(key: string): void;
  update(key: string): void;
  isOpen(): boolean;
};

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

  async function invoke(event?: { action?: string; payload?: unknown; fields?: Record<string, string | string[]> }) {
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
      const autofocus = body.querySelector<HTMLElement>("[autofocus]");
      autofocus?.focus({ preventScroll: true });
    } catch (error) {
      if (generation === requestGeneration && activeKey === entry.key) renderError(error);
    } finally {
      if (generation === requestGeneration) panel.removeAttribute("aria-busy");
    }
  }

  function open(key: string) {
    const entry = panels.find((candidate) => candidate.key === key);
    if (!entry) return;
    activeKey = key;
    renderHeading(entry);
    panelHandle.open();
    void invoke();
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
