import type { GitCommit } from "./types.js";

const laneGap = 16;
const railPadding = 8;
const graphColours = ["#7dd3fc", "#a78bfa", "#fbbf24", "#34d399", "#fb7185", "#60a5fa"];
const rowHeight = 40;

export type GitGraphEdge = { from: number; to: number; fromY: number; toY: number; colourLane: number };
export type GitGraphRow = { lane: number; colour: number; edges: GitGraphEdge[] };

type ActiveLane = { hash: string; colour: number };

function firstFreeColour(lanes: ActiveLane[]) {
  const used = new Set(lanes.map((entry) => entry.colour));
  let colour = 0;
  while (used.has(colour)) colour += 1;
  return colour;
}

/** Lay out a reverse-chronological git log, retaining lanes and colours until their commit is reached. */
export function layoutGitGraph(commits: GitCommit[]): { rows: GitGraphRow[]; laneCount: number } {
  let lanes: ActiveLane[] = [];
  let laneCount = 1;
  const rows = commits.map((commit) => {
    let lane = lanes.findIndex((entry) => entry.hash === commit.hash);
    const hasIncomingEdge = lane >= 0;
    if (lane < 0) {
      lane = lanes.length;
      lanes.push({ hash: commit.hash, colour: firstFreeColour(lanes) });
    }
    const before = [...lanes];
    const current = before[lane];
    const after = before.filter((entry) => entry.hash !== commit.hash);
    const newParents: ActiveLane[] = [];
    for (const parent of commit.parents) {
      if (newParents.some((entry) => entry.hash === parent) || after.some((entry) => entry.hash === parent)) continue;
      const colour = parent === commit.parents[0]
        ? current.colour
        : firstFreeColour([...after, ...newParents, { hash: "", colour: current.colour }]);
      newParents.push({ hash: parent, colour });
    }
    after.splice(Math.min(lane, after.length), 0, ...newParents);

    const edges: GitGraphEdge[] = [];
    for (let index = 0; index < before.length; index += 1) {
      if (index === lane) continue;
      const destination = after.findIndex((entry) => entry.hash === before[index].hash);
      if (destination >= 0) edges.push({ from: index, to: destination, fromY: 0, toY: rowHeight, colourLane: before[index].colour });
    }
    if (hasIncomingEdge) edges.push({ from: lane, to: lane, fromY: 0, toY: rowHeight / 2, colourLane: current.colour });
    for (const parent of commit.parents) {
      const destination = after.findIndex((entry) => entry.hash === parent);
      if (destination >= 0) {
        const wasAlreadyActive = before.some((entry, index) => index !== lane && entry.hash === parent);
        edges.push({ from: lane, to: destination, fromY: rowHeight / 2, toY: rowHeight, colourLane: wasAlreadyActive ? current.colour : after[destination].colour });
      }
    }
    lanes = after;
    laneCount = Math.max(laneCount, before.length, after.length, lane + 1);
    return { lane, colour: current.colour, edges };
  });
  return { rows, laneCount };
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function laneX(lane: number) {
  return railPadding + lane * laneGap;
}

function graphRail(row: GitGraphRow, laneCount: number) {
  const namespace = "http://www.w3.org/2000/svg";
  const width = railPadding * 2 + (laneCount - 1) * laneGap;
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("gitCommitRail");
  svg.setAttribute("width", String(width));
  svg.setAttribute("viewBox", `0 0 ${width} ${rowHeight}`);
  svg.setAttribute("aria-hidden", "true");
  for (const edge of row.edges) {
    const path = document.createElementNS(namespace, "path");
    const from = laneX(edge.from);
    const to = laneX(edge.to);
    const fromY = edge.fromY === 0 ? -1 : edge.fromY;
    const toY = edge.toY === rowHeight ? rowHeight + 1 : edge.toY;
    const bendY = (fromY + toY) / 2;
    path.setAttribute("d", `M ${from} ${fromY} C ${from} ${bendY} ${to} ${bendY} ${to} ${toY}`);
    path.setAttribute("stroke", graphColours[edge.colourLane % graphColours.length]);
    path.classList.add("gitCommitEdge");
    svg.append(path);
  }
  const dot = document.createElementNS(namespace, "circle");
  dot.classList.add("gitCommitDot");
  dot.setAttribute("cx", String(laneX(row.lane)));
  dot.setAttribute("cy", String(rowHeight / 2));
  dot.setAttribute("r", "5");
  dot.setAttribute("fill", graphColours[row.colour % graphColours.length]);
  svg.append(dot);
  return svg;
}

export function renderGraphView(options: {
  container: HTMLElement;
  commits: GitCommit[];
  selectedHash?: string;
  onSelectCommit: (commit: GitCommit) => void;
}) {
  const { container, commits, selectedHash, onSelectCommit } = options;
  container.textContent = "";
  if (!commits.length) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "No commits found.";
    container.append(empty);
    return;
  }
  const graph = layoutGitGraph(commits);
  const list = document.createElement("div");
  list.className = "gitCommitList";
  commits.forEach((commit, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gitCommitItem${commit.hash === selectedHash ? " selected" : ""}`;
    button.style.gridTemplateColumns = `${railPadding * 2 + (graph.laneCount - 1) * laneGap}px minmax(0, 1fr)`;
    const rail = graphRail(graph.rows[index], graph.laneCount);

    const body = document.createElement("span");
    body.className = "gitCommitBody";
    const subject = document.createElement("span");
    subject.className = "gitCommitSubject";
    subject.textContent = commit.subject;
    const meta = document.createElement("span");
    meta.className = "gitCommitMeta";
    meta.textContent = `${commit.shortHash} · ${commit.author} · ${formatDate(commit.date)}`;
    const metaLine = document.createElement("span");
    metaLine.className = "gitCommitMetaLine";
    if (commit.refs.length) {
      const refs = document.createElement("span");
      refs.className = "gitCommitRefs";
      refs.textContent = commit.refs.join(" ");
      metaLine.append(refs);
    }
    metaLine.append(meta);
    body.append(subject, metaLine);
    button.append(rail, body);
    button.addEventListener("click", () => onSelectCommit(commit));
    list.append(button);
  });
  container.append(list);
}
