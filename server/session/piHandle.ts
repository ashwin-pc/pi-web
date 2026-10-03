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

  constructor(private readonly raw: PiWebSession) {}

  state(cwd: string) { return projectSessionState(this.raw, cwd); }
  messages() { return projectMessages(this.raw); }
  prompt(text: string, options?: Parameters<PiWebSession["prompt"]>[1]) {
    return this.raw.prompt(text, options);
  }
  interrupt() { return this.raw.abort(); }

  subscribe(listener: (event: unknown) => void): () => void {
    const unsubscribe = this.raw.subscribe?.(listener);
    const release = () => {
      if (!this.subscriptions.delete(release)) return;
      unsubscribe?.();
    };
    this.subscriptions.add(release);
    return release;
  }

  /** Preserve Pi shutdown ordering and best-effort cleanup, even on hook failure. */
  dispose(reason: string): Promise<void> {
    return this.disposal ??= this.disposeOnce(reason);
  }

  private async disposeOnce(reason: string) {
    const runner = this.raw.extensionRunner as (PiWebSession["extensionRunner"] & {
      hasHandlers?(name: string): boolean;
      emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
    });
    try {
      if (runner?.hasHandlers?.("session_shutdown")) await runner.emit?.({ type: "session_shutdown", reason: "quit" });
    } catch (error) { console.warn(`Could not emit session shutdown before ${reason}:`, error); }
    for (const release of this.subscriptions) {
      try { release(); }
      catch (error) { console.warn(`Could not unsubscribe session before ${reason}:`, error); }
    }
    try { (this.raw as PiWebSession & { dispose?(): void }).dispose?.(); }
    catch (error) { console.warn(`Could not dispose session after ${reason}:`, error); }
  }
}
