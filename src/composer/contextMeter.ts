import type { AppElements } from "../app/elements.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppState, SessionStats } from "../app/types.js";

export type ContextMeterController = {
  init: () => void;
  update: (stats?: SessionStats | null) => void;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactNumber(value: unknown) {
  const n = finiteNumber(value);
  if (n === undefined) return "—";
  if (Math.abs(n) < 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) < 1_000_000) {
    const amount = n / 1000;
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)}k`;
  }
  const amount = n / 1_000_000;
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)}m`;
}

function fullNumber(value: unknown) {
  const n = finiteNumber(value);
  return n === undefined ? "unknown" : Math.round(n).toLocaleString();
}

function dollars(value: unknown) {
  const n = finiteNumber(value);
  return n === undefined ? "unknown" : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function contextPercent(stats?: SessionStats | null) {
  const usage = stats?.contextUsage;
  const explicit = finiteNumber(usage?.percent);
  if (explicit !== undefined) return explicit;
  const tokens = finiteNumber(usage?.tokens);
  const contextWindow = finiteNumber(usage?.contextWindow);
  if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined;
  return (tokens / contextWindow) * 100;
}

function contextTone(percent: number | undefined) {
  if (percent === undefined) return "unknown";
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warning";
  if (percent >= 50) return "active";
  return "normal";
}

const compactInactiveComposerSelector = ".composer.compactInactive:not(:focus-within):not(.expanded):has(textarea:placeholder-shown):not(:has(.attachments:not(:empty)))";

function contextTitle(stats?: SessionStats | null) {
  const usage = stats?.contextUsage;
  const percent = contextPercent(stats);
  if (!stats || percent === undefined || usage?.tokens === null) {
    return "Context usage unavailable until the next model response.";
  }

  const tokens = stats.tokens || {};
  return [
    `Context: ${fullNumber(usage?.tokens)} / ${fullNumber(usage?.contextWindow)} tokens (${Math.round(percent)}%)`,
    `Input: ${fullNumber(tokens.input)} · Output: ${fullNumber(tokens.output)}`,
    `Cache read: ${fullNumber(tokens.cacheRead)} · Cache write: ${fullNumber(tokens.cacheWrite)}`,
    `Cost: ${dollars(stats.cost)}`,
  ].join("\n");
}

function addStatRow(parent: HTMLElement, label: string, value: string) {
  const row = document.createElement("div");
  row.className = "contextMeterRow";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  parent.append(row);
}

export function createContextMeter(options: { state: AppState; elements: AppElements }): ContextMeterController {
  const { state, elements } = options;

  function closePopover() {
    elements.contextMeterPopoverEl.hidden = true;
    elements.contextMeterEl.setAttribute("aria-expanded", "false");
  }

  function renderPopover(stats?: SessionStats | null) {
    const percent = contextPercent(stats);
    const usage = stats?.contextUsage;
    const tokens = stats?.tokens || {};
    const popover = elements.contextMeterPopoverEl;
    popover.textContent = "";

    const title = document.createElement("div");
    title.className = "contextMeterPopoverTitle";
    title.textContent = "Context usage";
    popover.append(title);

    if (!stats || percent === undefined || usage?.tokens === null) {
      const empty = document.createElement("p");
      empty.className = "contextMeterEmpty";
      empty.textContent = "Usage will appear after the next model response.";
      popover.append(empty);
      return;
    }

    const summary = document.createElement("div");
    summary.className = "contextMeterSummary";
    summary.textContent = `${compactNumber(usage?.tokens)} / ${compactNumber(usage?.contextWindow)} tokens · ${Math.round(percent)}%`;
    popover.append(summary);

    addStatRow(popover, "Input", fullNumber(tokens.input));
    addStatRow(popover, "Output", fullNumber(tokens.output));
    addStatRow(popover, "Cache read", fullNumber(tokens.cacheRead));
    addStatRow(popover, "Cache write", fullNumber(tokens.cacheWrite));
    addStatRow(popover, "Cost", dollars(stats.cost));
  }

  function update(stats?: SessionStats | null) {
    state.stats = stats || undefined;
    const percent = contextPercent(stats);
    const clamped = Math.max(0, Math.min(100, percent ?? 0));
    const tone = contextTone(percent);
    const title = state.isCompacting ? "Compacting context…" : contextTitle(stats);
    const compactingClass = state.isCompacting ? " compacting" : "";

    elements.contextMeterEl.className = `contextMeter ${tone}${compactingClass}`;
    elements.contextMeterEl.style.setProperty("--context-percent", `${clamped}%`);
    elements.contextMeterEl.title = title;
    elements.contextMeterEl.setAttribute("aria-label", title.replace(/\n/g, ". "));
    elements.contextMeterLabelEl.textContent = state.isCompacting
      ? "compacting"
      : percent !== undefined && percent >= 80 ? `ctx ${Math.round(percent)}%` : "";
    renderPopover(stats);
  }

  function togglePopover() {
    const open = elements.contextMeterPopoverEl.hidden;
    if (open) blurActiveEditableOnMobile();
    renderPopover(state.stats);
    elements.contextMeterPopoverEl.hidden = !open;
    elements.contextMeterEl.setAttribute("aria-expanded", String(open));
  }

  function init() {
    let suppressNextClick = false;
    elements.contextMeterEl.addEventListener("pointerdown", (event) => {
      if (!elements.formEl.matches(compactInactiveComposerSelector)) return;
      event.preventDefault();
      suppressNextClick = true;
      togglePopover();
    });
    elements.contextMeterEl.addEventListener("click", (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      togglePopover();
    });
    document.addEventListener("click", (event) => {
      const target = event.target as Node | null;
      if (!target || elements.contextMeterEl.contains(target) || elements.contextMeterPopoverEl.contains(target)) return;
      closePopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePopover();
    });
    update(state.stats);
  }

  return { init, update };
}
