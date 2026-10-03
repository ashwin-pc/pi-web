import { defaultSessionUiState, hasAnySessionUiState, sessionUiStateFromResponse, type SessionUiState, type SessionUiStateResponse } from "../app/types.js";

type KeyedField = "lanes" | "sessionNotes" | "sessionMarkers" | "sessionUnreadStates" | "sessionOrigins";
type StringField = "pinnedFolders" | "favoriteFolders" | "allowedMarkerColors";
type ScalarField = "selectedMarkerColor";
type Entry = SessionUiState[KeyedField][number];
export type UiIntent =
  | { kind: "entry"; field: KeyedField; id: string; value?: Entry }
  | { kind: "string"; field: StringField; id: string; present: boolean }
  | { kind: "clear-strings"; field: StringField }
  | { kind: "scalar"; field: ScalarField; value: SessionUiState[ScalarField] }
  | { kind: "label"; id: keyof SessionUiState["bucketLabels"]; value?: string }
  | { kind: "order"; field: "lanes" | "bucketOrder"; id: string; before?: string; after?: string };

const entryId = (entry: Entry) => entry.sessionId;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Owned plain DTO copy: neither mutable AppState nor a caller's gesture owns our snapshots. */
function copyUiState(state: SessionUiState): SessionUiState {
  return {
    ...state,
    lanes: state.lanes.map((entry) => ({ ...entry })),
    sessionNotes: state.sessionNotes.map((entry) => ({ ...entry })),
    sessionMarkers: state.sessionMarkers.map((entry) => ({ ...entry })),
    sessionUnreadStates: state.sessionUnreadStates.map((entry) => ({ ...entry })),
    sessionOrigins: state.sessionOrigins.map((entry) => ({ ...entry })),
    pinnedFolders: [...state.pinnedFolders], favoriteFolders: [...state.favoriteFolders],
    allowedMarkerColors: [...state.allowedMarkerColors], bucketOrder: [...state.bucketOrder],
    bucketLabels: { ...state.bucketLabels },
  };
}

/** Apply only the captured user operation, never its stale surrounding collection. */
export function applyUiIntent(state: SessionUiState, intent: UiIntent): SessionUiState {
  if (intent.kind === "entry") {
    const entries = state[intent.field];
    const exists = entries.some((item) => item.sessionId === intent.id);
    return { ...state, [intent.field]: intent.value
      ? exists ? entries.map((item) => item.sessionId === intent.id ? { ...intent.value } : item) : [...entries, { ...intent.value }]
      : entries.filter((item) => item.sessionId !== intent.id) };
  }
  if (intent.kind === "string") {
    const values = state[intent.field].filter((value) => value !== intent.id);
    return { ...state, [intent.field]: intent.present ? [...values, intent.id] : values };
  }
  if (intent.kind === "clear-strings") return { ...state, [intent.field]: [] };
  if (intent.kind === "scalar") return { ...state, [intent.field]: intent.value };
  if (intent.kind === "label") {
    const bucketLabels = { ...state.bucketLabels };
    if (intent.value === undefined) delete bucketLabels[intent.id];
    else bucketLabels[intent.id] = intent.value;
    return { ...state, bucketLabels };
  }
  const entries = state[intent.field];
  const item = intent.field === "lanes"
    ? (entries as SessionUiState["lanes"]).find((entry) => entry.sessionId === intent.id)
    : (entries as string[]).find((entry) => entry === intent.id);
  if (!item) return state;
  const idOf = (value: typeof item) => typeof value === "string" ? value : value.sessionId;
  const remaining = entries.filter((value) => idOf(value as typeof item) !== intent.id);
  const before = remaining.findIndex((value) => idOf(value as typeof item) === intent.before);
  const after = remaining.findIndex((value) => idOf(value as typeof item) === intent.after);
  const index = before >= 0 ? before : after >= 0 ? after + 1 : remaining.length;
  const ordered = [...remaining.slice(0, index), item, ...remaining.slice(index)];
  return { ...state, [intent.field]: ordered };
}

