/**
 * Pure spawn-worker lineage for the session drawer.
 *
 * The forest is intentionally built from the complete session list before the
 * caller groups folders, applies its eight-primary-session preview, or renders
 * filters. Only exact `kind === "spawn"` origins create worker relationships.
 */

export type WorkerBranchSession = { id: string };

export type WorkerBranchOrigin = {
  sessionId: string;
  originSessionId: string;
  kind: string;
};

export type WorkerNodeRole = "primary" | "worker";
export type UnattachedWorkerReason = "missing-parent" | "self-parent" | "cycle";

/** One immutable-by-convention node in the complete worker forest. */
export type WorkerBranch<T extends WorkerBranchSession> = {
  id: string;
  item: T;
  role: WorkerNodeRole;
  /** Effective parent after malformed edges and cycles have been removed. */
  parentId?: string;
  /** Parent recorded by the first exact spawn origin, even when it is invalid. */
  originParentId?: string;
  /** Present only on a worker promoted to an unattached tree root. */
  unattachedReason?: UnattachedWorkerReason;
  isRunning: boolean;
  children: readonly WorkerBranch<T>[];
  /** All worker descendants, not including this node itself. */
  descendantWorkerCount: number;
  /** Running worker descendants, not including this node itself. */
  runningDescendantWorkerCount: number;
};

export type SpawnWorkerForest<T extends WorkerBranchSession> = {
  /** Ordinary sessions. These are the only entries that consume preview slots. */
  roots: readonly WorkerBranch<T>[];
  /** Trees whose root is a worker with no usable parent in this session list. */
  unattachedWorkers: readonly WorkerBranch<T>[];
  primarySessionCount: number;
  workerSessionCount: number;
};

export type BuildSpawnWorkerForestOptions<T extends WorkerBranchSession> = {
  isRunning?: (item: T) => boolean;
};

export type WorkerBranchView<T extends WorkerBranchSession> = {
  node: WorkerBranch<T>;
  /** Children retained by the current filter, whether or not currently expanded. */
  children: readonly WorkerBranchView<T>[];
  selfMatches: boolean;
  /** The node failed the filter but is retained as an ancestor of a match. */
  contextOnly: boolean;
  manuallyExpanded: boolean;
  /** Expansion needed to reveal a retained match or explicitly forced descendant. */
  forcedExpanded: boolean;
  expanded: boolean;
};

export type WorkerBranchViewForest<T extends WorkerBranchSession> = {
  roots: readonly WorkerBranchView<T>[];
  unattachedWorkers: readonly WorkerBranchView<T>[];
  /** Sessions satisfying the predicate; excludes retained context ancestors. */
  matchedSessionCount: number;
  /** Sessions in the derived view, including retained context ancestors. */
  visibleSessionCount: number;
  primarySessionCount: number;
  workerSessionCount: number;
};

export type DeriveWorkerBranchViewOptions<T extends WorkerBranchSession> = {
  /** Omit to derive the unfiltered forest. */
  matches?: (item: T) => boolean;
  /** Parent session ids explicitly expanded by the user. */
  expandedParentIds?: ReadonlySet<string>;
  /** Active/search-result ids whose ancestor path must be expanded. */
  forceExpandedSessionIds?: ReadonlySet<string>;
};

type MutableNode<T extends WorkerBranchSession> = {
  id: string;
  item: T;
  index: number;
  role: WorkerNodeRole;
  originParentId?: string;
  parentId?: string;
  unattachedReason?: UnattachedWorkerReason;
  isRunning: boolean;
  children: MutableNode<T>[];
};

/**
 * Build a complete, stable spawn-worker forest.
 *
 * Session ids must be unique and non-empty. Duplicate spawn-origin rows are
 * resolved deterministically: the first exact spawn origin for a session wins.
 * A cycle is broken at its earliest session-list member, which becomes the root
 * of one unattached worker tree; no session is discarded.
 */
