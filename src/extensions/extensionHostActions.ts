const COPY_STATUS_SELECTOR = "[data-web-copy-status]";
const COPY_STATUS_DURATION_MS = 2_000;

type CopyStatusSnapshot = {
  text: string;
  hidden: boolean;
  timer?: number;
};

const installedRoots = new WeakSet<HTMLElement>();
const copyStatuses = new WeakMap<HTMLElement, CopyStatusSnapshot>();

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the synchronous browser fallback.
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  document.body.append(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("Clipboard unavailable");
}

function showCopyStatus(target: HTMLElement, message: string) {
  const status = target.querySelector<HTMLElement>(COPY_STATUS_SELECTOR);
  if (!status) return;

  let snapshot = copyStatuses.get(status);
  if (!snapshot) {
    snapshot = { text: status.textContent || "", hidden: status.hidden };
    copyStatuses.set(status, snapshot);
  }
  if (snapshot.timer !== undefined) window.clearTimeout(snapshot.timer);

  status.hidden = false;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.textContent = message;
  snapshot.timer = window.setTimeout(() => {
    status.textContent = snapshot.text;
    status.hidden = snapshot.hidden;
    snapshot.timer = undefined;
  }, COPY_STATUS_DURATION_MS);
}

function copyTarget(root: HTMLElement, event: Event) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-web-copy]")
    : null;
  return target && root.contains(target) ? target : null;
}

function isNativeKeyboardControl(target: HTMLElement) {
  return target instanceof HTMLButtonElement
    || target instanceof HTMLInputElement
    || target instanceof HTMLSelectElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLAnchorElement && target.hasAttribute("href"));
}

/**
 * Installs the host-owned declarative behavior available to sanitized
 * extension HTML. Calls are idempotent for a given stable surface root.
 */
export function extensionHostActions(root: HTMLElement) {
  if (installedRoots.has(root)) return;

  root.addEventListener("click", (event) => {
    const target = copyTarget(root, event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void copyText(target.dataset.webCopy || "").then(
      () => showCopyStatus(target, "Copied"),
      () => showCopyStatus(target, "Copy failed"),
    );
  }, true);

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = copyTarget(root, event);
    if (!target || isNativeKeyboardControl(target)) return;
    event.preventDefault();
    event.stopPropagation();
    void copyText(target.dataset.webCopy || "").then(
      () => showCopyStatus(target, "Copied"),
      () => showCopyStatus(target, "Copy failed"),
    );
  }, true);

  installedRoots.add(root);
}
