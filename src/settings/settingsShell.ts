import { iconElement, isIconName } from "../app/icons.js";

type SettingsShellElements = {
  panel: HTMLElement;
  navigation: HTMLElement;
  content: HTMLElement;
  searchInput: HTMLInputElement;
  searchEmpty: HTMLElement;
  backButton: HTMLButtonElement;
  mobileTitle: HTMLElement;
};

export type SettingsShellController = {
  init: () => void;
  prepareOpen: () => void;
  prepareClose: () => void;
  handleEscape: () => boolean;
  selectPage: (pageId: string, focus?: boolean) => void;
  setSummary: (pageId: string, summary: string) => void;
  setBadge: (pageId: string, label?: string, tone?: "neutral" | "ready" | "warning" | "danger") => void;
  setSearchTerms: (pageId: string, terms: string[]) => void;
};

type PageEntry = {
  id: string;
  title: string;
  button: HTMLButtonElement;
  page: HTMLElement;
};

const mobileSettingsQuery = "(max-width: 640px)";

function requiredWithin<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required settings node: ${selector}`);
  return element;
}

function normalizedSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function pageTitle(button: HTMLButtonElement): string {
  return button.querySelector<HTMLElement>(".settingsNavTitle")?.textContent?.trim() || button.textContent?.trim() || "Settings";
}

export function createSettingsShell(panel: HTMLElement): SettingsShellController {
  const elements: SettingsShellElements = {
    panel,
    navigation: requiredWithin(panel, "#settingsNavigation"),
    content: requiredWithin(panel, "#settingsContent"),
    searchInput: requiredWithin(panel, "#settingsSearchInput"),
    searchEmpty: requiredWithin(panel, "#settingsSearchEmpty"),
    backButton: requiredWithin(panel, "#settingsBackButton"),
    mobileTitle: requiredWithin(panel, "#settingsMobileTitle"),
  };
  const mobile = window.matchMedia(mobileSettingsQuery);
  const entries = Array.from(panel.querySelectorAll<HTMLButtonElement>("[data-settings-page-target]")).map((button): PageEntry => {
    const id = button.dataset.settingsPageTarget;
    if (!id) throw new Error("Settings navigation button is missing data-settings-page-target");
    const page = requiredWithin<HTMLElement>(panel, `[data-settings-page="${CSS.escape(id)}"]`);
    return { id, title: pageTitle(button), button, page };
  });
  if (entries.length === 0) throw new Error("Settings must contain at least one destination");

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let selectedId = entries.find((entry) => entry.button.getAttribute("aria-current") === "page")?.id || entries[0].id;
  let showingMobileDetail = false;

  function updateMobilePresentation() {
    const showBack = mobile.matches && showingMobileDetail;
    elements.panel.classList.toggle("settingsShowingDetail", showBack);
    elements.backButton.hidden = !showBack;
    elements.mobileTitle.textContent = showBack ? entriesById.get(selectedId)?.title || "Settings" : "Settings";
  }

  function applySelection(pageId: string, focus = false) {
    const selected = entriesById.get(pageId);
    if (!selected) return;
    selectedId = pageId;
    for (const entry of entries) {
      const active = entry.id === pageId;
      entry.button.classList.toggle("active", active);
      if (active) entry.button.setAttribute("aria-current", "page");
      else entry.button.removeAttribute("aria-current");
      entry.page.hidden = !active;
    }
    showingMobileDetail = mobile.matches;
    updateMobilePresentation();
    elements.content.scrollTop = 0;
    if (focus) {
      const focusTarget = mobile.matches ? elements.mobileTitle : selected.page.querySelector<HTMLElement>(".settingsPageTitle");
      focusTarget?.focus({ preventScroll: true });
    }
  }

  function showNavigation(focus: boolean) {
    showingMobileDetail = false;
    updateMobilePresentation();
    if (focus) entriesById.get(selectedId)?.button.focus({ preventScroll: true });
  }

  function filterNavigation() {
    const query = normalizedSearchText(elements.searchInput.value);
    let visibleCount = 0;
    for (const entry of entries) {
      const dynamicTerms = entry.button.dataset.settingsDynamicSearch || "";
      const searchText = normalizedSearchText(`${entry.button.dataset.settingsSearch || ""} ${dynamicTerms} ${entry.button.textContent || ""}`);
      const visible = !query || searchText.includes(query);
      entry.button.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    for (const group of panel.querySelectorAll<HTMLElement>("[data-settings-nav-group]")) {
      group.hidden = !Array.from(group.querySelectorAll<HTMLButtonElement>("[data-settings-page-target]")).some((button) => !button.hidden);
    }
    elements.searchEmpty.hidden = visibleCount > 0;
  }

  function moveSearchSelection(direction: 1 | -1) {
    const visible = entries.map((entry) => entry.button).filter((button) => !button.hidden);
    if (visible.length === 0) return;
    const activeIndex = visible.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = activeIndex < 0
      ? direction === 1 ? 0 : visible.length - 1
      : (activeIndex + direction + visible.length) % visible.length;
    visible[nextIndex].focus();
  }

  function init() {
    for (const host of panel.querySelectorAll<HTMLElement>("[data-settings-icon]")) {
      const name = host.dataset.settingsIcon;
      if (name && isIconName(name)) host.replaceChildren(iconElement(name));
    }
    for (const entry of entries) entry.button.addEventListener("click", () => applySelection(entry.id, true));
    elements.backButton.addEventListener("click", () => showNavigation(true));
    elements.searchInput.addEventListener("input", filterNavigation);
    elements.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSearchSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key !== "Enter") return;
      const first = entries.find((entry) => !entry.button.hidden);
      if (!first) return;
      event.preventDefault();
      applySelection(first.id, true);
    });
    elements.navigation.addEventListener("keydown", (event) => {
      if (event.target === elements.searchInput || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      event.preventDefault();
      moveSearchSelection(event.key === "ArrowDown" ? 1 : -1);
    });
    mobile.addEventListener("change", () => {
      if (!mobile.matches) showingMobileDetail = false;
      updateMobilePresentation();
    });
    applySelection(selectedId, false);
    if (mobile.matches) showNavigation(false);
    filterNavigation();
  }

  function prepareOpen() {
    elements.searchInput.value = "";
    filterNavigation();
    if (mobile.matches) showNavigation(false);
    else applySelection(selectedId, false);
  }

  function prepareClose() {
    showNavigation(false);
  }

  function handleEscape() {
    if (!mobile.matches || !showingMobileDetail) return false;
    showNavigation(true);
    return true;
  }

  function setSummary(pageId: string, summary: string) {
    const summaryElement = entriesById.get(pageId)?.button.querySelector<HTMLElement>(".settingsNavSummary");
    if (summaryElement) summaryElement.textContent = summary;
  }

  function setBadge(pageId: string, label?: string, tone: "neutral" | "ready" | "warning" | "danger" = "neutral") {
    const badge = entriesById.get(pageId)?.button.querySelector<HTMLElement>(".settingsNavBadge");
    if (!badge) return;
    badge.hidden = !label;
    badge.textContent = label || "";
    badge.dataset.tone = tone;
  }

  function setSearchTerms(pageId: string, terms: string[]) {
    const button = entriesById.get(pageId)?.button;
    if (!button) return;
    button.dataset.settingsDynamicSearch = terms.join(" ");
    filterNavigation();
  }

  return {
    init,
    prepareOpen,
    prepareClose,
    handleEscape,
    selectPage: applySelection,
    setSummary,
    setBadge,
    setSearchTerms,
  };
}
