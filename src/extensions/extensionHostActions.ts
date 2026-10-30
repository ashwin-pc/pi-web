const COPY_STATUS_SELECTOR = "[data-web-copy-status]";
const SCROLL_FADE_SELECTOR = "[data-web-scroll-fade]";
const SCROLL_TOLERANCE = 1;
const COPY_STATUS_DURATION_MS = 2_000;

type ScrollFadeState = "none" | "left" | "right" | "both";

type CopyStatusSnapshot = {
  text: string;
  hidden: boolean;
  timer?: number;
};

export type ExtensionHostActions = {
  refresh(): void;
};

const controllers = new WeakMap<HTMLElement, ExtensionHostActions>();
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

function fadeState(element: HTMLElement): ScrollFadeState {
  if (element.scrollWidth <= element.clientWidth + SCROLL_TOLERANCE) return "none";
  const atStart = element.scrollLeft <= SCROLL_TOLERANCE;
  const atEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - SCROLL_TOLERANCE;
  if (atStart) return "right";
  if (atEnd) return "left";
  return "both";
}

function fadeMask(state: ScrollFadeState) {
  switch (state) {
    case "right":
      return "linear-gradient(to right, #000 0, #000 calc(100% - 14px), transparent 100%)";
    case "left":
      return "linear-gradient(to right, transparent 0, #000 14px, #000 100%)";
    case "both":
      return "linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%)";
    default:
      return "none";
  }
}

function updateScrollFade(element: HTMLElement) {
  const state = fadeState(element);
  const mask = fadeMask(state);
  element.dataset.webScrollFadeState = state;
  element.style.maskImage = mask;
  element.style.setProperty("-webkit-mask-image", mask);
}

function scrollFadeTarget(root: HTMLElement, event: Event) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>(SCROLL_FADE_SELECTOR)
    : null;
  return target && root.contains(target) ? target : null;
}

/**
 * Installs the host-owned declarative behavior available to sanitized
 * extension HTML. Calls are idempotent for a given stable surface root.
 */
export function extensionHostActions(root: HTMLElement): ExtensionHostActions {
  const existing = controllers.get(root);
  if (existing) return existing;

  let observedFades = new Set<HTMLElement>();
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement && entry.target.matches(SCROLL_FADE_SELECTOR)) {
          updateScrollFade(entry.target);
        }
      }
    });

  const controller: ExtensionHostActions = {
    refresh() {
      const nextFades = new Set(root.querySelectorAll<HTMLElement>(SCROLL_FADE_SELECTOR));
      for (const element of observedFades) {
        if (!nextFades.has(element)) resizeObserver?.unobserve(element);
      }
      for (const element of nextFades) {
        updateScrollFade(element);
        if (!observedFades.has(element)) resizeObserver?.observe(element);
      }
      observedFades = nextFades;
    },
  };

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

  root.addEventListener("scroll", (event) => {
    const target = scrollFadeTarget(root, event);
    if (target) updateScrollFade(target);
  }, true);
  root.addEventListener("pointerover", (event) => {
    const target = scrollFadeTarget(root, event);
    if (target) updateScrollFade(target);
  });
  root.addEventListener("focusin", (event) => {
    const target = scrollFadeTarget(root, event);
    if (target) updateScrollFade(target);
  });

  controllers.set(root, controller);
  controller.refresh();
  return controller;
}