/** Compare one gesture against the previous optimistic projection; additions do not reorder old IDs. */
export function captureUiIntents(previous: SessionUiState, next: Partial<SessionUiState>): UiIntent[] {
  const intents: UiIntent[] = [];
  for (const field of ["lanes", "sessionNotes", "sessionMarkers", "sessionUnreadStates", "sessionOrigins"] as const) {
    if (!next[field]) continue;
    const before = new Map(previous[field].map((entry) => [entryId(entry), entry]));
    const after = new Map(next[field].map((entry) => [entryId(entry), entry]));
    for (const [id, value] of after) if (!equal(before.get(id), value)) intents.push({ kind: "entry", field, id, value: { ...value } });
    for (const id of before.keys()) if (!after.has(id)) intents.push({ kind: "entry", field, id });
  }
  for (const field of ["pinnedFolders", "favoriteFolders", "allowedMarkerColors"] as const) {
    const values = next[field];
    if (!values) continue;
    if (field === "allowedMarkerColors" && values.length === 0 && previous[field].length > 0) {
      intents.push({ kind: "clear-strings", field });
      continue;
    }
    for (const id of values) if (!previous[field].includes(id as never)) intents.push({ kind: "string", field, id, present: true });
    for (const id of previous[field]) if (!(values as readonly string[]).includes(id)) intents.push({ kind: "string", field, id, present: false });
  }
  if (next.selectedMarkerColor !== undefined && next.selectedMarkerColor !== previous.selectedMarkerColor)
    intents.push({ kind: "scalar", field: "selectedMarkerColor", value: next.selectedMarkerColor });
  if (next.bucketLabels) {
    for (const id of defaultSessionUiState.bucketOrder) {
      if (next.bucketLabels[id] !== previous.bucketLabels[id]) intents.push({ kind: "label", id, value: next.bucketLabels[id] });
    }
  }
  // Reorders require the dragged item's anchors, supplied at the gesture site.
  // A new entry or ordinary preference update never manufactures an order intent.
  return intents;
}

export type UiTransport = {
  read(): Promise<SessionUiState | undefined>;
  patch(patch: Partial<SessionUiState> & { expectedRevision: number; initialize?: true }): Promise<{ status: number; state?: SessionUiState; error?: string }>;
  postUnread(sessionId: string, unread: boolean): Promise<{ status: number; state?: SessionUiState; error?: string }>;
};

