export type ToastAction = { label: string; run: () => void | Promise<void> };
export type Toast = {
  /** Stable identity: showing the same id replaces, rather than stacks, a notice. */
  id: string;
  message: string;
  tone?: "info" | "success" | "warning" | "error";
  actions?: readonly ToastAction[];
} & ({ persistent: true } | { persistent?: false; durationMs?: number });

export type ToastCenter = ReturnType<typeof createToastCenter>;

/** Host-owned notifications. Persistent notices can only be cleared by their owner. */
export function createToastCenter(host: HTMLElement) {
  const entries = new Map<string, { node: HTMLElement; timer?: number; events: AbortController; paused: boolean; pending: number; remaining: number; started: number }>();
  host.classList.add("toastCenter");
  host.hidden = true;
  host.setAttribute("aria-label", "Notifications");
  function dismiss(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    entry.events.abort();
    entry.node.remove();
    entries.delete(id);
    dismiss(`${id}:action-error`);
    host.hidden = entries.size === 0;
  }
  function show(toast: Toast) {
    const existing = entries.get(toast.id);
    if (existing) { window.clearTimeout(existing.timer); existing.events.abort(); }
    const node = existing?.node ?? document.createElement("section");
    node.className = `toast toast--${toast.tone ?? "info"}`;
    node.dataset.toastId = toast.id;
    // The live region contains prose only, not controls that would be re-announced.
    let message = node.querySelector<HTMLElement>(".toastMessage");
    if (!message) {
      message = document.createElement("div");
      message.className = "toastMessage";
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      message.setAttribute("aria-atomic", "true");
      node.append(message);
    }
    message.textContent = toast.message;
    const previousActions = node.querySelector<HTMLElement>(".toastActions");
    const labels = [...(toast.actions ?? []).map(action => action.label), ...(toast.persistent ? [] : ["Dismiss"])];
    const reuseActions = previousActions && [...previousActions.children].map(child => child.textContent).join("\n") === labels.join("\n");
    if (!reuseActions) previousActions?.remove();
    const actions = reuseActions ? previousActions : document.createElement("div");
    actions.className = "toastActions";
    const entry = { node, events: new AbortController(), paused: false, pending: 0, remaining: toast.persistent ? 0 : Math.max(1000, toast.durationMs ?? 6000), started: Date.now(), timer: undefined as number | undefined };
    entries.set(toast.id, entry);
    const schedule = () => {
      if (entries.get(toast.id) !== entry) return;
      window.clearTimeout(entry.timer);
      if (!toast.persistent && entry.remaining && !entry.paused) {
        entry.started = Date.now();
        entry.timer = window.setTimeout(() => {
          if (entries.get(toast.id) === entry) dismiss(toast.id);
        }, entry.remaining);
      }
    };
    const pause = () => {
      if (toast.persistent || entry.paused) return;
      entry.paused = true;
      window.clearTimeout(entry.timer);
      entry.remaining = Math.max(1, entry.remaining - (Date.now() - entry.started));
    };
    const resume = () => {
      if (entry.pending || node.matches(":hover") || node.contains(document.activeElement)) return;
      entry.paused = false;
      schedule();
    };
    node.onmouseenter = pause;
    node.onmouseleave = resume;
    node.addEventListener("focusin", pause, { signal: entry.events.signal });
    node.addEventListener("focusout", () => queueMicrotask(resume), { signal: entry.events.signal });
    for (const [index, action] of (toast.actions ?? []).entries()) {
      const button = (reuseActions ? actions.children[index] : document.createElement("button")) as HTMLButtonElement;
      button.type = "button";
      button.textContent = action.label;
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      let pending = false;
      button.onclick = async () => {
        if (pending || entries.get(toast.id) !== entry) return;
        pending = true;
        entry.pending += 1;
        pause();
        // Native disabled buttons drop keyboard focus in some browsers.
        button.setAttribute("aria-disabled", "true");
        try {
          await action.run();
          if (entries.get(toast.id) === entry) dismiss(`${toast.id}:action-error`);
        } catch {
          if (entries.get(toast.id) === entry) show({ id: `${toast.id}:action-error`, message: `${action.label} failed. Please try again.`, tone: "error" });
        } finally {
          pending = false;
          entry.pending -= 1;
          if (entries.get(toast.id) === entry) {
            button.removeAttribute("aria-disabled");
            resume();
          }
        }
      };
      if (!reuseActions) actions.append(button);
    }
    if (!toast.persistent) {
      const close = (reuseActions ? actions.lastElementChild : document.createElement("button")) as HTMLButtonElement;
      close.type = "button";
      close.textContent = "Dismiss";
      close.onclick = () => dismiss(toast.id);
      if (!reuseActions) actions.append(close);
    }
    if (!reuseActions && actions.childElementCount) node.append(actions);
    if (!existing) host.append(node);
    host.hidden = false;
    if (node.contains(document.activeElement) || node.matches(":hover")) pause();
    schedule();
  }
  return { show, dismiss, has: (id: string) => entries.has(id), clear: () => { for (const id of entries.keys()) dismiss(id); } };
}
