import { blurActiveEditableOnMobile } from "../app/focus.js";

export type AppPanelSide = "left" | "right";

export type AppPanelRegistration = {
  id: string;
  side?: AppPanelSide;
  panel: HTMLElement;
  trigger?: HTMLElement;
  backdrop?: HTMLElement;
  closeButton?: HTMLElement;
  width?: string;
  minWidth?: number;
  maxWidth?: number;
  activeClass?: string;
  closeOnEscape?: boolean;
  canCloseOnEscape?: () => boolean;
  onBeforeOpen?: () => void;
  onOpen?: () => void;
  onBeforeClose?: () => void;
  onClose?: () => void;
  focusOnOpen?: HTMLElement | (() => HTMLElement | undefined);
  focusOnClose?: HTMLElement | (() => HTMLElement | undefined);
};

export type AppPanelHandle = {
  id: string;
  side: AppPanelSide;
  open: () => void;
  close: (focusTrigger?: boolean) => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
};

export type AppPanelManager = {
  register: (registration: AppPanelRegistration) => AppPanelHandle;
  closeActive: () => void;
  activeId: (side?: AppPanelSide) => string | undefined;
  isOpen: (id: string) => boolean;
};

export type RightPanelRegistration = AppPanelRegistration;
export type RightPanelHandle = AppPanelHandle;
export type RightPanelManager = AppPanelManager;

type RegisteredPanel = AppPanelRegistration & {
  side: AppPanelSide;
  activeClass: string;
  currentWidth?: string;
  widthBeforeMaximize?: string;
  maximized?: boolean;
  resizeHandle: HTMLDivElement;
};

// Width determines whether panels share the screen. The visual viewport height
// shrinks when a software keyboard opens and must not turn a split pane into an overlay.
const paneModeQuery = "(min-width: 641px)";
const multiSideQuery = "(min-width: 1280px)";
const defaultMinWidth = 280;
const defaultMaxWidth = 980;
const minChatWidth = 360;
const maximizeDragThreshold = 0.78;
const closeDragThreshold = 0.18;
const dragEdgeThreshold = 48;

function resolveElement(value?: HTMLElement | (() => HTMLElement | undefined)) {
  return typeof value === "function" ? value() : value;
}

function focusElement(element?: HTMLElement) {
  if (!element || element.hidden) return;
  element.focus({ preventScroll: true });
}

function storageKey(id: string) {
  return `pi-web.layout.panel-width.${id}`;
}

