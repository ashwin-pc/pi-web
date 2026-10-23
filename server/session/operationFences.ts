export type OperationEffect = "lifetime" | "shell" | "transcript" | "prompt" | "navigation";
export interface OperationToken {
  effect: OperationEffect;
  canceled: boolean;
  promptAdmitted: boolean;
  settled: Promise<void>;
  finish(): void;
}
type QueueState = { readonly isIdle?: boolean; pendingMessageCount?: number };
type Failure = (message: string, status: number, recoveryRequired: boolean) => Error;

/** Safety ownership, independent of visible work leases. Only transcript-capable
 * operations participate in Stop/idle/branch barriers; UI waits remain live.
 * USER queue reconciliation never says anything about custom-message ownership.
 */
export class OperationFences {
  readonly operations = new Set<OperationToken>();
  epoch = 0;
  closing = false;
  retirement?: Promise<void>;
  private userQueueAmbiguous = false;
  constructor(private readonly failure: Failure) {}

  begin(effect: OperationEffect): OperationToken {
    this.assertOpen();
    let settle!: () => void;
    const token: OperationToken = {
      effect, canceled: false, promptAdmitted: false,
      settled: new Promise<void>(resolve => { settle = resolve; }),
      finish: () => { this.operations.delete(token); settle(); },
    };
    this.operations.add(token);
    return token;
  }
  stop() {
    this.epoch++;
    // Bash appends one atomic entry on completion. Keep its settlement ownership
    // for retirement/navigation, but do not fence new prompts if abortBash is
    // absent (or the process takes time to terminate).
    for (const token of this.operations) if (token.effect !== "lifetime" && token.effect !== "shell") token.canceled = true;
  }
  admitted(token: OperationToken | undefined, epoch: number | undefined, ambiguousQueue: boolean) {
    if (epoch !== undefined && epoch !== this.epoch) {
      if (ambiguousQueue) this.userQueueAmbiguous = true;
      throw this.failure("Prompt canceled before admission", ambiguousQueue ? 503 : 409, ambiguousQueue);
    }
    if (token) token.promptAdmitted = true;
  }
  requiresRecovery(state: QueueState) {
    const canceled = [...this.operations].some(token => token.canceled && !(token.effect === "prompt" && token.promptAdmitted));
    // Do not clear while a canceled preflight can still enqueue later.
    if (!canceled && this.userQueueAmbiguous && state.isIdle === true && state.pendingMessageCount === 0) this.userQueueAmbiguous = false;
    return canceled || this.userQueueAmbiguous;
  }
  assertOpen() {
    if (this.closing) throw this.failure("Session runtime is closing; wait for settlement or restart the server", 409, true);
  }
  assertTranscript(state: QueueState) {
    this.assertOpen();
    if (this.requiresRecovery(state)) throw this.failure("A canceled session operation is still settling; retry after it finishes or restart the server", 409, true);
  }
  get hasTranscriptWork() { return [...this.operations].some(token => token.effect !== "lifetime"); }
  get navigating() { return [...this.operations].some(token => token.effect === "navigation"); }
  get canceledTranscriptWork() { return [...this.operations].some(token => token.canceled); }
  async settleTranscript() {
    await Promise.all([...this.operations].filter(token => token.effect !== "lifetime").map(token => token.settled));
  }
  retire(operation: () => Promise<void>) {
    if (!this.retirement) {
      this.closing = true;
      this.stop();
      // Publish before callbacks can reenter retirement. Keep ownership on timeout
      // or failure: no replacement may race a potentially late appender.
      const retirement = Promise.resolve().then(operation);
      this.retirement = retirement;
      // A failed interrupt has settled (unlike a timeout). Keep admission closed,
      // but permit another cleanup attempt against this SAME runtime.
      void retirement.catch(() => { if (this.retirement === retirement) this.retirement = undefined; });
    }
    return this.retirement;
  }
  async wait(operation: Promise<unknown>, label: string, timeoutMs: number) {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(this.failure(`${label} did not settle; runtime retained to prevent late delivery. Restart the server to recover.`, 503, true)), timeoutMs);
    });
    try { await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
  }
}
