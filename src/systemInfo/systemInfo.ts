import type { ApiClient } from "../app/api.js";
import { iconElement, setIcon } from "../app/icons.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import type { SystemInfoSnapshot } from "./types.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}

function reportText(info: SystemInfoSnapshot): string {
  return [
    `pi-web ${info.piWeb.version}`,
    `Environment: ${info.piWeb.environment}`,
    `Node.js: ${info.piWeb.nodeVersion}`,
    `Process: ${info.piWeb.processId} · uptime ${formatDuration(info.piWeb.processUptimeSeconds)}`,
    `Process listen address: ${info.piWeb.listenAddress}`,
    `Install directory: ${info.piWeb.installDirectory}`,
    "",
    `pi ${info.pi.version}`,
    `Agent directory: ${info.pi.agentDirectory}`,
    "",
    `Host: ${info.host.hostname}`,
    `OS: ${info.host.operatingSystem} ${info.host.release} (${info.host.platform})`,
    `Architecture: ${info.host.architecture}`,
    `CPU: ${info.host.cpuModel} · ${info.host.logicalCpuCount} logical cores`,
    `Memory: ${formatBytes(info.host.freeMemoryBytes)} free / ${formatBytes(info.host.totalMemoryBytes)} total`,
    `Host uptime: ${formatDuration(info.host.uptimeSeconds)}`,
    `Captured: ${info.capturedAt}`,
  ].join("\n");
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export type SystemInfoController = {
  init: () => void;
  refresh: () => Promise<void>;
  setExtensionContributions: (value: unknown, sessionId: string) => void;
};

export function createSystemInfo(options: {
  api: ApiClient;
  rightPanels?: RightPanelManager;
  trigger: HTMLButtonElement;
  focusOnClose: HTMLElement;
  apiHeaders: () => HeadersInit;
  getSessionId: () => string;
  onError: (message: string) => void;
}): SystemInfoController {
  const { api, rightPanels, trigger, focusOnClose, apiHeaders, getSessionId, onError } = options;
  const backdrop = el("div", "systemInfoBackdrop");
  backdrop.hidden = true;
  const panel = el("aside", "systemInfoPanel");
  panel.id = "systemInfoPanel";
  panel.setAttribute("aria-label", "System information");
  panel.hidden = true;

  const header = el("header", "systemInfoHeader");
  const identity = el("div", "systemInfoIdentity");
  const heading = el("h2", undefined, "System information");
  heading.tabIndex = -1;
  identity.append(heading, el("p", undefined, "pi-web, pi, and host runtime details"));
  const headerActions = el("div", "systemInfoHeaderActions");
  const refreshButton = el("button", "iconButton");
  refreshButton.type = "button";
  refreshButton.title = "Refresh system information";
  refreshButton.setAttribute("aria-label", refreshButton.title);
  refreshButton.append(iconElement("rotate-ccw"));
  const closeButton = el("button", "iconButton");
  closeButton.type = "button";
  closeButton.title = "Close system information";
  closeButton.setAttribute("aria-label", closeButton.title);
  setIcon(closeButton, "x");
  headerActions.append(refreshButton, closeButton);
  header.append(identity, headerActions);

  const body = el("div", "systemInfoBody");
  const status = el("p", "systemInfoStatus");
  status.setAttribute("aria-live", "polite");
  const content = el("div", "systemInfoContent");
  body.append(status, content);
  panel.append(header, body);
  document.body.append(backdrop, panel);

  let panelHandle: RightPanelHandle | undefined;

  let extensionEntries: Array<{ key: string; title: string; label: string }> = [];
  let extensionSessionId = "";

  function normalizeExtensionInfo(value: unknown): Array<{ key: string; title: string; label: string }> {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap((raw): Array<{ key: string; title: string; label: string }> => {
      if (!raw || typeof raw !== "object") return [];
      const entry = raw as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!key || seen.has(key)) return [];
      seen.add(key);
      const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : key;
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : title;
      return [{ key, title, label }];
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

  async function invokeExtensionSection(entry: { key: string; title: string; label: string }, bodyEl: HTMLElement, section: HTMLElement, event?: { action?: string; payload?: unknown; fields?: Record<string, string | string[]> }) {
    const sessionId = extensionSessionId;
    if (!sessionId) return;
    bodyEl.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/web-contributions/invoke", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ sessionId, slot: "system-info", key: entry.key, event }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; title?: string; html?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText || "System-info contribution failed");
      if (typeof data.html !== "string") throw new Error("System-info contribution returned no content");
      if (data.title?.trim()) section.firstElementChild?.replaceWith(el("h3", undefined, data.title.trim()));
      bodyEl.innerHTML = data.html;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bodyEl.replaceChildren(el("div", "systemInfoError", message));
    } finally {
      bodyEl.removeAttribute("aria-busy");
    }
  }

  function wireExtensionSection(entry: { key: string; title: string; label: string }, bodyEl: HTMLElement, section: HTMLElement) {
    bodyEl.addEventListener("click", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-web-action]")
        : null;
      if (!target || !bodyEl.contains(target)) return;
      if ((target instanceof HTMLButtonElement || target instanceof HTMLInputElement)
        && target.type === "submit" && target.form) return;
      event.preventDefault();
      void invokeExtensionSection(entry, bodyEl, section, {
        action: target.dataset.webAction || "",
        payload: parsePayload(target.dataset.webPayload),
        fields: formFields(target.closest("form")),
      });
    });
    bodyEl.addEventListener("submit", (event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      event.preventDefault();
      const submitter = event.submitter instanceof HTMLElement ? event.submitter : undefined;
      void invokeExtensionSection(entry, bodyEl, section, {
        action: submitter?.dataset.webAction || event.target.dataset.webAction || "",
        payload: parsePayload(submitter?.dataset.webPayload || event.target.dataset.webPayload),
        fields: formFields(event.target),
      });
    });
  }

  async function renderExtensionContributions() {
    const sessionId = extensionSessionId;
    const entries = extensionEntries;
    if (!sessionId || entries.length === 0) return;
    for (const entry of entries) {
      const section = el("section", "systemInfoSection");
      section.append(el("h3", undefined, entry.title));
      const bodyEl = el("div", "systemInfoExtensionBody");
      bodyEl.textContent = "Loading…";
      section.append(bodyEl);
      content.append(section);
      wireExtensionSection(entry, bodyEl, section);
      await invokeExtensionSection(entry, bodyEl, section);
    }
  }

  function detailSection(title: string, rows: Array<[string, string]>) {
    const section = el("section", "systemInfoSection");
    section.append(el("h3", undefined, title));
    const list = el("dl", "systemInfoList");
    for (const [label, value] of rows) {
      const row = el("div", "systemInfoRow");
      row.append(el("dt", undefined, label), el("dd", undefined, value));
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function render(info: SystemInfoSnapshot) {
    const overview = el("section", "systemInfoOverview");
    const mark = el("span", "systemInfoMark");
    mark.append(iconElement("info"));
    const overviewCopy = el("div", "systemInfoOverviewCopy");
    overviewCopy.append(
      el("span", undefined, "pi-web"),
      el("strong", undefined, `v${info.piWeb.version}`),
      el("small", undefined, `${info.piWeb.environment} · ${info.piWeb.nodeVersion}`),
    );
    overview.append(mark, overviewCopy);

    const actions = el("div", "systemInfoActions");
    const copyButton = el("button", undefined, "Copy system report");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => {
      void copyText(reportText(info)).then(() => {
        status.textContent = "System report copied";
      }).catch((error) => {
        status.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    actions.append(copyButton);

    content.replaceChildren(
      overview,
      detailSection("pi", [
        ["Version", info.pi.version],
        ["Agent directory", info.pi.agentDirectory],
      ]),
      detailSection("pi-web runtime", [
        ["Node.js", info.piWeb.nodeVersion],
        ["Process", `${info.piWeb.processId} · up ${formatDuration(info.piWeb.processUptimeSeconds)}`],
        ["Process listen address", info.piWeb.listenAddress],
        ["Install directory", info.piWeb.installDirectory],
      ]),
      detailSection("Host machine", [
        ["Hostname", info.host.hostname],
        ["Operating system", `${info.host.operatingSystem} ${info.host.release}`],
        ["Platform", `${info.host.platform} · ${info.host.architecture}`],
        ["Processor", info.host.cpuModel],
        ["Logical CPUs", String(info.host.logicalCpuCount)],
        ["Memory", `${formatBytes(info.host.freeMemoryBytes)} free of ${formatBytes(info.host.totalMemoryBytes)}`],
        ["Host uptime", formatDuration(info.host.uptimeSeconds)],
      ]),
      actions,
    );
    status.textContent = info.piWeb.environment === "mock"
      ? "Updated Jan 15, 2026, 12:00 PM"
      : `Updated ${new Date(info.capturedAt).toLocaleString()}`;
  }

  async function refresh() {
    status.textContent = "Loading system information…";
    refreshButton.disabled = true;
    try {
      const response = await fetch("/api/system-info", { headers: api.headers() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false || !data.system) throw new Error(data.error || `Unable to read system information (${response.status})`);
      render(data.system as SystemInfoSnapshot);
      await renderExtensionContributions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content.replaceChildren(el("div", "systemInfoError", message));
      status.textContent = "System information unavailable";
      onError(message);
    } finally {
      refreshButton.disabled = false;
    }
  }

  function init() {
    refreshButton.addEventListener("click", () => void refresh());
    panelHandle = rightPanels?.register({
      id: "system-info",
      side: "right",
      panel,
      trigger,
      backdrop,
      closeButton,
      width: "640px",
      minWidth: 420,
      maxWidth: 760,
      onBeforeOpen: () => { void refresh(); },
      focusOnOpen: heading,
      focusOnClose,
    });
    if (!panelHandle) {
      trigger.addEventListener("click", () => {
        backdrop.hidden = false;
        panel.hidden = false;
        void refresh();
        heading.focus({ preventScroll: true });
      });
      closeButton.addEventListener("click", () => {
        panel.hidden = true;
        backdrop.hidden = true;
        focusOnClose.focus();
      });
      backdrop.addEventListener("click", () => closeButton.click());
    }
  }

  function setExtensionContributions(value: unknown, sessionId: string) {
    extensionEntries = normalizeExtensionInfo(value);
    extensionSessionId = sessionId;
  }

  return {
    init,
    refresh,
    setExtensionContributions,
  };
}
