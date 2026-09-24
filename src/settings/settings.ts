import type { ApiClient } from "../app/api.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppElements } from "../app/elements.js";
import { setIcon } from "../app/icons.js";
import { defaultAccentColor, defaultLoadingAnimation, defaultPiWebSettings, normalizeMarkerColor, orderedSessionMarkerColors, type AppState, type LoadingAnimation, type PiWebModelSetting, type PiWebSettings, type SessionMarkerColorId, type WebSettingsSchema } from "../app/types.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import { createExtensionSettings, type ExtensionSettingsController } from "./extensionSettings.js";
import { createRunNotifications } from "./runNotifications.js";
import { createRestartSettings } from "./restartSettings.js";
import { createSettingsShell, type SettingsShellController } from "./settingsShell.js";
import { createSecuritySettings, type AuthMode } from "./securitySettings.js";

export type SettingsController = {
  init: () => void;
  refreshSettings: () => Promise<void>;
  applySettings: (settings: PiWebSettings) => void;
  applyWebSettingsSchemas: (schemas: WebSettingsSchema[]) => void;
};

type ExtensionLoadStatus = {
  state: "loading" | "ready" | "degraded";
  attempt: number;
  durationMs?: number;
  extensionCount: number;
  errors: Array<{ path: string; error: string }>;
  runtimeErrors?: Array<{ path: string; event: string; error: string; timestamp: string }>;
  message: string;
};

