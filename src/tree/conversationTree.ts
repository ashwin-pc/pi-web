import type { ApiClient } from "../app/api.js";
import { blurActiveEditableOnMobile } from "../app/focus.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import type { ComposerController } from "../composer/composer.js";
import type { RightPanelManager } from "../layout/rightPanel.js";

export type ConversationTreeController = {
  init: () => void;
  isOpen: () => boolean;
  refreshTree: () => Promise<void>;
  setOpen: (open: boolean) => void;
};

type ConversationTreeNode = {
  id: string;
  parentId: string | null;
  type: string;
  role: string;
  preview: string;
  timestamp: string;
  label?: string;
  labelTimestamp?: string;
  childCount: number;
  isOnActivePath: boolean;
  isCurrentLeaf: boolean;
  children: ConversationTreeNode[];
};

type ConversationTreeResponse = {
  ok: boolean;
  sessionId: string;
  leafId: string | null;
  activePathIds: string[];
  entryCount: number;
  branchPointCount: number;
  nodes: ConversationTreeNode[];
};

type FilterMode = "default" | "no-tools" | "user" | "labeled" | "all";

type NavigateOptions = {
  summarize?: boolean;
  customInstructions?: string;
};

type ConversationGraphRow = {
  node: ConversationTreeNode;
  lane: number;
  depth: number;
  hasActiveSubtree: boolean;
  parentId?: string;
  branchIndex?: number;
  branchCount?: number;
  element?: HTMLButtonElement;
};

type ConversationGraphFrame = {
  node: ConversationTreeNode;
  lane: number;
  depth: number;
  parentId?: string;
  branchIndex?: number;
  branchCount?: number;
};

const svgNamespace = "http://www.w3.org/2000/svg";
const graphLaneGap = 18;
const graphNodeOffset = 12;
const graphNodePadding = 14;
const graphColours = ["#7dd3fc", "#a78bfa", "#fbbf24", "#34d399", "#fb7185", "#60a5fa"];

function roleLabel(role: string, type: string) {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "toolCall": return "tool";
    case "toolResult": return "result";
    case "branchSummary": return "summary";
    case "compaction": return "compact";
    case "error": return "error";
    case "model": return "model";
    case "thinking": return "thinking";
    case "session": return "session";
    case "label": return "label";
    case "custom": return "custom";
    default: return type.replace(/_/g, " ");
  }
}

function formatTimestamp(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function projectTree(nodes: ConversationTreeNode[], mode: FilterMode): ConversationTreeNode[] {
  const projectedByNode = new Map<ConversationTreeNode, ConversationTreeNode[]>();
  const stack = nodes.map((node) => ({ node, visited: false }));
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children || [];
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], visited: false });
      continue;
    }
    const projectedChildren = children.flatMap((child) => projectedByNode.get(child) || []);
    projectedByNode.set(
      frame.node,
      matchesFilter(frame.node, mode)
        ? [{ ...frame.node, children: projectedChildren, childCount: projectedChildren.length }]
        : projectedChildren,
    );
  }
  return nodes.flatMap((node) => projectedByNode.get(node) || []);
}

function countVisibleNodes(nodes: ConversationTreeNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    for (const child of node.children || []) stack.push(child);
  }
  return count;
}

function collectVisibleIds(nodes: ConversationTreeNode[], ids = new Set<string>()) {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ids.add(node.id);
    for (const child of node.children || []) stack.push(child);
  }
  return ids;
}

function searchTree(nodes: ConversationTreeNode[], query: string): ConversationTreeNode[] {
  if (!query) return nodes;
  const matchesByNode = new Map<ConversationTreeNode, ConversationTreeNode[]>();
  const stack = nodes.map((node) => ({ node, visited: false }));
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children || [];
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], visited: false });
      continue;
    }
    const matchedChildren = children.flatMap((child) => matchesByNode.get(child) || []);
    matchesByNode.set(
      frame.node,
      matchesSearch(frame.node, query) || matchedChildren.length > 0
        ? [{ ...frame.node, children: matchedChildren, childCount: matchedChildren.length }]
        : [],
    );
  }
  return nodes.flatMap((node) => matchesByNode.get(node) || []);
}

function findNode(nodes: ConversationTreeNode[], id: string): ConversationTreeNode | undefined {
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return undefined;
}

