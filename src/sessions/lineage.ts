/**
 * Pure derived-state helpers for the session drawer.
 *
 * Extracted from the drawer so the rules that decide what a user sees — which
 * sessions are listed, and which single indicator each one shows — are testable
 * without a DOM. The drawer supplies the lookups; these functions hold the rules.
 */

export type LineageItem = { id: string };

export type SessionIndicatorKind = "running" | "waiting" | "unread" | "none";

/**
 * Order a list so that sessions spawned by another session follow their parent.
 *
 * Handles arbitrarily deep lineage (a child of a child) and is defensive about
 * malformed data: origins are client-asserted, so cycles are possible, and a
 * session must NEVER disappear from the list because of them. Anything not
 * reached by the walk is appended in its original relative order.
 */
export function orderItemsWithChildren<T extends LineageItem>(
  items: T[],
  parentOf: (id: string) => string | undefined,
): T[] {
  const ids = new Set(items.map((item) => item.id));
  const childrenByParent = new Map<string, T[]>();
  const deferred = new Set<string>();

  for (const item of items) {
    const parent = parentOf(item.id);
    // Self-parenting and parents outside this list leave the item where it is.
    if (!parent || parent === item.id || !ids.has(parent)) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(item);
    else childrenByParent.set(parent, [item]);
    deferred.add(item.id);
  }
  if (deferred.size === 0) return items;

  const result: T[] = [];
  const emitted = new Set<string>();

  const emitWithDescendants = (root: T) => {
    if (emitted.has(root.id)) return;
    emitted.add(root.id);
    result.push(root);
    // Iterative depth-first walk: a stack, not one level of nesting, so
    // grandchildren and deeper are never dropped.
    const stack = [...(childrenByParent.get(root.id) ?? [])].reverse();
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (emitted.has(child.id)) continue; // cycle guard
      emitted.add(child.id);
      result.push(child);
      const grandchildren = childrenByParent.get(child.id) ?? [];
      for (let i = grandchildren.length - 1; i >= 0; i -= 1) stack.push(grandchildren[i]);
    }
  };

  for (const item of items) {
    if (deferred.has(item.id)) continue; // start from roots only
    emitWithDescendants(item);
  }

  // Safety net: a pure cycle has no root, so nothing above would emit it.
  // Losing a session from the drawer is far worse than imperfect ordering.
  if (emitted.size !== items.length) {
    for (const item of items) {
      if (!emitted.has(item.id)) result.push(item);
    }
  }
  return result;
}

/**
 * Single precedence rule for per-session indicators: running > waiting > unread.
 * Exactly one indicator is shown per session, everywhere (tabs and drawer rows).
 */
export function sessionIndicatorKind(state: {
  running?: boolean;
  waiting?: boolean;
  unread?: boolean;
}): SessionIndicatorKind {
  if (state.running) return "running";
  if (state.waiting) return "waiting";
  if (state.unread) return "unread";
  return "none";
}

/**
 * Sessions this one spawned that are still running. A session is only "waiting"
 * when it is itself idle: a running session shows its own progress instead.
 */
export function runningChildIdsOf(
  sessionId: string,
  origins: Array<{ sessionId: string; originSessionId: string }>,
  isRunning: (id: string) => boolean,
): string[] {
  if (!sessionId) return [];
  const seen = new Set<string>();
  const running: string[] = [];
  for (const origin of origins) {
    if (origin.originSessionId !== sessionId) continue;
    const childId = origin.sessionId;
    if (!childId || childId === sessionId || seen.has(childId)) continue;
    seen.add(childId);
    if (isRunning(childId)) running.push(childId);
  }
  return running;
}

export type WaitingSession = { sessionId: string; name: string; cwd?: string };
export type WaitingInfo = { count: number; names: string[]; sessions: WaitingSession[] };

/**
 * Derived "waiting on spawned sessions" state for one session: it is idle, but
 * sessions it spawned are still running. Returns the running children so the UI
 * can link to each of them, not merely name them.
 */
export function waitingInfoFrom(
  sessionId: string,
  origins: Array<{ sessionId: string; originSessionId: string }>,
  lookups: {
    isRunning: (id: string) => boolean;
    selfRunning: boolean;
    describe: (id: string) => { name?: string; cwd?: string };
  },
): WaitingInfo | undefined {
  // A running session shows its own progress instead of what it is waiting for.
  if (!sessionId || lookups.selfRunning) return undefined;
  const running = runningChildIdsOf(sessionId, origins, lookups.isRunning);
  if (running.length === 0) return undefined;

  const sessions: WaitingSession[] = running.map((childId) => {
    const described = lookups.describe(childId) || {};
    const name = (described.name || "").trim() || childId.slice(-8);
    return { sessionId: childId, name, cwd: described.cwd };
  });
  return { count: sessions.length, names: sessions.map((session) => session.name), sessions };
}
