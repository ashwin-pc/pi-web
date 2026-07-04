import type { ApiClient } from "../app/api.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppElements } from "../app/elements.js";
import { setIcon } from "../app/icons.js";
import { defaultAccentColor, defaultLoadingAnimation, defaultPiWebSettings, normalizeMarkerColor, sessionMarkerColors, type AppState, type LoadingAnimation, type PiWebModelSetting, type PiWebSettings } from "../app/types.js";
import { createQrSvg } from "../token/qr.js";
import { createTokenShareUrl } from "../token/tokenShare.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";

export type SettingsController = {
  init: () => void;
  refreshSettings: () => Promise<void>;
  applySettings: (settings: PiWebSettings) => void;
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
  if (appearance?.density === "compact" || appearance?.density === "comfortable") settings.appearance.density = appearance.density;
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

function populateBucketColorSelect(select: HTMLSelectElement) {
  if (select.options.length > 0) return;
  select.append(new Option("No default bucket", ""));
  for (const color of sessionMarkerColors) select.append(new Option(color.label, color.id));
}

export function createSettings(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): SettingsController {
  const { state, elements, api, rightPanels, addMessage } = options;
  const expandedStorageKey = "pi-web-composer-expanded";
  let hasAppliedSettings = false;
  let settingsPanelHandle: RightPanelHandle | undefined;

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

    updateQueueToggle();
    updateExpandedComposer();
  }

  function setSettingsStatus(message: string, isError = false) {
    elements.settingsStatusEl.textContent = message;
    elements.settingsStatusEl.classList.toggle("error", isError);
  }

  function tokenShareUrl() {
    const token = state.token.trim();
    return token ? createTokenShareUrl(token) : "";
  }

  function renderQr(container: HTMLElement, shareUrl: string, label: string) {
    container.replaceChildren();
    try {
      container.append(createQrSvg(shareUrl, label));
    } catch (error) {
      const message = document.createElement("p");
      message.className = "settingsHint";
      message.textContent = error instanceof Error ? error.message : String(error);
      container.append(message);
    }
  }

  function setTokenShareGenerated(generated: boolean) {
    elements.tokenShareQr.hidden = !generated;
    elements.tokenShareUrl.hidden = !generated;
  }

  function renderTokenShare() {
    const shareUrl = tokenShareUrl();
    if (!shareUrl) {
      elements.tokenShareSection.hidden = true;
      elements.tokenShareQr.replaceChildren();
      elements.tokenShareUrl.value = "";
      setTokenShareGenerated(false);
      return;
    }
    elements.tokenShareSection.hidden = false;
    elements.tokenShareUrl.value = shareUrl;
    elements.tokenShareQr.replaceChildren();
    renderQr(elements.tokenShareQr, shareUrl, "pi web token link QR code");
    setTokenShareGenerated(true);
  }

  function openTokenShareFullscreen() {
    const shareUrl = tokenShareUrl();
    if (!shareUrl) return;

    renderQr(elements.tokenShareFullscreenQr, shareUrl, "Full-screen pi web token link QR code");
    elements.tokenShareFullscreen.hidden = false;
    elements.tokenShareFullscreenCloseButton.focus();
    elements.tokenShareFullscreen.requestFullscreen?.().catch(() => undefined);
  }

  function closeTokenShareFullscreen(focusButton = true) {
    if (elements.tokenShareFullscreen.hidden) return;
    const shouldExitNativeFullscreen = document.fullscreenElement === elements.tokenShareFullscreen;
    elements.tokenShareFullscreen.hidden = true;
    elements.tokenShareFullscreenQr.replaceChildren();
    if (shouldExitNativeFullscreen) document.exitFullscreen().catch(() => undefined);
    if (focusButton && !elements.settingsPanel.hidden) elements.tokenShareFullscreenButton.focus();
  }

  async function copyText(value: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const input = document.createElement("input");
    input.value = value;
    input.readOnly = true;
    input.setAttribute("aria-hidden", "true");
    input.style.position = "fixed";
    input.style.left = "-1000px";
    input.style.top = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }

  async function copyTokenShareUrl() {
    const value = tokenShareUrl();
    if (!value) return;
    await copyText(value);
    setSettingsStatus("Copied token link");
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
    applySettings(data.settings);
  }

  function prepareOpenSettings() {
    const hasToken = !!state.token.trim();
    elements.tokenShareSection.hidden = !hasToken;
    elements.tokenShareQr.replaceChildren();
    elements.tokenShareUrl.value = "";
    setTokenShareGenerated(false);
    setSettingsStatus("");
  }

  function afterOpenSettings() {
    elements.settingsCloseButton.focus();
  }

  function prepareCloseSettings() {
    closeAccentPopover({ restorePreview: true, focusButton: false });
    closeTokenShareFullscreen(false);
  }

  function openSettings() {
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
    elements.settingsButton.focus();
  }

  function init() {
    populateBucketColorSelect(elements.settingDefaultBucketColorSelect);
    applySettings(state.settings);

    settingsPanelHandle = rightPanels?.register({
      id: "settings",
      side: "right",
      panel: elements.settingsPanel,
      trigger: elements.settingsButton,
      backdrop: elements.settingsBackdrop,
      closeButton: elements.settingsCloseButton,
      width: "380px",
      minWidth: 320,
      maxWidth: 560,
      closeOnEscape: false,
      onBeforeOpen: prepareOpenSettings,
      onOpen: afterOpenSettings,
      onBeforeClose: prepareCloseSettings,
      focusOnClose: elements.settingsButton,
    });
    if (!settingsPanelHandle) elements.settingsButton.addEventListener("click", openSettings);
    elements.tokenShareFullscreenButton.addEventListener("click", () => {
      renderTokenShare();
      if (!elements.tokenShareUrl.value) return;
      openTokenShareFullscreen();
    });
    elements.tokenShareFullscreenCloseButton.addEventListener("click", () => closeTokenShareFullscreen());
    elements.tokenShareFullscreen.addEventListener("click", (event) => {
      if (event.target === elements.tokenShareFullscreen) closeTokenShareFullscreen();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !elements.tokenShareFullscreen.hidden) closeTokenShareFullscreen(false);
    });
    elements.tokenShareCopyButton.addEventListener("click", () => {
      copyTokenShareUrl().catch((error) => setSettingsStatus(error instanceof Error ? error.message : String(error), true));
    });
    if (!settingsPanelHandle) {
      elements.settingsCloseButton.addEventListener("click", closeSettings);
      elements.settingsBackdrop.addEventListener("click", closeSettings);
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!elements.tokenShareFullscreen.hidden) {
        closeTokenShareFullscreen();
        return;
      }
      if (isAccentPopoverOpen()) {
        closeAccentPopover();
        return;
      }
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
  }

  return { init, refreshSettings, applySettings };
}
