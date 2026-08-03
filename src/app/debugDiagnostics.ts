import type { AppState } from "./types.js";

const storageKey = "pi-web-debug-events-v1";
const maxEvents = 120;

type DebugEvent = { at: string; event: string; details?: Record<string, unknown> };

function readEvents(): DebugEvent[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.slice(-maxEvents) : [];
  } catch { return []; }
}

export function recordDebugEvent(event: string, details?: Record<string, unknown>) {
  try {
    const events = readEvents();
    events.push({ at: new Date().toISOString(), event, ...(details ? { details } : {}) });
    localStorage.setItem(storageKey, JSON.stringify(events.slice(-maxEvents)));
  } catch { /* diagnostics must never affect the app */ }
}

function displayMode() {
  if (matchMedia("(display-mode: standalone)").matches) return "standalone";
  if (matchMedia("(display-mode: fullscreen)").matches) return "fullscreen";
  return "browser";
}

function report(state: AppState) {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  let attachmentDraft: unknown = null;
  try { attachmentDraft = JSON.parse(localStorage.getItem("pi-web-composer-attachments-v1") || "null"); } catch { attachmentDraft = "malformed"; }
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    page: { href: `${location.origin}${location.pathname}${location.search.replace(/([?&]token=)[^&]*/i, "$1[redacted]")}`, visibility: document.visibilityState, displayMode: displayMode(), navigationType: navigation?.type },
    browser: { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, online: navigator.onLine },
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    session: { id: state.currentSessionId, cwd: state.currentCwd },
    attachmentDraft,
    events: readEvents(),
  }, null, 2);
}

export function initDebugDiagnostics(state: AppState) {
  recordDebugEvent("page-loaded", { navigationType: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type, displayMode: displayMode() });
  addEventListener("pageshow", (event) => recordDebugEvent("page-show", { persisted: (event as PageTransitionEvent).persisted }));
  addEventListener("pagehide", (event) => recordDebugEvent("page-hide", { persisted: (event as PageTransitionEvent).persisted }));
  document.addEventListener("visibilitychange", () => recordDebugEvent("visibility-change", { state: document.visibilityState }));
  addEventListener("online", () => recordDebugEvent("network-online"));
  addEventListener("offline", () => recordDebugEvent("network-offline"));

  const open = document.querySelector<HTMLButtonElement>("#openDebugDiagnosticsButton");
  if (!open) return;
  const dialog = document.createElement("dialog");
  dialog.className = "debugDiagnostics";
  dialog.innerHTML = `<div class="debugDiagnosticsHeader"><h2>Debug report</h2><button type="button" data-close aria-label="Close">×</button></div><p>Reproduce the problem, return here after the refresh, then copy this report.</p><textarea readonly spellcheck="false"></textarea><div class="debugDiagnosticsActions"><button type="button" data-clear>Clear events</button><button type="button" data-copy>Copy report</button></div>`;
  document.body.append(dialog);
  const textarea = dialog.querySelector("textarea")!;
  const refresh = () => { textarea.value = report(state); };
  open.addEventListener("click", () => { refresh(); dialog.showModal(); });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector("[data-clear]")?.addEventListener("click", () => { localStorage.removeItem(storageKey); recordDebugEvent("events-cleared"); refresh(); });
  dialog.querySelector("[data-copy]")?.addEventListener("click", async (event) => {
    refresh();
    await navigator.clipboard.writeText(textarea.value);
    const button = event.currentTarget as HTMLButtonElement;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy report"; }, 1200);
  });
}
