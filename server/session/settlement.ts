export type SessionExecutionState = "running" | "idle" | "unavailable";

export interface TrackedSessionStatusDto {
  id: string;
  state: SessionExecutionState;
  settled: boolean;
}

export interface SessionStatusDto {
  sessionId: string;
  state: SessionExecutionState;
  trackedWorkers: TrackedSessionStatusDto[];
  pendingWakeups: number;
  settled: boolean;
}

export interface SessionSettlementRuntime {
  sessionId: string;
  isRunning: boolean;
  pendingMessageCount: number;
}

export type SessionSettlementEvent = {
  type: "session-settled";
  sessionId: string;
  status: SessionStatusDto;
};

type EvaluatedStatus = {
  status: SessionStatusDto;
  cyclic: boolean;
};

/**
 * Tracks generic parent -> child settlement dependencies.
 *
 * Dependency reports are snapshots: reporting again replaces every prior child
 * for that parent. Runtime changes are explicitly invalidated through
 * noteRuntimeChanged(), which coalesces recomputation for the changed session
 * and all of its transitive parents.
 */
export class SessionSettlementTracker {
  private readonly dependenciesByParent = new Map<string, Set<string>>();
  private readonly parentsByChild = new Map<string, Set<string>>();
  private readonly lastSettled = new Map<string, boolean>();
  private readonly pendingRecomputations = new Set<string>();
  private revision = 0;
  private drainScheduled = false;
  private draining = false;

  constructor(
    private readonly loadRuntime: (id: string) => Promise<SessionSettlementRuntime | undefined>,
    private readonly emit: (event: SessionSettlementEvent) => void,
  ) {}

  report(parentId: string, childIds: string[]): void {
    const parent = parentId.trim();
    if (!parent) return;

    const next = new Set(
      childIds
        .map((id) => typeof id === "string" ? id.trim() : "")
        .filter((id) => id.length > 0 && id !== parent),
    );
    const previous = this.dependenciesByParent.get(parent) || new Set<string>();
    if (setsEqual(previous, next)) return;

    for (const child of previous) {
      if (next.has(child)) continue;
      const parents = this.parentsByChild.get(child);
      parents?.delete(parent);
      if (parents?.size === 0) this.parentsByChild.delete(child);
    }
    for (const child of next) {
      if (previous.has(child)) continue;
      let parents = this.parentsByChild.get(child);
      if (!parents) this.parentsByChild.set(child, parents = new Set());
      parents.add(parent);
    }

    if (next.size > 0) this.dependenciesByParent.set(parent, next);
    else this.dependenciesByParent.delete(parent);
    this.revision += 1;
    this.enqueueWithAncestors(parent);
  }

  /** Remove a session's outbound report and cached transition baseline. */
  clear(id: string): void {
    const sessionId = id.trim();
    if (!sessionId) return;
    const children = this.dependenciesByParent.get(sessionId);
    if (children) {
      for (const child of children) {
        const parents = this.parentsByChild.get(child);
        parents?.delete(sessionId);
        if (parents?.size === 0) this.parentsByChild.delete(child);
      }
      this.dependenciesByParent.delete(sessionId);
    }
    this.lastSettled.delete(sessionId);
    this.pendingRecomputations.delete(sessionId);
    this.revision += 1;
    // Parents still tracking this session must observe its new runtime (usually
    // unavailable); incoming edges deliberately remain intact.
    for (const parent of this.ancestorsOf(sessionId)) this.pendingRecomputations.add(parent);
    this.scheduleDrain();
  }

  async status(id: string): Promise<SessionStatusDto> {
    const sessionId = id.trim();
    for (;;) {
      const revision = this.revision;
      const evaluated = new Map<string, EvaluatedStatus>();
      const result = await this.evaluate(sessionId, evaluated, new Set());
      if (revision !== this.revision) continue;
      this.commit(evaluated);
      return result.status;
    }
  }

  noteRuntimeChanged(id: string): void {
    const sessionId = id.trim();
    if (!sessionId) return;
    this.revision += 1;
    this.enqueueWithAncestors(sessionId);
  }

  private enqueueWithAncestors(id: string): void {
    this.pendingRecomputations.add(id);
    for (const parent of this.ancestorsOf(id)) this.pendingRecomputations.add(parent);
    this.scheduleDrain();
  }

  private ancestorsOf(id: string): Set<string> {
    const ancestors = new Set<string>();
    const queue = [...(this.parentsByChild.get(id) || [])];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      if (ancestors.has(parent)) continue;
      ancestors.add(parent);
      queue.push(...(this.parentsByChild.get(parent) || []));
    }
    return ancestors;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining || this.pendingRecomputations.size === 0) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingRecomputations.size > 0) {
        const roots = [...this.pendingRecomputations];
        this.pendingRecomputations.clear();
        const revision = this.revision;
        const evaluated = new Map<string, EvaluatedStatus>();
        for (const root of roots) await this.evaluate(root, evaluated, new Set());
        if (revision !== this.revision) {
          for (const root of roots) this.pendingRecomputations.add(root);
          continue;
        }
        this.commit(evaluated);
      }
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }

  private async evaluate(
    id: string,
    memo: Map<string, EvaluatedStatus>,
    visiting: Set<string>,
  ): Promise<EvaluatedStatus> {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) {
      return {
        cyclic: true,
        status: unavailableStatus(id),
      };
    }

    visiting.add(id);
    const childResults: Array<{ id: string; result: EvaluatedStatus }> = [];
    for (const child of this.dependenciesByParent.get(id) || []) {
      childResults.push({ id: child, result: await this.evaluate(child, memo, visiting) });
    }
    visiting.delete(id);

    let runtime: SessionSettlementRuntime | undefined;
    try {
      runtime = await this.loadRuntime(id);
    } catch {
      runtime = undefined;
    }

    const cyclic = childResults.some(({ result }) => result.cyclic);
    const trackedWorkers = childResults.map(({ id: childId, result }) => ({
      id: childId,
      state: result.status.state,
      settled: result.status.settled,
    }));
    const pendingWakeups = trackedWorkers.filter((worker) => worker.settled).length;
    const ownIdle = runtime ? !runtime.isRunning && Number(runtime.pendingMessageCount || 0) === 0 : false;
    const state: SessionExecutionState = !runtime || cyclic
      ? "unavailable"
      : ownIdle ? "idle" : "running";
    const settled = state === "idle"
      && pendingWakeups === 0
      && trackedWorkers.every((worker) => worker.settled);
    const result = {
      cyclic,
      status: { sessionId: runtime?.sessionId || id, state, trackedWorkers, pendingWakeups, settled },
    } satisfies EvaluatedStatus;
    memo.set(id, result);
    return result;
  }

  private commit(evaluated: Map<string, EvaluatedStatus>): void {
    for (const [id, { status }] of evaluated) {
      const previous = this.lastSettled.get(id);
      this.lastSettled.set(id, status.settled);
      if (previous === false && status.settled) {
        this.emit({ type: "session-settled", sessionId: status.sessionId, status });
      }
    }
  }
}

function unavailableStatus(sessionId: string): SessionStatusDto {
  return { sessionId, state: "unavailable", trackedWorkers: [], pendingWakeups: 0, settled: false };
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
