// The root view slot (issue #181, stage 2). The page's root renders either the
// normal 2D app or one alternative full-screen view registered into the
// `root-view` single slot. Views are reached at /view/<id>.
import type { PiWebClient } from "../client/types.js";
import type { SlotRegistry } from "./slots.js";

export const ROOT_VIEW_SLOT = "root-view";

export type RootViewContext = {
  client: PiWebClient;
  /** Leave the view and return to the normal app. */
  exit(): void;
};

export type RootView = {
  id: string;
  title: string;
  /** Render into el; return a disposer that removes everything the view added. */
  mount(el: HTMLElement, context: RootViewContext): () => void;
};

export function viewIdFromPath(pathname: string): string | undefined {
  const match = /^\/view\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(pathname);
  return match?.[1]?.toLowerCase();
}

export function viewHref(id: string, search = "") {
  return `/view/${encodeURIComponent(id)}${search}`;
}

/**
 * Declares the root-view slot and renders whatever it holds. While a view is
 * mounted the 2D app stays alive but hidden, so it keeps the realtime
 * connection and the current-session semantics the client relies on.
 */
export function initRootViewHost(options: {
  slots: SlotRegistry;
  /** The client state layer is a lazy chunk too: it loads when the first view mounts. */
  loadClient: () => Promise<PiWebClient>;
  appEl: HTMLElement;
  exitHref?: () => string;
}) {
  const host = options.slots.declare<RootView, "single">(ROOT_VIEW_SLOT, "single");
  let mounted: { view: RootView; el: HTMLElement; dispose: () => void } | undefined;
  const previousTitle = document.title;

  function exit() {
    location.assign(options.exitHref?.() || "/");
  }

  function unmount() {
    if (!mounted) return;
    const current = mounted;
    mounted = undefined;
    try { current.dispose(); } catch (error) { console.error(`Root view "${current.view.id}" failed to dispose`, error); }
    current.el.remove();
    options.appEl.hidden = false;
    document.documentElement.removeAttribute("data-root-view");
    document.title = previousTitle;
  }

  let renderSerial = 0;
  async function render() {
    const view = host.getSnapshot();
    if (mounted?.view === view) return;
    const serial = ++renderSerial;
    unmount();
    if (!view) return;
    const client = await options.loadClient();
    if (serial !== renderSerial || host.getSnapshot() !== view) return;
    const el = document.createElement("div");
    el.className = "rootView";
    el.id = "rootView";
    el.dataset.view = view.id;
    document.body.append(el);
    options.appEl.hidden = true;
    document.documentElement.setAttribute("data-root-view", view.id);
    document.title = `${view.title} · pi web`;
    try {
      mounted = { view, el, dispose: view.mount(el, { client, exit }) };
    } catch (error) {
      el.remove();
      options.appEl.hidden = false;
      document.documentElement.removeAttribute("data-root-view");
      throw error;
    }
  }

  const renderSafely = () => { render().catch((error) => console.error("Root view failed to mount", error)); };
  const unsubscribe = host.subscribe(renderSafely);
  renderSafely();
  return {
    dispose() { renderSerial++; unsubscribe(); unmount(); host.dispose(); },
  };
}
