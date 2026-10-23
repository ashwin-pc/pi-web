export interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}
export interface CompletionInput { deliveryId: string; message: CompletionMessage }
export interface CompletionReceipt {
  sessionId: string;
  deliveryId: string;
  state: "pending" | "saved";
  entryId?: string;
}

export type CompletionFact = { state: "saved"; entryId: string } | {
  state: "pending";
  admission: "unknown" | "proven-not-admitted";
};
export type CompletionInitialFact = { state: "saved"; entryId: string } | {
  state: "pending";
  submission: "needed" | "observed";
};
/** Per-claim observations, serialized by the coordinator. Only fully verified
 * non-admission permits release; an observed candidate is not persistence proof. */
export interface CompletionProbe {
  initialize(): Promise<CompletionInitialFact>;
  /** May recheck a prior rejection whose non-admission was not yet provable. */
  poll(): Promise<CompletionFact>;
  rejected(error: unknown): Promise<CompletionFact>;
}
export interface CompletionRuntime {
  readonly runtimeKey: object;
  readonly sessionId: string;
  completionProbe(input: CompletionInput): CompletionProbe;
}

/** Proof that the host refused before invoking runtime code. */
export class CompletionDeferredError extends Error {}
export class CompletionOutboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validateCompletionInput(input: CompletionInput): CompletionInput {
  if (!input || typeof input.deliveryId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.deliveryId)) throw new CompletionOutboxError("Invalid deliveryId");
  const message = input.message;
  if (!message || typeof message.customType !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(message.customType) || typeof message.content !== "string" || !message.content || typeof message.display !== "boolean") throw new CompletionOutboxError("Invalid completion message");
  if (message.details !== undefined && (!message.details || typeof message.details !== "object" || Array.isArray(message.details))) throw new CompletionOutboxError("Completion details must be an object");
  if (message.details?.deliveryId !== undefined && message.details.deliveryId !== input.deliveryId) throw new CompletionOutboxError("Completion details.deliveryId conflicts with deliveryId");
  const normalized = JSON.parse(JSON.stringify({ deliveryId: input.deliveryId, message: { customType: message.customType, content: message.content, display: message.display, ...(message.details ? { details: message.details } : {}) } })) as CompletionInput;
  if (Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) throw new CompletionOutboxError("Completion payload exceeds 64 KiB", 413);
  return normalized;
}
function fingerprint(input: CompletionInput) {
  return canonical({ ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } });
}
/** Compare untrusted persisted fields without normalizing missing/malformed data. */
export function assertCompletionPayload(input: CompletionInput, candidate: {
  customType?: unknown; content?: unknown; display?: unknown; details?: unknown;
}): void {
  if (canonical(candidate) !== fingerprint(input)) throw new CompletionOutboxError("deliveryId already belongs to a different payload", 409);
}

type Claim = { fingerprint: string; lookup: Promise<CompletionReceipt>; probe: CompletionProbe };
// Runtime ownership survives coordinator reload. The caller's journal remains
// the sole durable payload/replay owner; runtime identity is adapter-opaque.
const claims = new WeakMap<object, Map<string, Claim>>();
export class CompletionOutbox<Runtime extends object> {
  constructor(
    private readonly send: (value: Runtime, message: CompletionMessage) => Promise<void>,
    private readonly onError: (value: Runtime, error: unknown) => void,
    private readonly runtime: (value: Runtime) => CompletionRuntime,
  ) {}

  async deliver(value: Runtime, raw: CompletionInput): Promise<CompletionReceipt> {
    const input = validateCompletionInput(raw);
    const runtime = this.runtime(value);
    let ownership = claims.get(runtime.runtimeKey);
    if (!ownership) { ownership = new Map(); claims.set(runtime.runtimeKey, ownership); }
    const prior = ownership.get(input.deliveryId);
    const payload = fingerprint(input);
    if (prior && prior.fingerprint !== payload) throw new CompletionOutboxError("deliveryId already belongs to a different payload", 409);
    const receipt = (id?: string): CompletionReceipt => ({ sessionId: runtime.sessionId, deliveryId: input.deliveryId, state: id ? "saved" : "pending", ...(id ? { entryId: id } : {}) });
    const consume = (fact: CompletionFact, owner: Claim): CompletionReceipt => {
      if (fact.state === "pending" && fact.admission === "proven-not-admitted" && ownership.get(input.deliveryId) === owner) ownership.delete(input.deliveryId);
      return receipt(fact.state === "saved" ? fact.entryId : undefined);
    };
    if (prior) {
      // Serialize probe updates as well as submission; a failed read may retry.
      prior.lookup = prior.lookup.catch(() => receipt()).then(async () => consume(await prior.probe.poll(), prior));
      return prior.lookup;
    }
    const probe = runtime.completionProbe(input);
    // Register BEFORE any asynchronous lookup or runtime invocation.
    const claim: Claim = { fingerprint: payload, lookup: Promise.resolve(receipt()), probe };
    ownership.set(input.deliveryId, claim);
    claim.lookup = (async () => {
      let initial: CompletionInitialFact;
      try { initial = await probe.initialize(); }
      catch (error) { ownership.delete(input.deliveryId); throw error; } // No invocation.
      if (initial.state === "saved") return receipt(initial.entryId);
      if (initial.submission === "needed") {
        void Promise.resolve().then(() => this.send(value, { ...input.message, details: { ...input.message.details, deliveryId: input.deliveryId } })).catch(async error => {
          try {
            if (error instanceof CompletionDeferredError) ownership.delete(input.deliveryId);
            else {
              claim.lookup = claim.lookup.catch(() => receipt()).then(async () => consume(await probe.rejected(error), claim));
              await claim.lookup;
            }
          } catch (verificationError) { this.onError(value, verificationError); }
          // Unknown rejection may have been admitted invisibly. Only the adapter
          // can supply final non-admission proof; never infer it from absence.
          this.onError(value, error);
        });
      }
      return receipt();
    })();
    return claim.lookup;
  }
}