function cloneSettings(settings: PiWebSettings): PiWebSettings {
  return JSON.parse(JSON.stringify(settings)) as PiWebSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAccentColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

function normalizeLoadingAnimation(value: unknown): LoadingAnimation | undefined {
  return value === "fireworks" || value === "glow" || value === "pulse" ? value : undefined;
}

function normalizeSettings(value: unknown): PiWebSettings {
  const settings = cloneSettings(defaultPiWebSettings);
  if (!isRecord(value)) return settings;

  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  if (appearance?.density === "compact" || appearance?.density === "comfortable" || appearance?.density === "minimal") settings.appearance.density = appearance.density;
  settings.appearance.accentColor = normalizeAccentColor(appearance?.accentColor) || settings.appearance.accentColor;
  settings.appearance.loadingAnimation = normalizeLoadingAnimation(appearance?.loadingAnimation) || settings.appearance.loadingAnimation;

  const composer = isRecord(value.composer) ? value.composer : undefined;
  if (composer?.queueMode === "steer" || composer?.queueMode === "followUp") settings.composer.queueMode = composer.queueMode;
  if (typeof composer?.expanded === "boolean") settings.composer.expanded = composer.expanded;

  const defaults = isRecord(value.defaults) ? value.defaults : undefined;
  const model = isRecord(defaults?.model) ? defaults.model : undefined;
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (provider && id) settings.defaults.model = { provider, id };
  if (typeof defaults?.thinkingLevel === "string" && defaults.thinkingLevel.trim()) settings.defaults.thinkingLevel = defaults.thinkingLevel.trim();
  const sessionBucketColor = normalizeMarkerColor(defaults?.sessionBucketColor);
  if (sessionBucketColor) settings.defaults.sessionBucketColor = sessionBucketColor;

  // Carry the extension-settings blob through verbatim (server owns validation).
  if (isRecord(value.extensions)) settings.extensions = value.extensions as PiWebSettings["extensions"];

  return settings;
}

function settingsLabel(settings: PiWebSettings) {
  const model = settings.defaults.model;
  if (!model && !settings.defaults.thinkingLevel) return "No default model saved";
  return [
    model ? `${model.provider}/${model.id}` : "Current pi default model",
    settings.defaults.thinkingLevel ? `reasoning ${settings.defaults.thinkingLevel}` : undefined,
  ].filter(Boolean).join(" · ");
}

function splitModelKey(key: string): PiWebModelSetting | undefined {
  const slashIndex = key.indexOf("/");
  if (slashIndex <= 0) return undefined;
  const provider = key.slice(0, slashIndex);
  const id = key.slice(slashIndex + 1);
  return provider && id ? { provider, id } : undefined;
}

function populateBucketColorSelect(select: HTMLSelectElement, state: AppState) {
  const selected = select.value || state.settings.defaults.sessionBucketColor || "";
  select.replaceChildren(new Option("No default bucket", ""));
  for (const color of orderedSessionMarkerColors(state.bucketOrder)) {
    select.append(new Option(state.bucketLabels[color.id] || color.label, color.id));
  }
  select.value = selected;
}

export function createSettings(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
  /** Called after an applied settings response changes the UI density. */
  onAppearanceChange?: (density: PiWebSettings["appearance"]["density"]) => void;
}): SettingsController {
  const { state, elements, api, rightPanels, addMessage, onAppearanceChange } = options;
  const expandedStorageKey = "pi-web-composer-expanded";
  let hasAppliedSettings = false;
  let settingsPanelHandle: RightPanelHandle | undefined;
  let extSettings: ExtensionSettingsController | undefined;
  let settingsShell: SettingsShellController | undefined;
  let securitySettings: ReturnType<typeof createSecuritySettings> | undefined;
  let restartSettings: ReturnType<typeof createRestartSettings> | undefined;
  let extensionHealth: "loading" | "ready" | "degraded" = "loading";
  const systemStatusButton = elements.sessionDrawerInfoButton;

  function updateSystemStatus() {
    const disconnected = !elements.connectionStatusEl.hidden && (elements.connectionStatusEl.classList.contains("offline") || elements.connectionStatusEl.classList.contains("reconnecting") || elements.connectionStatusEl.classList.contains("syncRequired"));
    const status = disconnected ? "disconnected" : extensionHealth === "degraded" ? "extension-issue" : extensionHealth === "ready" ? "connected" : "checking";
    const label = status === "disconnected" ? "Disconnected" : status === "extension-issue" ? "Extension issue" : status === "connected" ? "Connected" : "Checking extensions";
    const accessibleName = `System: ${label}`;
    systemStatusButton.dataset.status = status;
    systemStatusButton.setAttribute("aria-label", accessibleName);
    systemStatusButton.title = accessibleName;
    const icon = systemStatusButton.querySelector<HTMLElement>(".systemStatusIcon");
    if (icon) setIcon(icon, status === "disconnected" ? "wifi-off" : status === "extension-issue" ? "triangle-alert" : status === "connected" ? "circle-check" : "loader-circle");
  }

  const runNotifications = createRunNotifications({
    elements,
    api,
    onError: (error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"),
  });

  function updateQueueToggle() {
    const isSteer = state.queueMode === "steer";
    elements.queueToggle.setAttribute("aria-pressed", String(isSteer));
    elements.queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
    elements.queueToggle.setAttribute("aria-label", elements.queueToggle.title);
    setIcon(elements.queueToggle, isSteer ? "route" : "corner-down-right");
  }

  function updateExpandedComposer() {
    elements.formEl.classList.toggle("expanded", state.editorExpanded);
    setIcon(elements.expandButton, state.editorExpanded ? "minimize-2" : "maximize-2");
    elements.expandButton.title = state.editorExpanded ? "Collapse editor" : "Expand editor";
    elements.expandButton.setAttribute("aria-label", elements.expandButton.title);
  }

  function savedAccentColor() {
    return normalizeAccentColor(state.settings.appearance.accentColor) || defaultAccentColor;
  }

  function accentSwatchButtons() {
    return Array.from(elements.settingsPanel.querySelectorAll<HTMLButtonElement>(".settingsAccentSwatch"));
  }

  function accentName(accentColor: string) {
    const normalized = normalizeAccentColor(accentColor) || defaultAccentColor;
    const swatch = accentSwatchButtons().find((button) => normalizeAccentColor(button.dataset.accentColor) === normalized);
    return swatch?.dataset.accentName || "Custom";
  }

  function updateExtensionSearchTerms() {
    const terms = (state.webSettingsSchemas ?? []).flatMap((schema) => [
      schema.id,
      schema.title,
      ...schema.fields.flatMap((field) => [
        field.key,
        field.label,
        field.description || "",
        ...(field.itemFields ?? []).flatMap((item) => [item.key, item.label, item.description || ""]),
      ]),
    ]);
    terms.push(...Object.keys(state.settings.extensions ?? {}));
    settingsShell?.setSearchTerms("extensions", terms);
  }

  function setDocumentAccent(accentColor: string) {
    document.documentElement.style.setProperty("--accent", accentColor);
  }

  function syncAccentControls(accentColor: string) {
    const normalized = normalizeAccentColor(accentColor) || defaultAccentColor;
    elements.settingAccentColorInput.value = normalized;
    elements.settingAccentColorInput.setAttribute("aria-invalid", "false");
    elements.settingAccentMenuButton.style.setProperty("--settings-accent-preview", normalized);
    elements.settingAccentMenuName.textContent = accentName(normalized);
    elements.settingAccentMenuValue.textContent = normalized;
    for (const button of accentSwatchButtons()) {
      const selected = normalizeAccentColor(button.dataset.accentColor) === normalized;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-checked", String(selected));
    }
  }

  function isAccentPopoverOpen() {
    return !elements.settingAccentPopover.hidden;
  }

  function openAccentPopover() {
    const accentColor = savedAccentColor();
    syncAccentControls(accentColor);
    setDocumentAccent(accentColor);
    elements.settingAccentPopover.hidden = false;
    elements.settingAccentMenuButton.setAttribute("aria-expanded", "true");
    setSettingsStatus("Choose an accent, then Save accent");
  }

  function closeAccentPopover(options: { restorePreview?: boolean; focusButton?: boolean } = {}) {
    if (!isAccentPopoverOpen()) return;
    const restorePreview = options.restorePreview ?? true;
    const focusButton = options.focusButton ?? true;
    elements.settingAccentPopover.hidden = true;
    elements.settingAccentMenuButton.setAttribute("aria-expanded", "false");
    elements.settingAccentColorInput.setAttribute("aria-invalid", "false");
    if (restorePreview) {
      const accentColor = savedAccentColor();
      setDocumentAccent(accentColor);
      syncAccentControls(accentColor);
    }
    if (focusButton) elements.settingAccentMenuButton.focus();
  }

  function previewAccentColor(value: string | undefined) {
    const accentColor = normalizeAccentColor(value);
    if (!accentColor) {
      elements.settingAccentColorInput.setAttribute("aria-invalid", "true");
      setSettingsStatus("Enter a hex color like #e2b15f", true);
      return false;
    }
    setDocumentAccent(accentColor);
    syncAccentControls(accentColor);
    setSettingsStatus("Previewing accent — save to keep");
    return true;
  }

  function applySettings(rawSettings: PiWebSettings) {
    const previousDensity = state.settings.appearance.density;
    const settings = normalizeSettings(rawSettings);
    const storedExpanded = (() => {
      try {
        const value = sessionStorage.getItem(expandedStorageKey);
        return value === null ? undefined : value === "true";
      } catch {
        return undefined;
      }
    })();
    const shouldInitializeExpanded = !hasAppliedSettings;
    state.settings = settings;
    state.queueMode = settings.composer.queueMode;
    if (shouldInitializeExpanded) state.editorExpanded = storedExpanded ?? settings.composer.expanded;
    hasAppliedSettings = true;

    const accentColor = settings.appearance.accentColor || defaultAccentColor;
    document.documentElement.dataset.density = settings.appearance.density;
    document.documentElement.dataset.loadingAnimation = settings.appearance.loadingAnimation || defaultLoadingAnimation;
    setDocumentAccent(accentColor);
    elements.settingDensitySelect.value = settings.appearance.density;
    elements.settingLoadingAnimationSelect.value = settings.appearance.loadingAnimation || defaultLoadingAnimation;
    syncAccentControls(accentColor);
    elements.settingQueueModeSelect.value = settings.composer.queueMode;
    elements.settingComposerExpandedCheckbox.checked = settings.composer.expanded;
    elements.settingDefaultBucketColorSelect.value = settings.defaults.sessionBucketColor || "";
    elements.settingModelDefaultsValue.textContent = settingsLabel(settings);

    const density = settings.appearance.density === "minimal" ? "Minimal" : settings.appearance.density === "compact" ? "Compact" : "Comfortable";
    const queueMode = settings.composer.queueMode === "steer" ? "Steer" : "Follow up";
    const model = settings.defaults.model;
    settingsShell?.setSummary("appearance", `${density} · ${accentName(accentColor)}`);
    settingsShell?.setSummary("composer", `${queueMode} · ${settings.composer.expanded ? "Expanded" : "Collapsed"}`);
    settingsShell?.setSummary("new-sessions", model ? `${model.provider}/${model.id}` : settings.defaults.sessionBucketColor ? "Bucket default set" : "No defaults set");
    settingsShell?.setSummary("access", "Credentials and devices");
    updateExtensionSearchTerms();
    updateQueueToggle();
    updateExpandedComposer();
    extSettings?.render();
    if (settings.appearance.density !== previousDensity) onAppearanceChange?.(settings.appearance.density);
  }

  function setSettingsStatus(message: string, isError = false) {
    elements.settingsStatusEl.textContent = message;
    elements.settingsStatusEl.classList.toggle("error", isError);
  }

  function renderExtensionStatus(status: ExtensionLoadStatus) {
    extensionHealth = status.state;
    updateSystemStatus();
    document.dispatchEvent(new CustomEvent("pi-web-extension-health", { detail: { state: status.state } }));
    const badge = elements.extensionStatusBadge;
    badge.className = `extensionStatusBadge ${status.state}`;
    badge.textContent = status.state === "ready" ? "Ready" : status.state === "degraded" ? "Degraded" : "Loading…";
    elements.extensionStatusMessage.textContent = status.message;
    elements.extensionReloadButton.disabled = status.state === "loading";
    elements.extensionStatusDetails.replaceChildren();

    const facts = document.createElement("div");
    const duration = typeof status.durationMs === "number" ? ` · ${status.durationMs}ms` : "";
    facts.textContent = `${status.extensionCount} loaded · attempt ${status.attempt}${duration}`;
    elements.extensionStatusDetails.append(facts);
    for (const error of status.errors) {
      const row = document.createElement("div");
      row.className = "extensionStatusError";
      row.textContent = `${error.path}: ${error.error}`;
      elements.extensionStatusDetails.append(row);
    }
    for (const error of status.runtimeErrors || []) {
      const row = document.createElement("div");
      row.className = "extensionStatusError";
      const time = Number.isNaN(Date.parse(error.timestamp)) ? error.timestamp : new Date(error.timestamp).toLocaleString();
      row.textContent = `${error.path} · ${error.event} · ${time}: ${error.error}`;
      elements.extensionStatusDetails.append(row);
    }
    elements.extensionStatusDetails.hidden = status.state === "ready" && status.errors.length === 0 && !status.runtimeErrors?.length;
    settingsShell?.setBadge("extension-health", status.state === "loading" ? "…" : status.state === "ready" ? "Ready" : "Issue", status.state === "ready" ? "ready" : status.state === "degraded" ? "danger" : "neutral");
    settingsShell?.setSummary("extension-health", `${status.extensionCount} loaded · ${status.state === "ready" ? "Healthy" : status.state === "degraded" ? "Needs attention" : "Checking"}`);
  }

  function renderExtensionStatusError(error: unknown) {
    extensionHealth = "degraded";
    updateSystemStatus();
    document.dispatchEvent(new CustomEvent("pi-web-extension-health", { detail: { state: "degraded" } }));
    elements.extensionStatusBadge.className = "extensionStatusBadge degraded";
    elements.extensionStatusBadge.textContent = "Unavailable";
    elements.extensionStatusMessage.textContent = error instanceof Error ? error.message : String(error);
    elements.extensionStatusDetails.hidden = true;
    elements.extensionReloadButton.disabled = false;
    settingsShell?.setBadge("extension-health", "Issue", "danger");
    settingsShell?.setSummary("extension-health", "Status unavailable");
  }

  async function refreshExtensionStatus() {
    const params = new URLSearchParams();
    if (state.currentSessionId) params.set("sessionId", state.currentSessionId);
    const res = await fetch(`/api/extensions/status?${params}`, { headers: api.headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Unable to read extension status (${res.status})`);
    renderExtensionStatus(data.status as ExtensionLoadStatus);
  }

  async function reloadExtensions() {
    elements.extensionStatusBadge.className = "extensionStatusBadge loading";
    elements.extensionStatusBadge.textContent = "Retrying…";
    elements.extensionStatusMessage.textContent = "Reloading extensions and models without restarting pi-web…";
    elements.extensionStatusDetails.hidden = true;
    elements.extensionReloadButton.disabled = true;
    try {
      const res = await fetch("/api/extensions/reload", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `Unable to reload extensions (${res.status})`);
      renderExtensionStatus(data.status as ExtensionLoadStatus);
      setSettingsStatus(data.status?.state === "ready" ? "Extensions reloaded" : "Extension reload completed with errors", data.status?.state !== "ready");
    } catch (error) {
      renderExtensionStatusError(error);
      setSettingsStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function patchSettings(patch: unknown) {
    setSettingsStatus("Saving…");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: api.headers(),
      body: JSON.stringify(patch),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new Error(data.error || text);
    applySettings(data.settings);
    setSettingsStatus("Saved");
  }

  function saveAccentColor() {
    const accentColor = normalizeAccentColor(elements.settingAccentColorInput.value);
    if (!accentColor) {
      elements.settingAccentColorInput.setAttribute("aria-invalid", "true");
      setSettingsStatus("Enter a hex color like #e2b15f", true);
      return;
    }
    patchSettings({ appearance: { accentColor } }).then(() => {
      closeAccentPopover({ restorePreview: false });
    }).catch((error) => {
      closeAccentPopover({ restorePreview: true, focusButton: false });
      setSettingsStatus(error instanceof Error ? error.message : String(error), true);
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    });
  }

  async function refreshSettings() {
    const res = await fetch("/api/settings", { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (Array.isArray(data.webSettingsSchemas)) state.webSettingsSchemas = data.webSettingsSchemas;
    applySettings(data.settings);
  }

  async function saveBucketOrder(bucketOrder: SessionMarkerColorId[]) {
    const res = await fetch("/api/session-ui-state", { method: "PATCH", headers: api.headers(), body: JSON.stringify({ bucketOrder }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    state.bucketOrder = data.sessionUiState?.bucketOrder || bucketOrder;
    document.dispatchEvent(new CustomEvent("pi-web-bucket-labels-changed"));
  }

  function renderBucketNames() {
    const container = elements.settingsPanel.querySelector<HTMLElement>("#settingBucketNames");
    if (!container) return;
    populateBucketColorSelect(elements.settingDefaultBucketColorSelect, state);
    container.replaceChildren();
    const customLabelCount = Object.keys(state.bucketLabels).length;
    const defaultColors = orderedSessionMarkerColors(undefined);
    const reordered = state.bucketOrder.some((id, index) => id !== defaultColors[index]?.id);
    settingsShell?.setSummary("buckets", [customLabelCount ? `${customLabelCount} custom` : "", reordered ? "Custom order" : ""].filter(Boolean).join(" · ") || "Names and display order");
    settingsShell?.setSearchTerms("buckets", Object.values(state.bucketLabels).filter((label): label is string => Boolean(label)));
    const colors = orderedSessionMarkerColors(state.bucketOrder);
    const instructions = document.createElement("p");
    instructions.className = "settingsBucketOrderInstructions";
    instructions.textContent = "Drag the grip to reorder. Keyboard: Space to pick up, arrow keys to move, Space to drop, Escape to cancel.";
    const live = document.createElement("span");
    live.className = "srOnly";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    container.append(instructions, live);

    const orderFromRows = () => Array.from(container.querySelectorAll<HTMLElement>(".settingsBucketNameRow"))
      .map((item) => item.dataset.bucketColor as SessionMarkerColorId);
    const commitOrder = async (next: SessionMarkerColorId[], previous: SessionMarkerColorId[]) => {
      state.bucketOrder = next;
      try {
        await saveBucketOrder(next);
        renderBucketNames();
        setSettingsStatus("Bucket order saved");
      } catch (error) {
        state.bucketOrder = previous;
        renderBucketNames();
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
      }
    };

    colors.forEach((color) => {
      const row = document.createElement("div");
      row.className = `settingsBucketNameRow marker-${color.id}`;
      row.dataset.bucketColor = color.id;
      const swatch = document.createElement("span");
      swatch.className = "settingsBucketNameSwatch";
      swatch.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "settingsBucketNameDefault";
      copy.textContent = color.label;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.value = state.bucketLabels[color.id] || "";
      input.placeholder = color.label;
      input.setAttribute("aria-label", `${color.label} bucket name`);
      input.addEventListener("change", async () => {
        const label = input.value.trim().slice(0, 40);
        input.value = label;
        const previousBucketLabels = state.bucketLabels;
        const bucketLabels = { ...previousBucketLabels };
        if (!label || label === color.label) delete bucketLabels[color.id];
        else bucketLabels[color.id] = label;
        state.bucketLabels = bucketLabels;
        try {
          const res = await fetch("/api/session-ui-state", { method: "PATCH", headers: api.headers(), body: JSON.stringify({ bucketLabels }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
          state.bucketLabels = data.sessionUiState?.bucketLabels || bucketLabels;
          document.dispatchEvent(new CustomEvent("pi-web-bucket-labels-changed"));
          populateBucketColorSelect(elements.settingDefaultBucketColorSelect, state);
          const customCount = Object.keys(state.bucketLabels).length;
          const hasCustomOrder = state.bucketOrder.some((id, index) => id !== defaultColors[index]?.id);
          settingsShell?.setSummary("buckets", [customCount ? `${customCount} custom` : "", hasCustomOrder ? "Custom order" : ""].filter(Boolean).join(" · ") || "Names and display order");
          settingsShell?.setSearchTerms("buckets", Object.values(state.bucketLabels).filter((value): value is string => Boolean(value)));
          updateHandleLabel();
          setSettingsStatus("Bucket names saved");
        } catch (error) {
          state.bucketLabels = previousBucketLabels;
          setSettingsStatus(error instanceof Error ? error.message : String(error), true);
          renderBucketNames();
        }
      });

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "settingsBucketDragHandle";
      handle.textContent = "⠿";
      handle.setAttribute("aria-describedby", instructions.id ||= "bucketOrderInstructions");
      const updateHandleLabel = () => {
        const bucketLabel = input.value.trim() || color.label;
        handle.setAttribute("aria-label", `Reorder ${bucketLabel} bucket`);
        handle.title = `Drag to reorder ${bucketLabel}`;
      };
      updateHandleLabel();
      input.addEventListener("input", updateHandleLabel);

      let pointerId: number | undefined;
      let pointerIndex = 0;
      let originalOrder: SessionMarkerColorId[] = [];
      let keyboardGrabbed = false;
      let dragStartY = 0;
      let dragClientY = 0;
      let dragScrollTop = 0;
      let dragRows: HTMLElement[] = [];
      let dragRects: DOMRect[] = [];
      let dragFrame: number | undefined;
      let autoScrollFrame: number | undefined;
      let scrollport: HTMLElement | undefined;
      const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const announcePosition = () => {
        const position = Array.from(container.querySelectorAll(".settingsBucketNameRow")).indexOf(row) + 1;
        live.textContent = `${input.value.trim() || color.label} bucket, position ${position} of ${colors.length}.`;
      };
      const clearDragFrames = () => {
        if (dragFrame !== undefined) cancelAnimationFrame(dragFrame);
        if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame);
        dragFrame = autoScrollFrame = undefined;
      };
      const clearDragStyles = () => {
        clearDragFrames();
        dragRows.forEach((item) => { item.style.transform = ""; });
        row.classList.remove("isDragging", "isSettling");
        container.classList.remove("isReordering");
      };
      const paintDrag = () => {
        dragFrame = undefined;
        if (pointerId === undefined) return;
        const originalIndex = dragRows.indexOf(row);
        const scrollDelta = (scrollport?.scrollTop || 0) - dragScrollTop;
        const rawDy = dragClientY - dragStartY + scrollDelta;
        const minDy = dragRects[0].top - dragRects[originalIndex].top;
        const maxDy = dragRects.at(-1)!.bottom - dragRects[originalIndex].bottom;
        const dy = Math.max(minDy, Math.min(maxDy, rawDy));
        const center = dragRects[originalIndex].top + dragRects[originalIndex].height / 2 + dy;
        pointerIndex = dragRects.reduce((count, rect, index) => index !== originalIndex && rect.top + rect.height / 2 < center ? count + 1 : count, 0);
        row.style.transform = `translateY(${dy}px)${reducedMotion ? "" : " scale(1.015)"}`;
        dragRows.forEach((item, index) => {
          if (item === row) return;
          let shift = 0;
          if (index > originalIndex && index <= pointerIndex) shift = dragRects[index - 1].top - dragRects[index].top;
          else if (index < originalIndex && index >= pointerIndex) shift = dragRects[index + 1].top - dragRects[index].top;
          item.style.transform = shift ? `translateY(${shift}px)` : "";
        });
        live.textContent = `${input.value.trim() || color.label} bucket, position ${pointerIndex + 1} of ${colors.length}.`;
      };
      const schedulePaint = () => { if (dragFrame === undefined) dragFrame = requestAnimationFrame(paintDrag); };
      const autoScroll = () => {
        if (pointerId === undefined || !scrollport) return;
        const rect = scrollport.getBoundingClientRect();
        const edge = Math.min(56, rect.height / 4);
        let velocity = 0;
        if (dragClientY < rect.top + edge) velocity = -12 * (1 - Math.max(0, dragClientY - rect.top) / edge);
        else if (dragClientY > rect.bottom - edge) velocity = 12 * (1 - Math.max(0, rect.bottom - dragClientY) / edge);
        if (velocity) { scrollport.scrollTop += velocity; schedulePaint(); }
        autoScrollFrame = requestAnimationFrame(autoScroll);
      };
      const cancelDrag = () => {
        if (pointerId === undefined) return;
        pointerId = undefined;
        clearDragStyles();
        live.textContent = "Reordering cancelled.";
      };
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || pointerId !== undefined) return;
        pointerId = event.pointerId;
        originalOrder = [...state.bucketOrder];
        pointerIndex = originalOrder.indexOf(color.id);
        dragStartY = dragClientY = event.clientY;
        dragRows = Array.from(container.querySelectorAll<HTMLElement>(".settingsBucketNameRow"));
        dragRects = dragRows.map((item) => item.getBoundingClientRect());
        scrollport = Array.from(container.parentElement ? [container.parentElement, ...Array.from(container.parentElement.closest(".settingsContent") ? [container.parentElement.closest(".settingsContent")!] : [])] : [])
          .find((item): item is HTMLElement => item instanceof HTMLElement && item.scrollHeight > item.clientHeight) || elements.settingsPanel;
        dragScrollTop = scrollport.scrollTop;
        handle.setPointerCapture(event.pointerId);
        row.classList.add("isDragging");
        container.classList.add("isReordering");
        autoScrollFrame = requestAnimationFrame(autoScroll);
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        dragClientY = event.clientY;
        schedulePaint();
        event.preventDefault();
      });
      handle.addEventListener("pointerup", (event) => {
        if (event.pointerId !== pointerId) return;
        pointerId = undefined;
        clearDragFrames();
        const originalIndex = dragRows.indexOf(row);
        row.classList.remove("isDragging");
        row.classList.add("isSettling");
        row.style.transform = `translateY(${dragRects[pointerIndex].top - dragRects[originalIndex].top}px)`;
        try { handle.releasePointerCapture(event.pointerId); } catch { /* capture may already be gone */ }
        const next = [...originalOrder];
        next.splice(next.indexOf(color.id), 1);
        next.splice(pointerIndex, 0, color.id);
        live.textContent = `${input.value.trim() || color.label} bucket dropped.`;
        window.setTimeout(() => {
          clearDragStyles();
          void commitOrder(next, originalOrder);
        }, reducedMotion ? 0 : 180);
      });
      handle.addEventListener("pointercancel", cancelDrag);
      handle.addEventListener("lostpointercapture", () => { if (pointerId !== undefined) cancelDrag(); });
      handle.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (!keyboardGrabbed) {
            keyboardGrabbed = true;
            originalOrder = [...state.bucketOrder];
            row.classList.add("isDragging");
            handle.setAttribute("aria-pressed", "true");
            live.textContent = `${input.value.trim() || color.label} bucket picked up.`;
          } else {
            keyboardGrabbed = false;
            row.classList.remove("isDragging");
            handle.removeAttribute("aria-pressed");
            live.textContent = `${input.value.trim() || color.label} bucket dropped.`;
            void commitOrder(orderFromRows(), originalOrder);
          }
        } else if (keyboardGrabbed && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          event.stopPropagation();
          const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
          if (sibling?.classList.contains("settingsBucketNameRow")) {
            if (event.key === "ArrowUp") container.insertBefore(row, sibling);
            else container.insertBefore(sibling, row);
            announcePosition();
          } else live.textContent = "Already at the boundary.";
        } else if (keyboardGrabbed && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          keyboardGrabbed = false;
          state.bucketOrder = originalOrder;
          live.textContent = "Reordering cancelled.";
          renderBucketNames();
        }
      });
      row.append(handle, swatch, copy, input);
      container.append(row);
    });
  }

  function prepareOpenSettings() {
    renderBucketNames();
    const activeTrigger = elements.settingsPanel.dataset.scope === "system" ? elements.sessionDrawerInfoButton : elements.sessionDrawerSettingsButton;
    activeTrigger.setAttribute("aria-expanded", "true");
    activeTrigger.classList.add("active");
    settingsShell?.prepareOpen();
    setSettingsStatus("");
    elements.extensionStatusBadge.className = "extensionStatusBadge loading";
    elements.extensionStatusBadge.textContent = "Checking…";
    elements.extensionStatusMessage.textContent = "Checking extension status…";
    elements.extensionStatusDetails.hidden = true;
    settingsShell?.setBadge("extension-health", "…", "neutral");
    void restartSettings?.refreshCapability();
    void fetch("/api/auth/info", { headers: api.headers(), credentials: "same-origin" }).then(async response => {
      if (!response.ok) throw new Error(`Security info unavailable (${response.status})`);
      const info = await response.json() as { mode: AuthMode; identity?: { displayName?: string; id: string } };
      settingsShell?.setSummary("access", `${info.mode} · ${info.identity?.displayName || info.identity?.id || "authenticated"}`);
    }).catch(error => settingsShell?.setSummary("access", error instanceof Error ? error.message : String(error)));
    securitySettings?.reset();
    void securitySettings?.refresh().catch(error => setSettingsStatus(error instanceof Error ? error.message : String(error), true));
    void refreshExtensionStatus().catch(renderExtensionStatusError);
    void runNotifications.refresh().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  function afterOpenSettings() {
    elements.settingsCloseButton.focus();
  }

  function prepareCloseSettings() {
    for (const trigger of [elements.sessionDrawerSettingsButton, elements.sessionDrawerInfoButton]) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.classList.remove("active");
    }
    closeAccentPopover({ restorePreview: true, focusButton: false });
    settingsShell?.prepareClose();
  }

  function setPanelScope(scope: "preferences" | "system") {
    settingsShell?.setScope(scope);
    elements.settingsPanel.dataset.scope = scope;
    elements.settingsPanel.querySelector<HTMLElement>(".settingsDesktopTitle")!.textContent = scope === "system" ? "System" : "Preferences";
    elements.settingsPanel.querySelector<HTMLElement>(".settingsDesktopSubtitle")!.textContent = scope === "system" ? "Status, security, and diagnostics" : "Personalize pi-web";
    elements.settingsPanel.setAttribute("aria-label", scope === "system" ? "System" : "Preferences");
    const search = elements.settingsPanel.querySelector<HTMLInputElement>("#settingsSearchInput");
    if (search) search.placeholder = scope === "system" ? "Search system" : "Search preferences";
  }

  function openSettings(scope: "preferences" | "system" = "preferences") {
    setPanelScope(scope);
    if (settingsPanelHandle) {
      settingsPanelHandle.open();
      return;
    }
    blurActiveEditableOnMobile();
    prepareOpenSettings();
    elements.settingsBackdrop.hidden = false;
    elements.settingsPanel.hidden = false;
    afterOpenSettings();
  }

  function closeSettings() {
    if (settingsPanelHandle) {
      settingsPanelHandle.close();
      return;
    }
    prepareCloseSettings();
    elements.settingsPanel.hidden = true;
    elements.settingsBackdrop.hidden = true;
    elements.sessionButton.focus();
  }

  function init() {
    populateBucketColorSelect(elements.settingDefaultBucketColorSelect, state);
    settingsShell = createSettingsShell(elements.settingsPanel);
    settingsShell.init();
    securitySettings = createSecuritySettings({ container: elements.securitySettings, api, setStatus: setSettingsStatus });
    const restartContainer = elements.settingsPanel.querySelector<HTMLElement>("#settingsPageServer");
    const restartNavButton = elements.settingsPanel.querySelector<HTMLButtonElement>("#settingsNavServer");
    if (!restartContainer || !restartNavButton) throw new Error("Missing restart settings page");
    restartSettings = createRestartSettings({ container: restartContainer, navButton: restartNavButton, api, setStatus: setSettingsStatus });
    extSettings = createExtensionSettings({
      container: elements.extensionSettingsContainer,
      api,
      state,
      fetchModels: async () => {
        const res = await fetch("/api/models", { headers: api.headers() });
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data.models) ? data.models : [];
      },
      setStatus: setSettingsStatus,
      notifyError: (message) => addMessage("system", message, "error"),
    });
    applySettings(state.settings);

    settingsPanelHandle = rightPanels?.register({
      id: "settings",
      side: "right",
      panel: elements.settingsPanel,
      trigger: elements.settingsButton,
      backdrop: elements.settingsBackdrop,
      closeButton: elements.settingsCloseButton,
      width: "820px",
      minWidth: 680,
      maxWidth: 980,
      closeOnEscape: false,
      onBeforeOpen: prepareOpenSettings,
      onOpen: afterOpenSettings,
      onBeforeClose: prepareCloseSettings,
      focusOnClose: elements.sessionButton,
    });
    if (!settingsPanelHandle) elements.settingsButton.addEventListener("click", () => openSettings("preferences"));
    document.addEventListener("pi-web-open-settings", (event) => openSettings((event as CustomEvent<{ scope?: "preferences" | "system" }>).detail?.scope || "preferences"));
    if (!settingsPanelHandle) {
      elements.settingsCloseButton.addEventListener("click", closeSettings);
      elements.settingsBackdrop.addEventListener("click", closeSettings);
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (isAccentPopoverOpen()) {
        closeAccentPopover();
        return;
      }
      if (!elements.settingsPanel.hidden && settingsShell?.handleEscape()) return;
      if (!elements.settingsPanel.hidden) closeSettings();
    });

    elements.settingDensitySelect.addEventListener("change", () => {
      patchSettings({ appearance: { density: elements.settingDensitySelect.value } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingLoadingAnimationSelect.addEventListener("change", () => {
      patchSettings({ appearance: { loadingAnimation: elements.settingLoadingAnimationSelect.value } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingAccentMenuButton.addEventListener("click", () => {
      if (isAccentPopoverOpen()) closeAccentPopover();
      else openAccentPopover();
    });
    for (const button of accentSwatchButtons()) {
      button.addEventListener("click", () => previewAccentColor(button.dataset.accentColor));
    }
    elements.settingAccentPreviewButton.addEventListener("click", () => previewAccentColor(elements.settingAccentColorInput.value));
    elements.settingAccentCancelButton.addEventListener("click", () => closeAccentPopover());
    elements.settingAccentApplyButton.addEventListener("click", saveAccentColor);
    elements.settingAccentColorInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      previewAccentColor(elements.settingAccentColorInput.value);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!isAccentPopoverOpen()) return;
      const target = event.target instanceof Node ? event.target : undefined;
      if (target && elements.settingAccentPopover.contains(target)) return;
      if (target && elements.settingAccentMenuButton.contains(target)) return;
      closeAccentPopover({ restorePreview: true, focusButton: false });
    });

    elements.settingQueueModeSelect.addEventListener("change", () => {
      patchSettings({ composer: { queueMode: elements.settingQueueModeSelect.value } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingComposerExpandedCheckbox.addEventListener("change", () => {
      patchSettings({ composer: { expanded: elements.settingComposerExpandedCheckbox.checked } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingDefaultBucketColorSelect.addEventListener("change", () => {
      patchSettings({ defaults: { sessionBucketColor: elements.settingDefaultBucketColorSelect.value || null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingSaveModelDefaultsButton.addEventListener("click", () => {
      const model = splitModelKey(state.currentModelKey);
      if (!model) {
        setSettingsStatus("No current model to save", true);
        return;
      }
      patchSettings({ defaults: { model, thinkingLevel: state.currentThinkingLevel || null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingClearModelDefaultsButton.addEventListener("click", () => {
      patchSettings({ defaults: { model: null, thinkingLevel: null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });
    elements.extensionReloadButton.addEventListener("click", () => {
      void reloadExtensions();
    });
    elements.settingsButton.addEventListener("click", () => setPanelScope("preferences"));
    new MutationObserver(updateSystemStatus).observe(elements.connectionStatusEl, { attributes: true, attributeFilter: ["class", "hidden"] });
    updateSystemStatus();
    void refreshExtensionStatus().catch(renderExtensionStatusError);
    runNotifications.init();
  }

  function applyWebSettingsSchemas(schemas: WebSettingsSchema[]) {
    state.webSettingsSchemas = Array.isArray(schemas) ? schemas : [];
    updateExtensionSearchTerms();
    extSettings?.render();
  }

  return { init, refreshSettings, applySettings, applyWebSettingsSchemas };
}