export function buildSpawnWorkerForest<T extends WorkerBranchSession>(
  sessions: readonly T[],
  origins: readonly WorkerBranchOrigin[],
  options: BuildSpawnWorkerForestOptions<T> = {},
): SpawnWorkerForest<T> {
  const byId = new Map<string, MutableNode<T>>();
  const nodes: MutableNode<T>[] = [];

  sessions.forEach((item, index) => {
    if (!item.id) throw new Error("Worker forest session ids must be non-empty");
    if (byId.has(item.id)) throw new Error(`Duplicate session id in worker forest: ${item.id}`);
    const node: MutableNode<T> = {
      id: item.id,
      item,
      index,
      role: "primary",
      isRunning: Boolean(options.isRunning?.(item)),
      children: [],
    };
    nodes.push(node);
    byId.set(item.id, node);
  });

  // Ignore non-spawn provenance and origins for sessions absent from this list.
  // The first spawn row wins so malformed duplicate metadata is deterministic.
  const spawnParentByWorker = new Map<string, string>();
  for (const origin of origins) {
    if (origin.kind !== "spawn" || !byId.has(origin.sessionId) || spawnParentByWorker.has(origin.sessionId)) continue;
    spawnParentByWorker.set(origin.sessionId, origin.originSessionId);
  }

  // Candidate edges contain only existing, non-self parents. Invalid worker
  // origins still mark the session as a worker and become unattached roots.
  const candidateParentByWorker = new Map<string, string>();
  for (const node of nodes) {
    const originParentId = spawnParentByWorker.get(node.id);
    if (originParentId === undefined) continue;
    node.role = "worker";
    node.originParentId = originParentId;
    if (originParentId === node.id) {
      node.unattachedReason = "self-parent";
    } else if (!byId.has(originParentId)) {
      node.unattachedReason = "missing-parent";
    } else {
      candidateParentByWorker.set(node.id, originParentId);
    }
  }

  // The candidate graph is functional (at most one parent per worker). Walk it
  // iteratively so arbitrarily deep lineages do not depend on the call stack.
  const completed = new Set<string>();
  for (const start of nodes) {
    if (completed.has(start.id)) continue;
    const path: string[] = [];
    const indexInPath = new Map<string, number>();
    let currentId: string | undefined = start.id;

    while (currentId !== undefined && !completed.has(currentId)) {
      const cycleStart = indexInPath.get(currentId);
      if (cycleStart !== undefined) {
        const cycleIds = path.slice(cycleStart);
        let anchor = byId.get(cycleIds[0])!;
        for (const id of cycleIds.slice(1)) {
          const candidate = byId.get(id)!;
          if (candidate.index < anchor.index) anchor = candidate;
        }
        candidateParentByWorker.delete(anchor.id);
        anchor.unattachedReason = "cycle";
        break;
      }
      indexInPath.set(currentId, path.length);
      path.push(currentId);
      currentId = candidateParentByWorker.get(currentId);
    }

    for (const id of path) completed.add(id);
  }

  const roots: MutableNode<T>[] = [];
  const unattachedWorkers: MutableNode<T>[] = [];
  let workerSessionCount = 0;
  for (const node of nodes) {
    if (node.role === "primary") {
      roots.push(node);
      continue;
    }
    workerSessionCount += 1;
    const parentId = candidateParentByWorker.get(node.id);
    if (parentId !== undefined) {
      node.parentId = parentId;
      byId.get(parentId)!.children.push(node);
    } else {
      // All absent effective edges have a reason, but retain a defensive
      // fallback in case future validation introduces another invalid shape.
      node.unattachedReason ??= "missing-parent";
      unattachedWorkers.push(node);
    }
  }

  // Materialize readonly result nodes bottom-up without recursive traversal.
  const materialized = new Map<string, WorkerBranch<T>>();
  const topLevel = [...roots, ...unattachedWorkers];
  const stack: Array<{ node: MutableNode<T>; visited: boolean }> = [];
  for (let index = topLevel.length - 1; index >= 0; index -= 1) {
    stack.push({ node: topLevel[index], visited: false });
  }
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (!entry.visited) {
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: entry.node.children[index], visited: false });
      }
      continue;
    }

    const children = entry.node.children.map((child) => materialized.get(child.id)!);
    let descendantWorkerCount = 0;
    let runningDescendantWorkerCount = 0;
    for (const child of children) {
      descendantWorkerCount += 1 + child.descendantWorkerCount;
      runningDescendantWorkerCount += (child.isRunning ? 1 : 0) + child.runningDescendantWorkerCount;
    }
    materialized.set(entry.node.id, {
      id: entry.node.id,
      item: entry.node.item,
      role: entry.node.role,
      ...(entry.node.parentId ? { parentId: entry.node.parentId } : {}),
      ...(entry.node.originParentId !== undefined ? { originParentId: entry.node.originParentId } : {}),
      ...(entry.node.unattachedReason ? { unattachedReason: entry.node.unattachedReason } : {}),
      isRunning: entry.node.isRunning,
      children,
      descendantWorkerCount,
      runningDescendantWorkerCount,
    });
  }

  return {
    roots: roots.map((node) => materialized.get(node.id)!),
    unattachedWorkers: unattachedWorkers.map((node) => materialized.get(node.id)!),
    primarySessionCount: roots.length,
    workerSessionCount,
  };
}

