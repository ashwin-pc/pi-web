import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement } from "../app/icons.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppState } from "../app/types.js";
import { bindCompactInactiveAction } from "../composer/compactInteractions.js";

export type ModelSettings = {
  init: () => void;
  updateSummary: () => void;
  updateThinkingOptions: (levels?: string[]) => void;
  populateModelSelect: (models: any[], activeKey: string) => void;
  refreshModels: () => Promise<void>;
};

export function modelKey(model: any): string {
  return model ? `${model.provider}/${model.id}` : "";
}

export function modelLabel(model: any): string {
  const name = model?.name && model.name !== model.id ? ` (${model.name})` : "";
  return `${model.provider}/${model.id}${name}`;
}

const offThinkingLevels = new Set(["", "off", "none", "disabled", "false", "no", "0"]);

function normalizeThinkingLevel(level: string | undefined | null) {
  return String(level || "").trim().toLowerCase();
}

function isOffThinkingLevel(level: string | undefined | null) {
  return offThinkingLevels.has(normalizeThinkingLevel(level));
}

export function thinkingLevelFill(level: string | undefined | null, levels: string[]) {
  const normalizedLevel = normalizeThinkingLevel(level);
  if (isOffThinkingLevel(normalizedLevel)) return 0;

  const activeLevels = levels
    .map(normalizeThinkingLevel)
    .filter((value, index, values) => value && !isOffThinkingLevel(value) && values.indexOf(value) === index);

  if (!activeLevels.length) return 1;
  const levelIndex = activeLevels.indexOf(normalizedLevel);
  if (levelIndex === -1) return 1;
  return (levelIndex + 1) / activeLevels.length;
}

function thinkingOptionsFromSelect(select: HTMLSelectElement) {
  return Array.from(select.options || [])
    .map((option) => (option.value || option.textContent || "").trim())
    .filter(Boolean);
}

function createThinkingIcon() {
  const icon = document.createElement("span");
  icon.className = "modelSettingsThinkingIcon";

  const baseIcon = iconElement("brain");
  baseIcon.setAttribute("class", "modelSettingsThinkingIconBase");

  const fill = document.createElement("span");
  fill.className = "modelSettingsThinkingIconFill";
  fill.append(iconElement("brain"));

  icon.append(baseIcon, fill);
  return icon;
}

export function createModelSettings(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  updateMeta: (data: any) => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): ModelSettings {
  const { state, elements, api, updateMeta, addMessage } = options;

  function updateSummary() {
    const level = elements.thinkingSelectEl.value || state.currentThinkingLevel || "off";
    const selectedModelLabel = elements.modelSelectEl.selectedOptions[0]?.textContent?.trim();
    const label = state.currentModelDisplay || selectedModelLabel || state.currentModelKey || "";
    elements.modelSettingsLabel.textContent = label;
    const fill = thinkingLevelFill(level, thinkingOptionsFromSelect(elements.thinkingSelectEl));
    elements.modelSettingsThinking.textContent = "";
    elements.modelSettingsThinking.style.setProperty("--thinking-fill", `${Math.round(fill * 100)}%`);
    const thinkingText = document.createElement("span");
    thinkingText.className = "modelSettingsThinkingText";
    thinkingText.textContent = level;
    elements.modelSettingsThinking.append(createThinkingIcon(), thinkingText);
    elements.modelSettingsThinking.dataset.thinkingLevel = level;
    elements.modelSettingsThinking.dataset.thinkingActive = fill > 0 ? "true" : "false";
    elements.modelSettingsButton.dataset.thinkingLevel = level;
    elements.modelSettingsButton.title = `${label} · reasoning: ${level}`;
    elements.modelSettingsButton.setAttribute("aria-label", `Model and reasoning settings: ${label}, reasoning ${level}`);
  }

  function setModelSettingsOpen(open: boolean) {
    if (open) blurActiveEditableOnMobile();
    elements.modelSettingsPopover.hidden = !open;
    elements.modelSettingsButton.setAttribute("aria-expanded", String(open));
  }

  function updateThinkingOptions(levels: string[] = [state.currentThinkingLevel]) {
    const options = levels.length ? levels : [state.currentThinkingLevel];
    elements.thinkingSelectEl.textContent = "";
    for (const level of options) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      elements.thinkingSelectEl.append(option);
    }
    elements.thinkingSelectEl.value = options.includes(state.currentThinkingLevel) ? state.currentThinkingLevel : options[0] || "off";
    updateSummary();
  }

  function populateModelSelect(models: any[], activeKey: string) {
    elements.modelSelectEl.textContent = "";
    for (const model of models) {
      if (!model) continue;
      const option = document.createElement("option");
      option.value = modelKey(model);
      option.textContent = modelLabel(model);
      elements.modelSelectEl.append(option);
    }
    elements.modelSelectEl.value = activeKey;
    if (!elements.modelSelectEl.value && activeKey) {
      const option = document.createElement("option");
      option.value = activeKey;
      option.textContent = activeKey;
      elements.modelSelectEl.prepend(option);
      elements.modelSelectEl.value = activeKey;
    }
  }

  async function refreshModels() {
    const query = state.currentSessionId ? `?sessionId=${encodeURIComponent(state.currentSessionId)}` : "";
    const res = await fetch(`/api/models${query}`, { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    updateMeta({ cwd: data.cwd || "", model: data.current, thinkingLevel: data.thinkingLevel });
    populateModelSelect(data.models || [], state.currentModelKey);
    updateThinkingOptions(data.thinkingLevels || [state.currentThinkingLevel]);
  }

  async function setModelFromControls() {
    const [provider, ...idParts] = elements.modelSelectEl.value.split("/");
    const id = idParts.join("/");
    if (!provider || !id) return;

    elements.modelSelectEl.disabled = true;
    elements.thinkingSelectEl.disabled = true;
    elements.modelSettingsButton.disabled = true;
    try {
      const res = await fetch("/api/model", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId, provider, id, thinkingLevel: elements.thinkingSelectEl.value }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      updateMeta(data);
      updateThinkingOptions(data.thinkingLevels || [data.thinkingLevel]);
      await refreshModels();
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
      await refreshModels().catch(() => undefined);
    } finally {
      elements.modelSelectEl.disabled = false;
      elements.thinkingSelectEl.disabled = false;
      elements.modelSettingsButton.disabled = false;
    }
  }

  function init() {
    const consumeCompactSettingsClick = bindCompactInactiveAction(elements.modelSettingsButton, elements.formEl, () => {
      setModelSettingsOpen(elements.modelSettingsPopover.hidden);
    }, { stopPropagation: true });
    elements.modelSettingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (consumeCompactSettingsClick(event)) return;
      setModelSettingsOpen(elements.modelSettingsPopover.hidden);
    });
    elements.modelSettingsPopover.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("pointerdown", (event) => {
      if (!elements.modelSettingsPopover.hidden && !elements.modelControl.contains(event.target as Node)) setModelSettingsOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.modelSettingsPopover.hidden) setModelSettingsOpen(false);
    });
    elements.modelSelectEl.addEventListener("change", () => {
      const selected = elements.modelSelectEl.selectedOptions[0]?.textContent;
      if (selected) state.currentModelDisplay = selected;
      updateSummary();
      setModelFromControls();
    });
    elements.thinkingSelectEl.addEventListener("change", () => {
      state.currentThinkingLevel = elements.thinkingSelectEl.value;
      updateSummary();
      setModelFromControls();
    });
  }

  return {
    init,
    updateSummary,
    updateThinkingOptions,
    populateModelSelect,
    refreshModels,
  };
}
