import type { PiWebSession } from "../types.js";
import { projectMessages, projectSessionState } from "./projection.js";

/** Pi-only operational slice isolated from the PR145 PiSessionHandle draft.
 * The host still owns identity, admission, work/viewer leases and the web bridge.
 * Pi-specific configuration, history navigation and retry compatibility continue
 * to use the raw session explicitly; this is not a universal SDK facade.
 */
export class PiSessionHandle {
  private readonly subscriptions = new Set<() => void>();
  private disposal?: Promise<void>;
  private lifetime: "open" | "closing" | "disposed" = "open";

  constructor(private readonly raw: PiWebSession) {}

  state(cwd: string) { return projectSessionState(this.raw, cwd); }
  messages() { return projectMessages(this.raw); }
  prompt(text: string, options?: Parameters<PiWebSession["prompt"]>[1]) {
    return this.raw.prompt(text, options);
  }
  interrupt() { return this.raw.abort(); }

  subscribe(listener: (event: unknown) => void): () => void {
    if (this.lifetime !== "open") throw new Error("Pi runtime is closing or disposed");
    let unsubscribe: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.subscriptions.delete(release);
      unsubscribe?.();
    };
    // SDK subscription may synchronously notify a listener that disposes us.
    this.subscriptions.add(release);
    try {
      unsubscribe = this.raw.subscribe?.(listener);
    } catch (error) {
      release();
      throw error;
    }
    if (released) unsubscribe?.();
    return release;
  }

  /** Preserve Pi shutdown ordering and best-effort cleanup, even on hook failure. */
  dispose(reason: string): Promise<void> {
    if (this.disposal) return this.disposal;
    this.lifetime = "closing";
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    // Publish ownership before invoking any external cleanup callback.
    this.disposal = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
    void this.disposeOnce(reason).then(() => {
      this.lifetime = "disposed";
      settle();
    }, (error) => {
      this.lifetime = "disposed";
      fail(error);
    });
    return this.disposal;
  }

  private async disposeOnce(reason: string) {
    const runner = this.raw.extensionRunner as (PiWebSession["extensionRunner"] & {
      hasHandlers?(name: string): boolean;
      emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
    });
    try {
      if (runner?.hasHandlers?.("session_shutdown")) {
        const shutdown = runner.emit?.({ type: "session_shutdown", reason: "quit" });
        // A synchronous hook returning dispose() must not await its own cleanup.
        // Arbitrary async wrappers awaiting disposal cannot be detected here.
        if (shutdown !== this.disposal) await shutdown;
      }
    } catch (error) { console.warn(`Could not emit session shutdown before ${reason}:`, error); }
    for (const release of this.subscriptions) {
      try { release(); }
      catch (error) { console.warn(`Could not unsubscribe session before ${reason}:`, error); }
    }
    try { (this.raw as PiWebSession & { dispose?(): void }).dispose?.(); }
    catch (error) { console.warn(`Could not dispose session after ${reason}:`, error); }
  }
}