/** One serialized CAS writer and one authoritative+pending projection for all drawer gestures. */
export class SessionUiCoordinator {
  private canonical?: SessionUiState;
  private pending: UiIntent[] = [];
  private queue = Promise.resolve();
  private migrationSeed?: SessionUiState;
  private bootProjection?: SessionUiState;
  private started = false;
  private failed = false;
  constructor(private readonly transport: UiTransport, private readonly render: (state: SessionUiState) => void, private readonly report: (message: string) => void) {}
  get projected() {
    if (!this.canonical) return this.bootProjection ? copyUiState(this.pending.reduce(applyUiIntent, this.bootProjection)) : undefined;
    const base = this.migrationSeed && !this.canonical.initialized && this.canonical.revision === 0 ? this.migrationSeed : this.canonical;
    return copyUiState(this.pending.reduce(applyUiIntent, base));
  }
  private draw() { const state = this.projected; if (state) this.render(copyUiState(state)); }
  accept(value: unknown) {
    const snapshot = sessionUiStateFromResponse({ ok: true, sessionUiState: value } satisfies SessionUiStateResponse);
    if (!snapshot || this.canonical && (snapshot.revision < this.canonical.revision ||
      snapshot.revision === this.canonical.revision && (this.canonical.initialized || !snapshot.initialized))) return;
    this.canonical = copyUiState(snapshot);
    this.draw();
  }
  start(seed: SessionUiState): Promise<void> {
    if (this.started) return this.queue;
    this.started = true;
    this.bootProjection = copyUiState(seed);
    this.migrationSeed = hasAnySessionUiState(seed) ? copyUiState(seed) : undefined;
    this.queue = this.loadInitialState();
    return this.queue;
  }
  private async loadInitialState() {
    let snapshot: SessionUiState | undefined;
    try { snapshot = await this.transport.read(); } catch { /* A failed read is never permission to migrate. */ }
    if (!snapshot) {
      this.failed = true;
      this.migrationSeed = undefined;
      this.pending = [];
      // The captured boot view is display-only after a failed GET. Restore it
      // even if a caller mutated AppState while the request was pending.
      this.draw();
      this.report("Session preferences unavailable; reload to retry. No changes were saved.");
      return;
    }
    this.accept(snapshot);
    this.bootProjection = undefined;
    // An SSE snapshot may have won while the initial GET was pending. Never
    // decide first-run eligibility from that stale GET after accept ignored it.
    if (!this.canonical || this.canonical.initialized || this.canonical.revision !== 0 || !this.migrationSeed) {
      this.migrationSeed = undefined;
      return;
    }
    const migration = this.migrationSeed;
    // Migration is a one-shot initialize attempt; a racing winner is authoritative.
    const write = async () => {
      const result = await this.transport.patch({ ...migration, expectedRevision: 0, initialize: true });
      if (result.status === 409) {
        this.migrationSeed = undefined;
        const latest = await this.transport.read();
        if (!latest) throw new Error("Session preferences unavailable; reload to retry.");
        this.accept(latest);
      } else if (result.status !== 200 || !result.state) throw new Error(result.error || `Session preferences update failed (${result.status}). Reload to retry.`);
      else { this.migrationSeed = undefined; this.accept(result.state); }
      this.draw();
    };
    try { await write(); } catch (error) { this.fail(error); }
  }
  setUnread(sessionId: string, unread: boolean): Promise<boolean> {
    if (this.failed || !this.projected) { this.report("Session preferences unavailable; reload to retry."); return Promise.resolve(false); }
    const now = new Date().toISOString();
    const intent: UiIntent = { kind: "entry", field: "sessionUnreadStates", id: sessionId,
      ...(unread ? { value: { sessionId, unreadAt: now, updatedAt: now } } : {}) };
    this.pending.push(intent);
    this.draw();
    return this.enqueue(async () => {
      const response = await this.transport.postUnread(sessionId, unread);
      if (response.status !== 200 || !response.state) throw new Error(response.error || `Session unread update failed (${response.status}). Reload to retry.`);
      this.accept(response.state);
      this.pending.splice(this.pending.indexOf(intent), 1);
      this.draw();
    }).then(() => !this.failed);
  }
  mutate(next: Partial<SessionUiState>, order?: UiIntent): Promise<boolean> {
    if (this.failed) { this.draw(); this.report("Session preferences unavailable; reload before changing them."); return Promise.resolve(false); }
    const base = this.projected;
    if (!base) { this.report("Session preferences are still loading; retry this change once loaded."); return Promise.resolve(false); }
    const intents = captureUiIntents(base, next);
    if (next.bucketOrder && !order && !equal(next.bucketOrder, base.bucketOrder)) {
      this.report("Bucket order needs an explicit reorder gesture. Reload and retry.");
      this.draw();
      return Promise.resolve(false);
    }
    if (order) intents.push(order);
    if (!intents.length) return Promise.resolve(true);
    this.pending.push(...intents);
    this.draw();
    return this.enqueue(async () => {
      const fields = [...new Set(intents.map((intent) => intent.kind === "label" ? "bucketLabels" : intent.field))];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this.canonical) throw new Error("Session preferences unavailable; reload to retry.");
        const updated = intents.reduce(applyUiIntent, this.canonical);
        const patch = {
          ...Object.fromEntries(fields.map((field) => [field, updated[field]])),
          expectedRevision: this.canonical.revision,
        } as Partial<SessionUiState> & { expectedRevision: number };
        const response = await this.transport.patch(patch);
        if (response.status === 409) {
          const latest = await this.transport.read();
          if (!latest) throw new Error("Session preferences conflict; reload to retry.");
          this.accept(latest);
          continue;
        }
        if (response.status !== 200 || !response.state) throw new Error(response.status === 428
          ? "Session preferences need a current version. Reload this tab before retrying."
          : response.error || `Session preferences update failed (${response.status}). Reload to retry.`);
        this.accept(response.state);
        this.pending = this.pending.filter((intent) => !intents.includes(intent));
        this.draw();
        return;
      }
      throw new Error("Session preferences changed repeatedly; reload to retry.");
    }).then(() => !this.failed);
  }
  private enqueue(write: () => Promise<void>): Promise<void> {
    const result = this.queue.then(() => { if (!this.failed) return write(); });
    this.queue = result.catch((error: unknown) => this.fail(error));
    return this.queue;
  }
  private fail(error: unknown) {
    this.failed = true;
    this.migrationSeed = undefined;
    this.pending = [];
    this.draw();
    this.report(error instanceof Error ? error.message : String(error));
  }
}
