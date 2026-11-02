// Wires the client state layer and the root-view slot alongside the 2D app
// (issue #181). Nothing here changes the 2D app: the client state layer is a
// lazy chunk that loads only on a view page (/view/<id>), and the header's VR
// button stays hidden unless the browser can enter immersive VR.
import type { PiWebClient, RealtimeEnvelope } from "../client/types.js";
import { iconElement } from "../app/icons.js";
import { createSlotRegistry, type SlotRegistry } from "./slots.js";
import { initRootViewHost, ROOT_VIEW_SLOT, viewHref, viewIdFromPath, type RootView } from "./rootView.js";
import { showVrEntryWhenSupported, VR_VIEW_ID, vrView } from "./vr/index.js";
import "./rootView.css";

export const builtInViews: ReadonlyMap<string, RootView> = new Map([[vrView.id, vrView]]);

/** Envelopes that arrive while the client chunk loads are replayed to it, up to this many. */
const MAX_BUFFERED_ENVELOPES = 500;

export type ViewsController = {
  slots: SlotRegistry;
  /** Feed every realtime envelope here (the 2D app's socket; no second connection). */
  onRealtimeEnvelope(envelope: RealtimeEnvelope): void;
  openView(id: string): void;
  /** The view this page was opened for, if any. */
  activeViewId: string | undefined;
};

export function initViews(options: {
  headers: () => Record<string, string>;
  appEl: HTMLElement;
  /** Where the header's "Open VR view" button goes (before this element). */
  headerAnchor?: HTMLElement;
}): ViewsController {
  const realtimeListeners = new Set<(envelope: RealtimeEnvelope) => void>();
  const activeViewId = viewIdFromPath(location.pathname);
  const view = activeViewId ? builtInViews.get(activeViewId) : undefined;
  // Only a view page keeps envelopes for the client; the normal app drops them at once.
  let buffer: RealtimeEnvelope[] | undefined = view ? [] : undefined;

  let clientPromise: Promise<PiWebClient> | undefined;
  const loadClient = () => clientPromise ||= import("../client/client.js").then(({ createPiWebClient }) => {
    const client = createPiWebClient({
      headers: options.headers,
      // Views open sessions through the API, not the hidden 2D app's opener:
      // that opener marks a session read at once, while views decide when
      // something has been read (the VR view waits for a 2 s dwell).
      realtime: { subscribe(listener) { realtimeListeners.add(listener); return () => { realtimeListeners.delete(listener); }; } },
    });
    const pending = buffer || [];
    buffer = undefined;
    for (const envelope of pending) for (const listener of [...realtimeListeners]) listener(envelope);
    return client;
  });

  const slots = createSlotRegistry();
  initRootViewHost({ slots, loadClient, appEl: options.appEl, exitHref: () => `/${location.search}` });

  function openView(id: string) {
    // A top-level navigation: WebXR needs a top-level page, and the 2D app's
    // URL state (session id) carries over in the query string.
    location.assign(viewHref(id, location.search));
  }

  if (view) slots.register(ROOT_VIEW_SLOT, view);
  else if (activeViewId) console.warn(`Unknown view "${activeViewId}"; showing the normal app.`);

  if (options.headerAnchor && !view) {
    const button = document.createElement("button");
    button.id = "openVrViewButton";
    button.type = "button";
    button.className = "iconButton statusBarButton";
    button.title = "Open VR view";
    button.setAttribute("aria-label", "Open VR view");
    button.hidden = true;
    button.append(iconElement("glasses"));
    button.addEventListener("click", () => openView(VR_VIEW_ID));
    options.headerAnchor.before(button);
    void showVrEntryWhenSupported(button);
  }

  return {
    slots,
    activeViewId: view ? activeViewId : undefined,
    openView,
    onRealtimeEnvelope(envelope) {
      if (buffer) {
        if (buffer.length < MAX_BUFFERED_ENVELOPES) buffer.push(envelope);
        return;
      }
      for (const listener of [...realtimeListeners]) listener(envelope);
    },
  };
}

/**
 * A view's "Open in 2D" (/?sessionId=…&artifact=…) asks the 2D app to open an
 * artifact in its viewer. Only pi-web's own artifact routes are accepted; the
 * parameter is removed from the address once read.
 */
export function takeArtifactParam(): string | undefined {
  const url = new URL(location.href);
  const value = url.searchParams.get("artifact");
  if (value === null) return undefined;
  url.searchParams.delete("artifact");
  history.replaceState(history.state, "", url);
  try {
    const target = new URL(value, location.origin);
    return target.origin === location.origin && /^\/api\/(?:session-)?artifacts\/./.test(target.pathname) ? target.pathname + target.search : undefined;
  } catch { return undefined; }
}
