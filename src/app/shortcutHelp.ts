import { iconElement } from "./icons.js";
import type { Shortcut } from "./shortcuts.js";

export type ShortcutHelpController = {
  isOpen: () => boolean;
  toggle: () => void;
};

function usesCommandKey() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

const namedKeys: Record<string, string> = {
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  enter: "Enter",
  escape: "Esc",
};

function shortcutKeys(shortcut: Shortcut) {
  const keys: string[] = [];
  if (shortcut.mod) keys.push(usesCommandKey() ? "⌘" : "Ctrl");
  if (shortcut.alt) keys.push(usesCommandKey() ? "⌥" : "Alt");
  if (shortcut.shift) keys.push(usesCommandKey() ? "⇧" : "Shift");
  keys.push(namedKeys[shortcut.key.toLowerCase()] || shortcut.key.toUpperCase());
  return keys;
}

export function createShortcutHelp(shortcuts: Shortcut[]): ShortcutHelpController {
  const dialog = document.createElement("dialog");
  dialog.className = "shortcutHelp";
  dialog.setAttribute("aria-labelledby", "shortcutHelpTitle");

  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.id = "shortcutHelpTitle";
  title.textContent = "Keyboard shortcuts";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "shortcutHelpClose";
  closeButton.title = "Close keyboard shortcuts";
  closeButton.setAttribute("aria-label", closeButton.title);
  closeButton.append(iconElement("x"));
  header.append(title, closeButton);

  const list = document.createElement("div");
  list.className = "shortcutHelpList";
  for (const shortcut of shortcuts) {
    if (!shortcut.description) continue;
    const row = document.createElement("div");
    row.className = "shortcutHelpRow";
    const label = document.createElement("span");
    label.textContent = shortcut.description;
    const keys = document.createElement("span");
    keys.className = "shortcutHelpKeys";
    keys.setAttribute("aria-label", shortcutKeys(shortcut).join(" plus "));
    for (const key of shortcutKeys(shortcut)) {
      const keycap = document.createElement("kbd");
      keycap.textContent = key;
      keys.append(keycap);
    }
    row.append(label, keys);
    list.append(row);
  }

  dialog.append(header, list);
  document.body.append(dialog);

  let restoreFocus: HTMLElement | null = null;
  const close = () => dialog.close();
  const open = () => {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    closeButton.focus();
  };

  closeButton.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    const target = restoreFocus;
    restoreFocus = null;
    requestAnimationFrame(() => target?.focus());
  });

  return {
    isOpen: () => dialog.open,
    toggle: () => dialog.open ? close() : open(),
  };
}
