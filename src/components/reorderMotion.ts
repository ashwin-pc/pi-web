export type ReorderAxis = "x" | "y";

export function reorderCoordinate(rect: DOMRect, axis: ReorderAxis, edge: "start" | "end" | "size" | "center") {
  if (axis === "x") {
    if (edge === "start") return rect.left;
    if (edge === "end") return rect.right;
    if (edge === "size") return rect.width;
    return rect.left + rect.width / 2;
  }
  if (edge === "start") return rect.top;
  if (edge === "end") return rect.bottom;
  if (edge === "size") return rect.height;
  return rect.top + rect.height / 2;
}

export function insertionIndex(rects: DOMRect[], coordinate: number, axis: ReorderAxis, excludedIndex = -1) {
  return rects.reduce((count, rect, index) => index !== excludedIndex && reorderCoordinate(rect, axis, "center") < coordinate ? count + 1 : count, 0);
}

export function edgeScrollVelocity(coordinate: number, start: number, end: number, edgeSize = 48, maximum = 14) {
  const edge = Math.min(edgeSize, Math.max(0, (end - start) / 2));
  if (!edge) return 0;
  if (coordinate < start + edge) return -maximum * Math.min(1, (start + edge - coordinate) / edge);
  if (coordinate > end - edge) return maximum * Math.min(1, (coordinate - (end - edge)) / edge);
  return 0;
}

export function prefersReducedReorderMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function nextAnimationFrame(callback: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

/** Animate a DOM reorder without changing the adapter's ordering semantics. */
export function animateReorderLayout(elements: HTMLElement[], mutate: () => void, options: { exclude?: HTMLElement; reducedMotion?: boolean } = {}) {
  const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  mutate();
  if (options.reducedMotion) return;
  for (const element of elements) {
    if (element === options.exclude) continue;
    const previous = before.get(element);
    if (!previous || !element.isConnected) continue;
    const current = element.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (!dx && !dy) continue;
    element.style.transition = "none";
    element.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      element.style.transition = "transform 160ms cubic-bezier(.2,.8,.2,1)";
      element.style.transform = "";
    });
  }
}
