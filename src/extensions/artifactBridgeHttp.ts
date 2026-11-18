export type BridgeAttempt = { id: string; controller: AbortController; opened: boolean };
export type BridgeAuthority = { sessionId: string; key: string; selection: string; url: string; headers: () => Record<string, string> };
export class BridgeHttpError extends Error {
  constructor(readonly status: number) { super("Preview operation failed"); }
}
/** Host-only authority and bounded fetch lifetimes; no iframe-provided selectors. */
export function createBridgeHttp(options: BridgeAuthority) {
  const bounded = async <T>(signal: AbortSignal, ms: number, work: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(abort, ms);
    try { return await work(controller.signal); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
  return {
    invoke(attempt: BridgeAttempt, operation: string, extra: Record<string, unknown> = {}, signal = attempt.controller.signal) {
      return bounded(signal, operation === "request" ? 180_000 : 10_000, async signal => {
        const response = await fetch("/api/web-contributions/invoke", { method: "POST", headers: options.headers(), signal,
          body: JSON.stringify({ sessionId: options.sessionId, slot: "artifact-preview", key: options.key, preview: { operation, preview: attempt.id, ...extra } }) });
        const data = await response.json();
        if (!response.ok || data.ok !== true) throw new BridgeHttpError(response.status);
        return data;
      });
    },
    probe(signal: AbortSignal) {
      return bounded(signal, 10_000, async signal => {
        const response = await fetch(options.url, { headers: { ...options.headers(), Range: "bytes=0-0", "x-pi-artifact-selection": options.selection }, signal, redirect: "error", cache: "no-store" });
        await response.body?.cancel();
        if (response.status !== 206 || !/^bytes 0-0\/\d+$/.test(response.headers.get("content-range") || "")) throw new BridgeHttpError(response.status);
      });
    },
  };
}
export type BridgeHttp = ReturnType<typeof createBridgeHttp>;