function treeFromFlatNodes(nodes: ConversationTreeNode[]): ConversationTreeNode[] {
  const byId = new Map<string, ConversationTreeNode>();
  const roots: ConversationTreeNode[] = [];
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });
  for (const node of nodes) {
    const copy = byId.get(node.id)!;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(copy);
    else roots.push(copy);
  }
  for (const node of byId.values()) node.childCount = node.children.length;
  return roots;
}

function isToolNode(node: ConversationTreeNode) {
  return node.role === "toolCall" || node.role === "toolResult";
}

function isConversationNode(node: ConversationTreeNode) {
  return ["user", "assistant", "branchSummary", "compaction", "custom"].includes(node.role);
}

function matchesFilter(node: ConversationTreeNode, mode: FilterMode) {
  if (mode === "all") return true;
  if (mode === "user") return node.role === "user" || node.role === "custom";
  if (mode === "labeled") return Boolean(node.label);
  if (mode === "no-tools") return !isToolNode(node) && node.role !== "label" && node.role !== "error";
  return isConversationNode(node);
}

function matchesSearch(node: ConversationTreeNode, query: string) {
  if (!query) return true;
  const haystack = `${node.preview} ${node.label || ""} ${roleLabel(node.role, node.type)} ${node.id}`.toLowerCase();
  return haystack.includes(query);
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 700px)").matches;
}

function plural(value: number, singular: string, pluralValue = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

function activeSubtreeMap(nodes: ConversationTreeNode[]): Map<ConversationTreeNode, boolean> {
  const activeByNode = new Map<ConversationTreeNode, boolean>();
  const stack = nodes.map((node) => ({ node, visited: false }));
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children || [];
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], visited: false });
      continue;
    }
    activeByNode.set(frame.node, frame.node.isOnActivePath || children.some((child) => activeByNode.get(child)));
  }
  return activeByNode;
}

function subtreeHasActivePath(node: ConversationTreeNode): boolean {
  return activeSubtreeMap([node]).get(node) || false;
}

function graphLaneX(lane: number) {
  return graphNodeOffset + lane * graphLaneGap;
}

function graphColour(lane: number) {
  return graphColours[Math.max(0, lane) % graphColours.length];
}

function flattenGraphRows(nodes: ConversationTreeNode[]) {
  const rows: ConversationGraphRow[] = [];
  const activeByNode = activeSubtreeMap(nodes);
  const stack: ConversationGraphFrame[] = [...nodes].reverse().map((node) => ({ node, lane: 0, depth: 0 }));

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const row: ConversationGraphRow = {
      node: frame.node,
      lane: frame.lane,
      depth: frame.depth,
      hasActiveSubtree: activeByNode.get(frame.node) || false,
      ...(frame.parentId ? { parentId: frame.parentId } : {}),
      ...(frame.branchIndex && frame.branchCount ? { branchIndex: frame.branchIndex, branchCount: frame.branchCount } : {}),
    };
    rows.push(row);

    const children = frame.node.children || [];
    if (children.length === 0) continue;
    if (children.length === 1) {
      stack.push({ node: children[0], lane: frame.lane, depth: frame.depth + 1, parentId: frame.node.id });
      continue;
    }

    const activeIndex = Math.max(0, children.findIndex((child) => activeByNode.get(child)));
    const childLanes = children.map((_, index) => frame.lane + index + 1);
    childLanes[activeIndex] = frame.lane;
    let nextLane = frame.lane + 1;
    for (let index = 0; index < children.length; index += 1) {
      if (index !== activeIndex) childLanes[index] = nextLane++;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        lane: childLanes[index],
        depth: frame.depth + 1,
        parentId: frame.node.id,
        branchIndex: index + 1,
        branchCount: children.length,
      });
    }
  }

  return rows;
}

