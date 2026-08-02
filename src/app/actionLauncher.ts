import type { AppElements } from "./elements.js";
import { iconElement, type IconName } from "./icons.js";

type LauncherAction = {
  label: string;
  icon: IconName;
  target: HTMLButtonElement;
};

export function initActionLauncher(elements: AppElements) {
  const root = document.createElement("div");
  root.className = "actionLauncher";

  const menu = document.createElement("div");
  menu.className = "actionLauncherMenu";
  menu.id = "actionLauncherMenu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const actions: LauncherAction[] = [
    { label: "Git", icon: "git-branch", target: elements.gitButton },
    { label: "Settings", icon: "settings", target: elements.settingsButton },
    { label: "File explorer", icon: "folder-tree", target: elements.filesButton },
    { label: "Conversation tree", icon: "git-fork", target: elements.conversationTreeButton },
    { label: "New session", icon: "square-pen", target: elements.newSessionHeaderButton },
  ];

  for (const action of actions) {
    const button = document.createElement("button");
    button.className = "actionLauncherItem";
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.title = action.label;
    button.append(iconElement(action.icon));
    const label = document.createElement("span");
    label.textContent = action.label;
    button.append(label);
    // The launcher lives inside the form, so do not let an action take focus
    // and temporarily activate/expand the composer before opening its panel.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      button.blur();
      elements.promptEl.blur();
      elements.formEl.classList.add("compactInactive");
      setOpen(false);
      action.target.click();
    });
    menu.append(button);
  }

  const toggle = document.createElement("button");
  toggle.className = "actionLauncherToggle";
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Open app tools");
  toggle.setAttribute("aria-controls", menu.id);
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "App tools";
  const mascot = document.createElement("img");
  mascot.src = "/pi-mascot.png";
  mascot.alt = "";
  toggle.append(mascot);

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
    toggle.setAttribute("aria-label", open ? "Close app tools" : "Open app tools");
  }

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

  root.append(menu, toggle);
  elements.formEl.append(root);
}
