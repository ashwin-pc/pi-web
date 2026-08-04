export type ShortcutScope = string;

export type ShortcutContext = {
  event: KeyboardEvent;
  activeScopes: ShortcutScope[];
  scope: ShortcutScope;
};

export type Shortcut = {
  id: string;
  key: string;
  description?: string;
  scope?: ShortcutScope;
  scopes?: ShortcutScope[];
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  allowInEditable?: boolean;
  repeat?: boolean;
  when?: (context: ShortcutContext) => boolean;
  run: (event: KeyboardEvent, context: ShortcutContext) => void | Promise<void>;
};

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, select, [contenteditable]");
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    const type = editable.type.toLowerCase();
    return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return true;
}

function matchesShortcut(shortcut: Shortcut, event: KeyboardEvent) {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (Boolean(shortcut.mod) !== (event.metaKey || event.ctrlKey)) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (Boolean(shortcut.alt) !== event.altKey) return false;
  return true;
}

function shortcutScopes(shortcut: Shortcut) {
  return shortcut.scopes || [shortcut.scope || "global"];
}

function activeShortcutScopes(scopes: ShortcutScope[] = []) {
  const result = scopes.filter(Boolean);
  if (!result.includes("global")) result.push("global");
  return result;
}

export function initKeyboardShortcuts(shortcuts: Shortcut[], options: {
  getScopes?: (event: KeyboardEvent) => ShortcutScope[];
  onError?: (error: unknown) => void;
} = {}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;

    const inEditable = isEditableTarget(event.target);
    const activeScopes = activeShortcutScopes(options.getScopes?.(event));
    for (const scope of activeScopes) {
      for (const shortcut of shortcuts) {
        if (!shortcutScopes(shortcut).includes(scope)) continue;
        if (!matchesShortcut(shortcut, event)) continue;
        if (event.repeat && !shortcut.repeat) continue;
        if (inEditable && !shortcut.allowInEditable) continue;

        const context = { event, activeScopes, scope };
        if (shortcut.when && !shortcut.when(context)) continue;

        event.preventDefault();
        void Promise.resolve(shortcut.run(event, context)).catch((error) => options.onError?.(error));
        return;
      }
    }
  };

  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
