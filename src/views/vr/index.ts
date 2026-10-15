// The built-in VR view: a tiny registration that lives in the main bundle.
// Everything heavy (three.js and the City scene) is a lazy chunk, imported
// only when the view mounts.
import type { RootView } from "../rootView.js";

export const VR_VIEW_ID = "vr";

export const vrView: RootView = {
  id: VR_VIEW_ID,
  title: "VR view",
  mount(el, context) {
    let disposed = false;
    let dispose: (() => void) | undefined;
    const status = document.createElement("div");
    status.className = "rootViewStatus";
    status.setAttribute("role", "status");
    status.textContent = "Loading the VR view…";
    el.append(status);
    import("./vrApp.js")
      .then(async (module) => {
        if (disposed) return;
        const unmount = await module.mountVrApp(el, context, (text) => { status.textContent = text; });
        if (disposed) { unmount(); return; }
        dispose = unmount;
        status.remove();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error("VR view failed to load", error);
        status.textContent = `The VR view could not load: ${error instanceof Error ? error.message : String(error)}`;
        status.classList.add("error");
      });
    return () => {
      disposed = true;
      dispose?.();
      status.remove();
    };
  },
};

/**
 * Show the header's VR button only where an immersive VR session is
 * possible (a headset browser). Everywhere else, /view/vr and the keyboard
 * shortcut remain the way in, and the header does not change.
 */
export async function showVrEntryWhenSupported(button: HTMLElement, xr: { isSessionSupported?(mode: string): Promise<boolean> } | undefined = (navigator as Navigator & { xr?: { isSessionSupported?(mode: string): Promise<boolean> } }).xr) {
  if (!xr?.isSessionSupported || !window.isSecureContext) return false;
  try {
    const supported = await xr.isSessionSupported("immersive-vr");
    button.hidden = !supported;
    return supported;
  } catch {
    return false;
  }
}