type DerivedNode<T extends WorkerBranchSession> = {
  view?: WorkerBranchView<T>;
  containsForcedSession: boolean;
  selfMatches: boolean;
};

/**
 * Derive a renderable branch view without mutating the complete forest.
 *
 * When a filter is supplied, only matches and the ancestor paths needed to
 * reach them remain. Those ancestor branches are forced open. Independently,
 * active/search ids can force their ancestor path open in an unfiltered view.
 */
export function deriveWorkerBranchView<T extends WorkerBranchSession>(
  forest: SpawnWorkerForest<T>,
  options: DeriveWorkerBranchViewOptions<T> = {},
): WorkerBranchViewForest<T> {
  const expandedParentIds = options.expandedParentIds ?? new Set<string>();
  const forceExpandedSessionIds = options.forceExpandedSessionIds ?? new Set<string>();
  const filtering = options.matches !== undefined;
  const derived = new Map<string, DerivedNode<T>>();
  const topLevel = [...forest.roots, ...forest.unattachedWorkers];
  const stack: Array<{ node: WorkerBranch<T>; visited: boolean }> = [];
  for (let index = topLevel.length - 1; index >= 0; index -= 1) {
    stack.push({ node: topLevel[index], visited: false });
  }

  let matchedSessionCount = 0;
  let visibleSessionCount = 0;
  let primarySessionCount = 0;
  let workerSessionCount = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (!entry.visited) {
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: entry.node.children[index], visited: false });
      }
      continue;
    }

    const selfMatches = filtering ? Boolean(options.matches!(entry.node.item)) : true;
    if (selfMatches) matchedSessionCount += 1;
    const childResults = entry.node.children.map((child) => derived.get(child.id)!);
    const children = childResults.flatMap((result) => result.view ? [result.view] : []);
    const included = !filtering || selfMatches || children.length > 0;
    const containsForcedSession = included && (
      forceExpandedSessionIds.has(entry.node.id)
      || childResults.some((result) => result.view && result.containsForcedSession)
    );

    if (!included) {
      derived.set(entry.node.id, { containsForcedSession: false, selfMatches });
      continue;
    }

    const manuallyExpanded = expandedParentIds.has(entry.node.id);
    const forcedByRetainedMatch = filtering && children.length > 0;
    const forcedByExplicitDescendant = childResults.some((result) => result.view && result.containsForcedSession);
    const forcedExpanded = forcedByRetainedMatch || forcedByExplicitDescendant;
    const expanded = children.length > 0 && (manuallyExpanded || forcedExpanded);
    const view: WorkerBranchView<T> = {
      node: entry.node,
      children,
      selfMatches,
      contextOnly: filtering && !selfMatches,
      manuallyExpanded,
      forcedExpanded,
      expanded,
    };
    derived.set(entry.node.id, { view, containsForcedSession, selfMatches });
    visibleSessionCount += 1;
    if (entry.node.role === "primary") primarySessionCount += 1;
    else workerSessionCount += 1;
  }

  return {
    roots: forest.roots.flatMap((node) => {
      const view = derived.get(node.id)!.view;
      return view ? [view] : [];
    }),
    unattachedWorkers: forest.unattachedWorkers.flatMap((node) => {
      const view = derived.get(node.id)!.view;
      return view ? [view] : [];
    }),
    matchedSessionCount,
    visibleSessionCount,
    primarySessionCount,
    workerSessionCount,
  };
}
