import { blurActiveEditableOnMobile } from "../app/focus.js";

export type RightPanelRegistration = {
  id: string;
  panel: HTMLElement;
  trigger?: HTMLElement;
  backdrop?: HTMLElement;
  closeButton?: HTMLElement;
  width?: string;
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

export type RightPanelHandle = {
  id: string;
  open: () => void;
  close: (focusTrigger?: boolean) => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
};

export type RightPanelManager = {
  register: (registration: RightPanelRegistration) => RightPanelHandle;
  closeActive: () => void;
  activeId: () => string | undefined;
  isOpen: (id: string) => boolean;
};

type RegisteredRightPanel = RightPanelRegistration & {
  activeClass: string;
};

function resolveElement(value?: HTMLElement | (() => HTMLElement | undefined)) {
  return typeof value === "function" ? value() : value;
}

function focusElement(element?: HTMLElement) {
  if (!element || element.hidden) return;
  element.focus({ preventScroll: true });
}

function panelWidth(registration: RegisteredRightPanel) {
  return registration.width
    || registration.panel.dataset.rightPanelWidth
    || getComputedStyle(registration.panel).getPropertyValue("--app-side-panel-width").trim()
    || "420px";
}

export function createRightPanelManager(): RightPanelManager {
  const registrations = new Map<string, RegisteredRightPanel>();
  let active: RegisteredRightPanel | undefined;

  function setTriggerState(registration: RegisteredRightPanel, open: boolean) {
    registration.trigger?.classList.toggle(registration.activeClass, open);
    registration.trigger?.setAttribute("aria-expanded", String(open));
  }

  function clearActiveLayout(registration: RegisteredRightPanel) {
    if (active?.id !== registration.id) return;
    active = undefined;
    document.body.classList.remove("appRightPanelOpen");
    document.body.removeAttribute("data-right-panel");
    document.body.style.removeProperty("--app-side-right-active-width");
  }

  function closeRegistration(registration: RegisteredRightPanel, focusTrigger = true) {
    if (registration.panel.hidden) return;
    registration.onBeforeClose?.();
    registration.panel.hidden = true;
    if (registration.backdrop) registration.backdrop.hidden = true;
    setTriggerState(registration, false);
    clearActiveLayout(registration);
    registration.onClose?.();
    if (focusTrigger) focusElement(resolveElement(registration.focusOnClose) || registration.trigger);
  }

  function openRegistration(registration: RegisteredRightPanel) {
    if (active && active.id !== registration.id) closeRegistration(active, false);
    if (!registration.panel.hidden) return;

    blurActiveEditableOnMobile();
    registration.onBeforeOpen?.();
    active = registration;
    document.body.classList.add("appRightPanelOpen");
    document.body.dataset.rightPanel = registration.id;
    document.body.style.setProperty("--app-side-right-active-width", panelWidth(registration));
    registration.panel.hidden = false;
    if (registration.backdrop) registration.backdrop.hidden = false;
    setTriggerState(registration, true);
    registration.onOpen?.();
    focusElement(resolveElement(registration.focusOnOpen));
  }

  function register(registration: RightPanelRegistration): RightPanelHandle {
    const registered: RegisteredRightPanel = {
      ...registration,
      activeClass: registration.activeClass || "active",
    };
    registrations.set(registered.id, registered);

    registered.panel.classList.add("appRightPanel");
    registered.backdrop?.classList.add("appRightPanelBackdrop");
    registered.trigger?.setAttribute("aria-expanded", String(!registered.panel.hidden));
    if (registered.panel.id) registered.trigger?.setAttribute("aria-controls", registered.panel.id);

    const handle: RightPanelHandle = {
      id: registered.id,
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
    if (event.key !== "Escape" || !active) return;
    if (active.closeOnEscape === false || active.canCloseOnEscape?.() === false) return;
    closeRegistration(active);
  });

  return {
    register,
    closeActive: () => { if (active) closeRegistration(active); },
    activeId: () => active?.id,
    isOpen: (id) => registrations.get(id)?.panel.hidden === false,
  };
}
