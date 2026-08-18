import type { AppElements } from "./elements.js";
import { iconElement, isIconName, type IconName } from "./icons.js";

type LauncherAction = {
  label: string;
  icon: IconName;
  run: () => void;
};

type ExtensionLauncherAction = {
  key: string;
  label: string;
  icon: IconName;
  opens: string;
};

/** FAB entries are explicit launcher registrations; each must reference a panel. */
function normalizeExtensionActions(value: unknown): ExtensionLauncherAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw): ExtensionLauncherAction[] => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const opens = typeof entry.opens === "string" ? entry.opens.trim() : "";
    if (!key || !opens || seen.has(key)) return [];
    seen.add(key);
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : key;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : title;
    const icon = typeof entry.icon === "string" && isIconName(entry.icon) ? entry.icon : "square-pen";
    return [{ key, label, icon, opens }];
  });
}

export type ActionLauncherController = {
  setExtensionActions(value: unknown): void;
};

export function initActionLauncher(
  elements: AppElements,
  options: { onSessionDetails?: () => void; onExtensionAction?: (opensPanelKey: string) => void } = {},
): ActionLauncherController {
  const root = document.createElement("div");
  root.className = "actionLauncher";

  const menu = document.createElement("div");
  menu.className = "actionLauncherMenu";
  menu.id = "actionLauncherMenu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const builtInActions: LauncherAction[] = [
    { label: "Session details", icon: "info", run: () => options.onSessionDetails?.() },
    { label: "Git", icon: "git-branch", run: () => elements.gitButton.click() },
    { label: "File explorer", icon: "folder-tree", run: () => elements.filesButton.click() },
    { label: "Conversation tree", icon: "git-fork", run: () => elements.conversationTreeButton.click() },
    { label: "New session", icon: "square-pen", run: () => elements.newSessionHeaderButton.click() },
  ];
  let extensionActions: ExtensionLauncherAction[] = [];
  let menuHideTimer: number | undefined;

  function setOpen(open: boolean) {
    if (menuHideTimer !== undefined) window.clearTimeout(menuHideTimer);
    if (open) {
      menu.hidden = false;
      // Start from the collapsed styles even when reopening shortly after close.
      requestAnimationFrame(() => root.classList.add("open"));
    } else {
      root.classList.remove("open");
      // Keep the menu rendered until the fan-in transition completes.
      menuHideTimer = window.setTimeout(() => {
        menu.hidden = true;
        menuHideTimer = undefined;
      }, 420);
    }
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close session actions" : "Open session actions");
  }

  function renderActions() {
    menu.textContent = "";
    const measure = document.createElement("canvas").getContext("2d");
    if (measure) measure.font = "13px system-ui";
    const actions: LauncherAction[] = [
      ...builtInActions,
      ...extensionActions.map((action) => ({
        label: action.label,
        icon: action.icon,
        run: () => options.onExtensionAction?.(action.opens),
      })),
    ].map((action, index) => ({ action, index, width: measure?.measureText(action.label).width || action.label.length }))
      .sort((a, b) => a.width - b.width || a.index - b.index)
      .map(({ action }) => action);
    const lastIndex = Math.max(0, actions.length - 1);
    actions.forEach((action, index) => {
      const button = document.createElement("button");
      button.className = "actionLauncherItem";
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.title = action.label;
      button.append(iconElement(action.icon));
      const label = document.createElement("span");
      label.textContent = action.label;
      button.append(label);

      const fromBottom = lastIndex - index;
      const arc = lastIndex > 0 ? fromBottom / lastIndex : 0;
      const defaultX = [-5, -18, -36, -51, -59];
      const defaultY = [-254, -204, -154, -103, -52];
      const defaultFocusedY = [-202, -152, -102, -51, 0];
      const fanX = actions.length === 5 ? defaultX[index] : Math.round(-59 + 54 * arc);
      const fanY = actions.length === 5 ? defaultY[index] : Math.round(-52 - 50.5 * fromBottom);
      const focusedY = actions.length === 5 ? defaultFocusedY[index] : Math.round(-50.5 * fromBottom);
      button.style.setProperty("--fan-x", `${fanX}px`);
      button.style.setProperty("--fan-y", `${fanY}px`);
      button.style.setProperty("--fan-focused-y", `${focusedY}px`);
      button.style.setProperty("--fan-open-delay", `${(fromBottom * 0.035).toFixed(3)}s`);
      button.style.setProperty("--fan-close-delay", `${(index * 0.035).toFixed(3)}s`);

      // The launcher lives inside the form, so do not let an action take focus
      // and temporarily activate/expand the composer before opening its panel.
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        button.blur();
        elements.promptEl.blur();
        elements.formEl.classList.add("compactInactive");
        setOpen(false);
        action.run();
      });
      menu.append(button);
    });
  }

  const toggle = document.createElement("button");
  toggle.className = "actionLauncherToggle";
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Open session actions");
  toggle.setAttribute("aria-controls", menu.id);
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Session actions";
  const mascot = document.createElement("img");
  mascot.src = "/pi-mascot-avatar.png";
  mascot.alt = "";
  toggle.append(mascot);

  // Keep the launcher from putting the composer into its focus-within state.
  // Keyboard activation still works; focus is returned to the page after toggling.
  toggle.addEventListener("pointerdown", (event) => event.preventDefault());
  toggle.addEventListener("click", () => {
    setOpen(!root.classList.contains("open"));
    elements.promptEl.blur();
    elements.formEl.classList.add("compactInactive");
    toggle.blur();
  });
  elements.promptEl.addEventListener("focus", () => setOpen(false));
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("open")) {
      setOpen(false);
      toggle.focus();
    }
  });

  renderActions();
  root.append(menu, toggle);
  elements.formEl.append(root);

  return {
    setExtensionActions(value) {
      extensionActions = normalizeExtensionActions(value);
      renderActions();
    },
  };
}