export function createConversationTree(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  composer: ComposerController;
  updateMeta: (data: any) => void;
  refreshMessages: () => Promise<void>;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): ConversationTreeController {
  const { state, elements, api, composer, updateMeta, refreshMessages, addMessage } = options;

  let treeData: ConversationTreeResponse | null = null;
  let selectedId = "";
  let loading = false;

  const backdrop = document.createElement("div");
  backdrop.className = "conversationTreeBackdrop";
  backdrop.hidden = true;

  const panel = document.createElement("aside");
  panel.className = "conversationTreePanel";
  panel.setAttribute("aria-label", "Conversation tree");
  panel.hidden = true;

  const header = document.createElement("div");
  header.className = "conversationTreeHeader";
  const title = document.createElement("div");
  title.className = "conversationTreeTitle";
  const h2 = document.createElement("h2");
  h2.textContent = "Conversation tree";
  const summary = document.createElement("span");
  summary.className = "conversationTreeSummary";
  title.append(h2, summary);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "iconButton conversationTreeCloseButton";
  closeButton.title = "Close conversation tree";
  closeButton.setAttribute("aria-label", closeButton.title);
  closeButton.textContent = "×";
  header.append(title, closeButton);

  const controls = document.createElement("div");
  controls.className = "conversationTreeControls";
  const search = document.createElement("input");
  search.className = "conversationTreeSearch";
  search.type = "search";
  search.placeholder = "Search tree";
  search.setAttribute("aria-label", "Search conversation tree");
  const filter = document.createElement("select");
  filter.className = "conversationTreeFilter";
  filter.setAttribute("aria-label", "Conversation tree filter");
  const filters: Array<[FilterMode, string]> = [
    ["default", "Default"],
    ["no-tools", "No tools"],
    ["user", "User only"],
    ["labeled", "Labeled"],
    ["all", "All entries"],
  ];
  for (const [value, label] of filters) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filter.append(option);
  }
  controls.append(search, filter);

  const status = document.createElement("div");
  status.className = "conversationTreeStatus";
  status.setAttribute("aria-live", "polite");

  const list = document.createElement("div");
  list.className = "conversationTreeList";
  list.setAttribute("role", "tree");

  const selection = document.createElement("div");
  selection.className = "conversationTreeSelection";
  selection.hidden = true;
  const selectionText = document.createElement("div");
  selectionText.className = "conversationTreeSelectionText";
  const selectionTitle = document.createElement("strong");
  const selectionMeta = document.createElement("span");
  selectionText.append(selectionTitle, selectionMeta);
  const selectionActions = document.createElement("div");
  selectionActions.className = "conversationTreeSelectionActions";
  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "primaryAction conversationTreeJumpButton";
  jumpButton.textContent = "Jump here";
  const summaryButton = document.createElement("button");
  summaryButton.type = "button";
  summaryButton.className = "conversationTreeSummaryButton";
  summaryButton.textContent = "Summarize & jump";
  const customButton = document.createElement("button");
  customButton.type = "button";
  customButton.className = "conversationTreeCustomButton";
  customButton.textContent = "Custom focus…";
  selectionActions.append(jumpButton, summaryButton, customButton);

  const customForm = document.createElement("div");
  customForm.className = "conversationTreeCustomForm";
  customForm.hidden = true;
  const customLabel = document.createElement("label");
  customLabel.textContent = "Summary focus";
  const customInstructions = document.createElement("textarea");
  customInstructions.rows = 3;
  customInstructions.placeholder = "What should the branch summary preserve?";
  customLabel.append(customInstructions);
  const customActions = document.createElement("div");
  customActions.className = "conversationTreeCustomActions";
  const customCancel = document.createElement("button");
  customCancel.type = "button";
  customCancel.textContent = "Cancel";
  const customSubmit = document.createElement("button");
  customSubmit.type = "button";
  customSubmit.className = "primaryAction";
  customSubmit.textContent = "Summarize & jump";
  customActions.append(customCancel, customSubmit);
  customForm.append(customLabel, customActions);

  selection.append(selectionText, selectionActions, customForm);
  panel.append(header, controls, status, list, selection);
  document.body.append(backdrop, panel);

  function setStatus(message: string, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function isOpen() {
    return !panel.hidden;
  }

  function selectedNode() {
    return selectedId && treeData ? findNode(treeData.nodes, selectedId) : undefined;
  }

  function setLoading(next: boolean) {
    loading = next;
    panel.classList.toggle("loading", loading);
    renderSelection();
  }

  function renderSummary(visibleCount?: number) {
    if (!treeData) {
      summary.textContent = "";
      return;
    }
    const parts = typeof visibleCount === "number" && visibleCount !== treeData.entryCount
      ? [`${visibleCount} shown`, plural(treeData.entryCount, "entry", "entries")]
      : [plural(treeData.entryCount, "entry", "entries")];
    if (treeData.branchPointCount > 0) parts.push(plural(treeData.branchPointCount, "branch point"));
    summary.textContent = parts.join(" · ");
  }

  function renderSelection(visibleIds?: Set<string>) {
    const node = selectedNode();
    selection.hidden = !node || Boolean(visibleIds && !visibleIds.has(node.id));
    if (!node || selection.hidden) return;

    const label = roleLabel(node.role, node.type);
    selectionTitle.textContent = `${label}: ${node.preview || node.id}`;
    const meta = [formatTimestamp(node.timestamp), node.label ? `#${node.label}` : "", node.isCurrentLeaf ? "current position" : ""].filter(Boolean).join(" · ");
    selectionMeta.textContent = meta;

    const actionText = node.role === "user" || node.role === "custom" ? "Edit from here" : "Continue from here";
    jumpButton.textContent = node.isCurrentLeaf ? "Current position" : actionText;
    jumpButton.disabled = loading || state.isStreaming || node.isCurrentLeaf;
    summaryButton.disabled = loading || state.isStreaming || node.isCurrentLeaf;
    customButton.disabled = loading || state.isStreaming || node.isCurrentLeaf;
    summaryButton.hidden = node.isCurrentLeaf;
    customButton.hidden = node.isCurrentLeaf;
  }

  function createRow(graphRow: ConversationGraphRow, graphWidth: number) {
    const { node } = graphRow;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "conversationTreeNode";
    row.classList.toggle("selected", node.id === selectedId);
    row.classList.toggle("activePath", node.isOnActivePath);
    row.classList.toggle("currentLeaf", node.isCurrentLeaf);
    row.classList.toggle("inactivePath", !node.isOnActivePath);
    row.classList.toggle("toolEntry", isToolNode(node));
    row.classList.toggle("branchPoint", node.childCount > 1);
    row.classList.toggle("branchStart", Boolean(graphRow.branchCount));
    row.style.setProperty("--tree-graph-width", `${graphWidth}px`);
    row.style.setProperty("--tree-node-x", `${graphLaneX(graphRow.lane)}px`);
    row.style.setProperty("--tree-node-color", graphColour(graphRow.lane));
    row.dataset.nodeId = node.id;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(graphRow.depth + 1));
    row.setAttribute("aria-selected", String(node.id === selectedId));
    if (node.isCurrentLeaf) row.setAttribute("aria-current", "true");

    const rail = document.createElement("span");
    rail.className = "conversationTreeRail";
    const glyph = document.createElement("span");
    glyph.className = `conversationTreeGlyph ${node.role}`;
    rail.append(glyph);

    const main = document.createElement("span");
    main.className = "conversationTreeNodeMain";
    const top = document.createElement("span");
    top.className = "conversationTreeNodeTop";
    const role = document.createElement("span");
    role.className = `conversationTreeRole ${node.role}`;
    role.textContent = `${roleLabel(node.role, node.type)}:`;
    const time = document.createElement("span");
    time.className = "conversationTreeTime";
    time.textContent = formatTimestamp(node.timestamp);
    top.append(role, time);

    const preview = document.createElement("span");
    preview.className = "conversationTreePreview";
    preview.textContent = node.preview || node.type.replace(/_/g, " ");

    const badges = document.createElement("span");
    badges.className = "conversationTreeBadges";
    if (graphRow.branchIndex && graphRow.branchCount) {
      const branch = document.createElement("span");
      branch.className = `conversationTreeBadge branchLane${graphRow.hasActiveSubtree ? " current" : " alternate"}`;
      branch.textContent = graphRow.hasActiveSubtree ? `branch ${graphRow.branchIndex} · current` : `branch ${graphRow.branchIndex}`;
      branch.title = `${graphRow.hasActiveSubtree ? "Current" : "Alternate"} branch ${graphRow.branchIndex} of ${graphRow.branchCount}`;
      badges.append(branch);
    }
    if (node.label) {
      const label = document.createElement("span");
      label.className = "conversationTreeBadge label";
      label.textContent = node.label;
      badges.append(label);
    }
    if (node.childCount > 1) {
      const branches = document.createElement("span");
      branches.className = "conversationTreeBadge branch";
      branches.textContent = `${node.childCount} branches`;
      branches.title = "This entry splits into multiple conversation branches";
      badges.append(branches);
    }
    if (node.isCurrentLeaf) {
      const current = document.createElement("span");
      current.className = "conversationTreeBadge current";
      current.textContent = "current";
      badges.append(current);
    }

    main.append(top, preview);
    if (badges.children.length) main.append(badges);
    row.append(rail, main);
    row.addEventListener("click", () => {
      selectedId = node.id;
      customForm.hidden = true;
      renderTree();
    });
    return row;
  }

  function appendGraphPath(svg: SVGElement, d: string, row: ConversationGraphRow) {
    const shadow = document.createElementNS(svgNamespace, "path");
    shadow.setAttribute("class", "conversationTreeGraphPathShadow");
    shadow.setAttribute("d", d);
    svg.append(shadow);

    const line = document.createElementNS(svgNamespace, "path");
    line.setAttribute("class", `conversationTreeGraphPath${row.hasActiveSubtree ? " activePath" : " inactivePath"}`);
    line.setAttribute("d", d);
    line.style.stroke = graphColour(row.lane);
    svg.append(line);
  }

  function drawConversationGraph(svg: SVGElement, graph: HTMLElement, rows: ConversationGraphRow[], width: number) {
    svg.textContent = "";
    const graphRect = graph.getBoundingClientRect();
    const height = Math.max(graph.scrollHeight, graphRect.height);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const positions = new Map<string, { x: number; y: number }>();
    for (const row of rows) {
      if (!row.element) continue;
      const rect = row.element.getBoundingClientRect();
      positions.set(row.node.id, {
        x: graphLaneX(row.lane),
        y: rect.top - graphRect.top + rect.height / 2,
      });
    }

    for (const row of rows) {
      if (!row.parentId) continue;
      const parent = positions.get(row.parentId);
      const child = positions.get(row.node.id);
      if (!parent || !child) continue;
      const distance = Math.max(0, child.y - parent.y);
      const transition = Math.min(22, Math.max(10, distance * 0.28));
      const elbowY = Math.min(child.y, parent.y + transition);
      const d = parent.x === child.x
        ? `M${parent.x},${parent.y.toFixed(1)}L${child.x},${child.y.toFixed(1)}`
        : `M${parent.x},${parent.y.toFixed(1)}C${parent.x},${(parent.y + transition * 0.55).toFixed(1)} ${child.x},${(elbowY - transition * 0.35).toFixed(1)} ${child.x},${elbowY.toFixed(1)}L${child.x},${child.y.toFixed(1)}`;
      appendGraphPath(svg, d, row);
    }

    for (const row of rows) {
      const position = positions.get(row.node.id);
      if (!position) continue;
      const node = document.createElementNS(svgNamespace, "circle");
      node.setAttribute("class", `conversationTreeGraphNode ${row.node.role}${row.node.isCurrentLeaf ? " currentLeaf" : ""}${row.node.isOnActivePath ? " activePath" : " inactivePath"}`);
      node.setAttribute("cx", String(position.x));
      node.setAttribute("cy", position.y.toFixed(1));
      node.setAttribute("r", row.node.isCurrentLeaf ? "5" : "4.2");
      node.style.fill = row.node.isCurrentLeaf ? "var(--tree-panel-bg)" : graphColour(row.lane);
      node.style.stroke = graphColour(row.lane);
      svg.append(node);
    }
  }

  function renderNodes(nodes: ConversationTreeNode[], container: HTMLElement) {
    const rows = flattenGraphRows(nodes);
    const maxLane = rows.reduce((max, row) => Math.max(max, row.lane), 0);
    const graphWidth = graphLaneX(maxLane) + graphNodePadding;
    const graph = document.createElement("div");
    graph.className = "conversationTreeGraph";
    graph.style.setProperty("--tree-graph-width", `${graphWidth}px`);

    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("class", "conversationTreeGraphSvg");
    svg.setAttribute("aria-hidden", "true");

    const rowsEl = document.createElement("div");
    rowsEl.className = "conversationTreeGraphRows";
    rowsEl.setAttribute("role", "group");

    for (const graphRow of rows) {
      const row = createRow(graphRow, graphWidth);
      graphRow.element = row;
      rowsEl.append(row);
    }

    graph.append(svg, rowsEl);
    container.append(graph);
    window.requestAnimationFrame(() => drawConversationGraph(svg, graph, rows, graphWidth));
  }

  function renderTree() {
    list.textContent = "";
    const mode = filter.value as FilterMode;
    const projectedTree = treeData ? projectTree(treeData.nodes, mode) : [];
    const query = search.value.trim().toLowerCase();
    const visibleTree = searchTree(projectedTree, query);
    const visibleIds = collectVisibleIds(visibleTree);
    const visibleCount = countVisibleNodes(visibleTree);
    renderSummary(visibleCount);

    if (!treeData) {
      const empty = document.createElement("p");
      empty.className = "conversationTreeEmpty";
      empty.textContent = "Open a session to view its tree.";
      list.append(empty);
      renderSelection(visibleIds);
      return;
    }

    if (visibleCount === 0) {
      const empty = document.createElement("p");
      empty.className = "conversationTreeEmpty";
      empty.textContent = projectedTree.length === 0 ? "No conversation entries yet." : "No entries match the current filter.";
      list.append(empty);
      renderSelection(visibleIds);
      return;
    }

    renderNodes(visibleTree, list);
    renderSelection(visibleIds);
  }

  async function refreshTree() {
    if (!isOpen()) return;
    setStatus("Loading tree…");
    try {
      const query = state.currentSessionId ? `?sessionId=${encodeURIComponent(state.currentSessionId)}` : "";
      const res = await fetch(`/api/session/tree${query}`, { headers: api.headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
      const nextTree = data as ConversationTreeResponse;
      nextTree.nodes = treeFromFlatNodes(nextTree.nodes || []);
      treeData = nextTree;
      if (selectedId && !findNode(nextTree.nodes || [], selectedId)) selectedId = "";
      if (!selectedId && nextTree.leafId) selectedId = nextTree.leafId;
      setStatus(nextTree.entryCount
        ? nextTree.branchPointCount > 0
          ? "Follow the colored graph lines; the current branch is highlighted."
          : "Tap an entry to choose how to continue."
        : "This session has no tree entries yet.");
      renderTree();
    } catch (error) {
      treeData = null;
      setStatus(error instanceof Error ? error.message : String(error), true);
      renderTree();
    }
  }

  async function navigateSelected(navigateOptions: NavigateOptions = {}) {
    const node = selectedNode();
    if (!node || loading || node.isCurrentLeaf) return;
    setLoading(true);
    setStatus(navigateOptions.summarize ? "Summarizing branch and navigating…" : "Navigating…");
    try {
      const res = await fetch("/api/session/tree/navigate", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({
          sessionId: state.currentSessionId,
          targetId: node.id,
          summarize: Boolean(navigateOptions.summarize),
          customInstructions: navigateOptions.customInstructions || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
      if (data.cancelled) {
        setStatus("Navigation cancelled.");
        return;
      }
      if (data.state) {
        updateMeta(data.state);
        state.isStreaming = Boolean(data.state.isStreaming);
      }
      composer.setPromptText(typeof data.editorText === "string" ? data.editorText : "");
      await refreshMessages();
      await refreshTree();
      if (typeof data.editorText === "string") addMessage("system", "Loaded an earlier prompt — edit and send to create a new branch.");
      else setStatus("Moved to the selected point.");
      if (isMobileViewport()) setOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  }

  function setOpen(open: boolean) {
    if (open) blurActiveEditableOnMobile();
    panel.hidden = !open;
    backdrop.hidden = !open;
    document.body.classList.toggle("conversationTreeOpen", open);
    elements.conversationTreeButton.setAttribute("aria-expanded", String(open));
    if (open) {
      refreshTree().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
      if (!isMobileViewport()) search.focus();
    }
  }

  function init() {
    elements.conversationTreeButton.addEventListener("click", () => setOpen(true));
    closeButton.addEventListener("click", () => setOpen(false));
    backdrop.addEventListener("click", () => setOpen(false));
    search.addEventListener("input", renderTree);
    filter.addEventListener("change", renderTree);
    jumpButton.addEventListener("click", () => navigateSelected().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true)));
    summaryButton.addEventListener("click", () => navigateSelected({ summarize: true }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), true)));
    customButton.addEventListener("click", () => {
      customForm.hidden = false;
      customInstructions.focus();
    });
    customCancel.addEventListener("click", () => {
      customForm.hidden = true;
      customInstructions.value = "";
    });
    customSubmit.addEventListener("click", () => navigateSelected({ summarize: true, customInstructions: customInstructions.value.trim() }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), true)));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) setOpen(false);
    });
  }

  return {
    init,
    isOpen,
    refreshTree,
    setOpen,
  };
}