function readStoredWidth(id: string) {
  try {
    const value = localStorage.getItem(storageKey(id));
    return value && /^\d+(?:\.\d+)?px$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeWidth(id: string, width: string) {
  try {
    localStorage.setItem(storageKey(id), width);
  } catch {
    // Ignore storage failures.
  }
}

function panelWidth(registration: RegisteredPanel) {
  return registration.currentWidth
    || readStoredWidth(registration.id)
    || registration.width
    || registration.panel.dataset.panelWidth
    || registration.panel.dataset.rightPanelWidth
    || getComputedStyle(registration.panel).getPropertyValue("--app-side-panel-width").trim()
    || (registration.side === "left" ? "360px" : "420px");
}

function oppositeSide(side: AppPanelSide): AppPanelSide {
  return side === "left" ? "right" : "left";
}

export function createAppPanelManager(): AppPanelManager {
  const registrations = new Map<string, RegisteredPanel>();
  const active: Partial<Record<AppPanelSide, RegisteredPanel>> = {};
  let lastOpenedSide: AppPanelSide | undefined;

  const paneMode = window.matchMedia(paneModeQuery);
  const multiSideMode = window.matchMedia(multiSideQuery);

  function setBodyPanelState(side: AppPanelSide, registration?: RegisteredPanel) {
    const className = side === "left" ? "appLeftPanelOpen" : "appRightPanelOpen";
    const dataName = side === "left" ? "leftPanel" : "rightPanel";
    const widthProperty = side === "left" ? "--app-side-left-active-width" : "--app-side-right-active-width";

    document.body.classList.toggle(className, Boolean(registration));
    if (registration) {
      document.body.dataset[dataName] = registration.id;
      document.body.style.setProperty(widthProperty, panelWidth(registration));
    } else {
      delete document.body.dataset[dataName];
      document.body.style.removeProperty(widthProperty);
    }
    document.body.classList.toggle("appPanelOpen", Boolean(active.left || active.right));
  }

  function setTriggerState(registration: RegisteredPanel, open: boolean) {
    registration.trigger?.classList.toggle(registration.activeClass, open);
    registration.trigger?.setAttribute("aria-expanded", String(open));
  }

  function setPanelMaximized(registration: RegisteredPanel, maximized: boolean) {
    if (registration.maximized === maximized) return;
    if (maximized) {
      const other = active[oppositeSide(registration.side)];
      if (other?.maximized) setPanelMaximized(other, false);
      registration.widthBeforeMaximize = registration.currentWidth || panelWidth(registration);
    }
    registration.maximized = maximized;
    registration.panel.classList.toggle("appSidePanel--maximized", maximized);
    document.body.classList.toggle(registration.side === "left" ? "appLeftPanelMaximized" : "appRightPanelMaximized", maximized);
  }

  function togglePanelMaximized(registration: RegisteredPanel) {
    if (registration.maximized) {
      setPanelMaximized(registration, false);
      if (registration.widthBeforeMaximize) registration.currentWidth = registration.widthBeforeMaximize;
      setBodyPanelState(registration.side, registration);
      return;
    }
    setPanelMaximized(registration, true);
  }

  function closeRegistration(registration: RegisteredPanel, focusTrigger = true) {
    if (registration.panel.hidden) return;
    registration.onBeforeClose?.();
    setPanelMaximized(registration, false);
    registration.panel.hidden = true;
    if (registration.backdrop) registration.backdrop.hidden = true;
    setTriggerState(registration, false);
    if (active[registration.side]?.id === registration.id) {
      active[registration.side] = undefined;
      setBodyPanelState(registration.side, undefined);
    }
    registration.onClose?.();
    if (focusTrigger) focusElement(resolveElement(registration.focusOnClose) || registration.trigger);
  }

  function closeOppositeIfNeeded(side: AppPanelSide) {
    if (multiSideMode.matches) return;
    const other = active[oppositeSide(side)];
    if (other) closeRegistration(other, false);
  }

  function openRegistration(registration: RegisteredPanel) {
    const sameSide = active[registration.side];
    if (sameSide && sameSide.id !== registration.id) closeRegistration(sameSide, false);
    closeOppositeIfNeeded(registration.side);
    if (!registration.panel.hidden) return;

    blurActiveEditableOnMobile();
    registration.onBeforeOpen?.();
    active[registration.side] = registration;
    lastOpenedSide = registration.side;
    registration.panel.hidden = false;
    if (registration.backdrop) registration.backdrop.hidden = false;
    setBodyPanelState(registration.side, registration);
    setTriggerState(registration, true);
    registration.onOpen?.();
    focusElement(resolveElement(registration.focusOnOpen));
  }

  function enforceLayoutMode() {
    if (multiSideMode.matches || !(active.left && active.right)) return;
    const sideToClose: AppPanelSide = lastOpenedSide === "left" ? "right" : "left";
    const registration = active[sideToClose];
    if (registration) closeRegistration(registration, false);
  }

  function updateActiveWidths() {
    if (active.left) setBodyPanelState("left", active.left);
    if (active.right) setBodyPanelState("right", active.right);
  }

  function clampWidth(registration: RegisteredPanel, desired: number) {
    const other = active[oppositeSide(registration.side)];
    const otherWidth = other && !other.maximized ? other.panel.getBoundingClientRect().width : 0;
    const maxAvailable = Math.max(defaultMinWidth, window.innerWidth - otherWidth - minChatWidth);
    const min = registration.minWidth ?? defaultMinWidth;
    const max = Math.min(registration.maxWidth ?? defaultMaxWidth, maxAvailable);
    return Math.min(Math.max(desired, min), Math.max(min, max));
  }

  function shouldMaximizeFromDrag(registration: RegisteredPanel, desired: number, clientX: number) {
    if (registration.side === "right" && clientX <= dragEdgeThreshold) return true;
    if (registration.side === "left" && clientX >= window.innerWidth - dragEdgeThreshold) return true;
    return desired >= window.innerWidth * maximizeDragThreshold;
  }

  function shouldCloseFromDrag(registration: RegisteredPanel, desired: number, clientX: number) {
    if (registration.side === "right" && clientX >= window.innerWidth - dragEdgeThreshold) return true;
    if (registration.side === "left" && clientX <= dragEdgeThreshold) return true;
    return desired <= window.innerWidth * closeDragThreshold;
  }

  function previewDragWidth(desired: number) {
    return Math.min(Math.max(desired, 0), window.innerWidth);
  }

  function beginResize(registration: RegisteredPanel, event: PointerEvent) {
    if (!paneMode.matches || registration.panel.hidden) return;
    event.preventDefault();
    registration.resizeHandle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = registration.panel.getBoundingClientRect().width;
    let lastDesired = startWidth;
    let lastClientX = startX;
    document.body.classList.add("appPanelResizing");

    const updatePreview = (desired: number, clientX: number) => {
      lastDesired = desired;
      lastClientX = clientX;
      setPanelMaximized(registration, false);
      registration.currentWidth = `${Math.round(previewDragWidth(desired))}px`;
      registration.panel.classList.toggle("appSidePanel--closePreview", shouldCloseFromDrag(registration, desired, clientX));
      registration.panel.classList.toggle("appSidePanel--maximizePreview", shouldMaximizeFromDrag(registration, desired, clientX));
      setBodyPanelState(registration.side, registration);
    };

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const desired = registration.side === "left" ? startWidth + delta : startWidth - delta;
      updatePreview(desired, moveEvent.clientX);
    };

    const finishDrag = (upEvent: PointerEvent) => {
      registration.resizeHandle.releasePointerCapture?.(upEvent.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      registration.panel.classList.remove("appSidePanel--closePreview", "appSidePanel--maximizePreview");
      document.body.classList.remove("appPanelResizing");

      if (shouldCloseFromDrag(registration, lastDesired, lastClientX)) {
        closeRegistration(registration);
        return;
      }

      if (shouldMaximizeFromDrag(registration, lastDesired, lastClientX)) {
        setPanelMaximized(registration, true);
        return;
      }

      setPanelMaximized(registration, false);
      const nextWidth = `${Math.round(clampWidth(registration, lastDesired))}px`;
      registration.currentWidth = nextWidth;
      storeWidth(registration.id, nextWidth);
      setBodyPanelState(registration.side, registration);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }

  function register(registration: AppPanelRegistration): AppPanelHandle {
    const side = registration.side || "right";
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "appPanelResizeHandle";
    resizeHandle.setAttribute("role", "separator");
    resizeHandle.setAttribute("aria-orientation", "vertical");
    resizeHandle.title = "Resize panel. Drag to the screen edge to maximize.";

    const registered: RegisteredPanel = {
      ...registration,
      side,
      activeClass: registration.activeClass || "active",
      currentWidth: readStoredWidth(registration.id),
      resizeHandle,
    };
    registrations.set(registered.id, registered);

    registered.panel.classList.add("appSidePanel", `appSidePanel--${side}`);
    // Keep the old class name as an alias for callers/styles that still refer to right panels.
    if (side === "right") registered.panel.classList.add("appRightPanel");
    registered.backdrop?.classList.add("appPanelBackdrop");
    registered.backdrop?.classList.add("appRightPanelBackdrop");
    registered.trigger?.setAttribute("aria-expanded", String(!registered.panel.hidden));
    if (registered.panel.id) registered.trigger?.setAttribute("aria-controls", registered.panel.id);
    resizeHandle.addEventListener("pointerdown", (event) => beginResize(registered, event));
    resizeHandle.addEventListener("dblclick", () => togglePanelMaximized(registered));
    registered.panel.append(resizeHandle);

    const handle: AppPanelHandle = {
      id: registered.id,
      side,
      open: () => openRegistration(registered),
      close: (focusTrigger = true) => closeRegistration(registered, focusTrigger),
      toggle: () => {
        if (registered.panel.hidden) openRegistration(registered);
        else closeRegistration(registered);
      },
      setOpen: (open) => open ? openRegistration(registered) : closeRegistration(registered),
      isOpen: () => !registered.panel.hidden,
    };

    registered.trigger?.addEventListener("click", handle.toggle);
    registered.closeButton?.addEventListener("click", () => handle.close());
    registered.backdrop?.addEventListener("click", () => handle.close());

    return handle;
  }

  document.addEventListener("keydown", (event) => {
    const activePanel = (lastOpenedSide ? active[lastOpenedSide] : undefined) || active.right || active.left;
    if (event.key !== "Escape" || !activePanel) return;
    if (activePanel.closeOnEscape === false || activePanel.canCloseOnEscape?.() === false) return;
    closeRegistration(activePanel);
  });

  paneMode.addEventListener("change", updateActiveWidths);
  multiSideMode.addEventListener("change", () => {
    enforceLayoutMode();
    updateActiveWidths();
  });
  window.addEventListener("resize", updateActiveWidths);

  return {
    register,
    closeActive: () => {
      const activePanel = (lastOpenedSide ? active[lastOpenedSide] : undefined) || active.right || active.left;
      if (activePanel) closeRegistration(activePanel);
    },
    activeId: (side) => side ? active[side]?.id : active.right?.id || active.left?.id,
    isOpen: (id) => registrations.get(id)?.panel.hidden === false,
  };
}

export const createRightPanelManager = createAppPanelManager;
