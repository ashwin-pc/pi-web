import type { SessionLaneId } from "../app/types.js";

export const sessionLaneMeta: Record<SessionLaneId, { label: string; path: string }> = {
  pinned: { label: "Pinned", path: "M8 1a5 5 0 0 0-5 5c0 3.6 5 9 5 9s5-5.4 5-9a5 5 0 0 0-10 0zm0 6.8A1.8 1.8 0 1 1 8 4.2a1.8 1.8 0 0 1 0 3.6z" },
  parked: { label: "Parked", path: "M5 3h2.2v10H5zM8.8 3H11v10H8.8z" },
  bookmarks: { label: "Bookmarks", path: "M4 2h8v12l-4-3-4 3z" },
};

export function sessionLaneIcon(lane: SessionLaneId) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", sessionLaneMeta[lane].path);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
