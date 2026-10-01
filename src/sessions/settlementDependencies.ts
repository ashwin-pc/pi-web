export type SettlementDependencySnapshot = {
  sessionId: string;
  revision: number;
};

/**
 * Canonical client-side owner for generic settlement dependency snapshots.
 * Live reports advance a per-session revision so an older HTTP snapshot can
 * never overwrite newer realtime state.
 */
export function createSettlementDependencyStore(target: Record<string, string[]>) {
  const revisions = new Map<string, number>();

  function normalized(sessionId: string, childIds: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of childIds) {
      const id = typeof value === "string" ? value.trim() : "";
      if (!id || id === sessionId || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function applyReport(sessionIdValue: unknown, childIds: readonly unknown[]): boolean {
    const sessionId = typeof sessionIdValue === "string" ? sessionIdValue.trim() : "";
    if (!sessionId) return false;
    revisions.set(sessionId, (revisions.get(sessionId) || 0) + 1);
    target[sessionId] = normalized(sessionId, childIds);
    return true;
  }

  function beginSnapshot(sessionIdValue: unknown): SettlementDependencySnapshot | undefined {
    const sessionId = typeof sessionIdValue === "string" ? sessionIdValue.trim() : "";
    if (!sessionId) return undefined;
    return { sessionId, revision: revisions.get(sessionId) || 0 };
  }

  function applySnapshot(snapshot: SettlementDependencySnapshot, childIds: readonly unknown[]): boolean {
    if ((revisions.get(snapshot.sessionId) || 0) !== snapshot.revision) return false;
    target[snapshot.sessionId] = normalized(snapshot.sessionId, childIds);
    return true;
  }

  async function hydrate(
    sessionId: string,
    load: () => Promise<readonly unknown[]>,
  ): Promise<boolean> {
    const snapshot = beginSnapshot(sessionId);
    if (!snapshot) return false;
    const childIds = await load();
    return applySnapshot(snapshot, childIds);
  }

  return { applyReport, beginSnapshot, applySnapshot, hydrate };
}
