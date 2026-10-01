export const streamingRevealDurationMs = 350;
const maxDiffCells = 65_536;

type RevealRange = { start: number; end: number; startedAt: number };
export type StreamingRevealState = { text: string; ranges: RevealRange[] };
type TextMatch = { oldStart: number; newStart: number; length: number };

// Markdown completion can remove delimiters or turn a paragraph into a table.
// Match the displayed text, not the source or HTML, so those changes don't
// replay old words. The usual append-only update needs no diff matrix at all.
export function updateStreamingReveal(
  previous: StreamingRevealState,
  text: string,
  now: number,
): StreamingRevealState {
  const old = previous.text;
  let prefix = 0;
  while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix += 1;
  let suffix = 0;
  // Prefer earlier matches in the changing tail: a new "world" must not steal
  // the "ld" at the end of an existing "bold". Trim a common suffix only when
  // needed to bound a reparse that changes earlier, otherwise-stable blocks.
  if ((old.length - prefix) * (text.length - prefix) > maxDiffCells) {
    while (suffix < old.length - prefix && suffix < text.length - prefix && old[old.length - suffix - 1] === text[text.length - suffix - 1]) suffix += 1;
  }
  const oldLength = old.length - prefix - suffix;
  const newLength = text.length - prefix - suffix;
  const matches: TextMatch[] = [];
  const match = (oldStart: number, newStart: number, length: number) => {
    if (!length) return;
    const last = matches.at(-1);
    if (last && last.oldStart + last.length === oldStart && last.newStart + last.length === newStart) last.length += length;
    else matches.push({ oldStart, newStart, length });
  };
  match(0, 0, prefix);
  const canDiff = oldLength * newLength <= maxDiffCells;
  if (oldLength && newLength && canDiff) {
    const width = newLength + 1;
    const lengths = new Uint16Array((oldLength + 1) * width);
    for (let i = oldLength - 1; i >= 0; i -= 1) {
      for (let j = newLength - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = old[prefix + i] === text[prefix + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < oldLength && j < newLength) {
      if (old[prefix + i] === text[prefix + j]) { match(prefix + i, prefix + j, 1); i += 1; j += 1; }
      else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i += 1;
      else j += 1;
    }
  }
  match(old.length - suffix, text.length - suffix, suffix);

  const active = previous.ranges.filter(range => now - range.startedAt < streamingRevealDurationMs);
  const ranges: RevealRange[] = [];
  const add = (start: number, end: number, startedAt: number) => {
    if (start >= end) return;
    const last = ranges.at(-1);
    if (last?.end === start && last.startedAt === startedAt) last.end = end;
    else ranges.push({ start, end, startedAt });
  };
  let cursor = 0;
  for (const entry of matches) {
    // Bound expensive reparses: settle an ambiguous large replacement instead
    // of flashing an already-visible table or code block again.
    if (canDiff) add(cursor, entry.newStart, now);
    for (const range of active) {
      const start = Math.max(range.start, entry.oldStart);
      const end = Math.min(range.end, entry.oldStart + entry.length);
      if (start < end) add(entry.newStart + start - entry.oldStart, entry.newStart + end - entry.oldStart, range.startedAt);
    }
    cursor = entry.newStart + entry.length;
  }
  if (canDiff) add(cursor, text.length, now);
  return { text, ranges };
}

type TextRun = { node: Text | HTMLSpanElement; text: Text; settle?: () => void };
type LiveNode =
  | { kind: "element"; node: Element; source: string; children: LiveNode[] }
  | { kind: "text"; source: string; runs: TextRun[] }
  | { kind: "other"; node: Node; source: string | null };
type RenderContext = { offset: number; now: number; ranges: RevealRange[]; sources: WeakMap<Node, string> };

function nodeSource(node: Node, context: RenderContext) {
  let source = context.sources.get(node);
  if (source === undefined) {
    source = (node instanceof Element ? node.outerHTML : node.textContent) || "";
    context.sources.set(node, source);
  }
  return source;
}

function viewKey(view: LiveNode) {
  return `${view.kind === "text" ? Node.TEXT_NODE : view.node.nodeType}:${view.source || ""}`;
}

function mountedNodes(view: LiveNode): Node[] {
  return view.kind === "text" ? view.runs.map(run => run.node) : [view.node];
}

function extendsText(view: LiveNode | undefined, next: Node) {
  if (!view) return false;
  let previousText: string;
  let nextText: string;
  if (view.kind === "text" && next instanceof Text) {
    previousText = view.source;
    nextText = next.data;
  } else if (view.kind === "element" && next instanceof Element && view.node.tagName === next.tagName) {
    previousText = view.node.textContent || "";
    nextText = next.textContent || "";
  } else return false;
  return previousText.length > 0 && nextText.length > previousText.length && nextText.startsWith(previousText);
}

export function createStreamingReveal() {
  const states = new WeakMap<HTMLElement, StreamingRevealState>();
  // Canonical Markdown nodes and presentation runs are separate. A text leaf
  // can contain several runs, but adding to it never remounts its earlier runs.
  const views = new WeakMap<HTMLElement, LiveNode[]>();
  const ownedSpans = new WeakMap<HTMLElement, TextRun>();
  const unwrap = (span: HTMLElement) => {
    const selection = window.getSelection();
    const parent = span.parentNode;
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    const anchorInside = Boolean(anchor && span.contains(anchor));
    const focusInside = Boolean(focus && span.contains(focus));
    const index = parent && (anchorInside || focusInside) ? Array.from(parent.childNodes).indexOf(span) : 0;
    const anchorOffset = selection?.anchorOffset || 0;
    const focusOffset = selection?.focusOffset || 0;
    span.replaceWith(...Array.from(span.childNodes));
    // Moving a selected Text out of its transient span normally collapses the
    // browser's range. Restore just the affected endpoints, including direction.
    if (selection && parent && (anchorInside || focusInside)) {
      const anchorNode = anchorInside ? (anchor === span ? parent : anchor) : selection.anchorNode;
      const focusNode = focusInside ? (focus === span ? parent : focus) : selection.focusNode;
      if (anchorNode && focusNode) selection.setBaseAndExtent(
        anchorNode, anchorInside ? anchorOffset + (anchor === span ? index : 0) : selection.anchorOffset,
        focusNode, focusInside ? focusOffset + (focus === span ? index : 0) : selection.focusOffset,
      );
    }
  };

  const settleReveals = (body: HTMLElement) => {
    for (const span of body.querySelectorAll<HTMLElement>(".streamingWordReveal")) ownedSpans.get(span)?.settle?.();
  };

  const createRun = (value: string, startedAt: number | undefined, now: number): TextRun => {
    const text = document.createTextNode(value);
    const run: TextRun = { node: text, text };
    if (startedAt === undefined || !value.trim()) return run;
    const span = document.createElement("span");
    span.className = "streamingWordReveal";
    span.append(text);
    span.style.animationDuration = `${streamingRevealDurationMs}ms`;
    span.style.animationDelay = `${startedAt - now}ms`;
    run.node = span;
    run.settle = () => {
      if (run.node !== span) return;
      run.node = text;
      span.removeEventListener("animationend", run.settle!);
      span.removeEventListener("animationcancel", run.settle!);
      unwrap(span);
      run.settle = undefined;
    };
    ownedSpans.set(span, run);
    span.addEventListener("animationend", run.settle);
    span.addEventListener("animationcancel", run.settle);
    return run;
  };

  const createTextRuns = (value: string, offset: number, context: RenderContext) => {
    const runs: TextRun[] = [];
    let cursor = 0;
    for (const range of context.ranges) {
      if (range.end <= offset) continue;
      if (range.start >= offset + value.length) break;
      const start = Math.max(range.start - offset, 0);
      const end = Math.min(range.end - offset, value.length);
      if (start > cursor) runs.push(createRun(value.slice(cursor, start), undefined, context.now));
      runs.push(createRun(value.slice(start, end), range.startedAt, context.now));
      cursor = end;
    }
    if (cursor < value.length) runs.push(createRun(value.slice(cursor), undefined, context.now));
    return runs;
  };

  const reconcileNode = (current: LiveNode | undefined, next: Node, context: RenderContext): LiveNode => {
    if (next instanceof Text) {
      const value = next.data;
      const view = current?.kind === "text" ? current : { kind: "text" as const, source: "", runs: [] };
      if (view.source !== value) {
        let prefix = 0;
        while (prefix < view.source.length && prefix < value.length && view.source[prefix] === value[prefix]) prefix += 1;
        const runs: TextRun[] = [];
        let remaining = prefix;
        for (const run of view.runs) {
          if (!remaining) break;
          const length = Math.min(remaining, run.text.length);
          if (length < run.text.length) run.text.deleteData(length, run.text.length - length);
          runs.push(run);
          remaining -= length;
        }
        view.runs = [...runs, ...createTextRuns(value.slice(prefix), context.offset + prefix, context)];
        view.source = value;
      }
      context.offset += value.length;
      return view;
    }
    if (next instanceof Element) {
      const source = nodeSource(next, context);
      const view = current?.kind === "element" && current.node.tagName === next.tagName
        ? current
        : { kind: "element" as const, node: next.cloneNode(false) as Element, source: "", children: [] };
      if (view.source === source) context.offset += next.textContent?.length || 0;
      else {
        for (const attribute of Array.from(view.node.attributes)) {
          if (!next.hasAttribute(attribute.name)) view.node.removeAttribute(attribute.name);
        }
        for (const attribute of Array.from(next.attributes)) {
          if (view.node.getAttribute(attribute.name) !== attribute.value) view.node.setAttribute(attribute.name, attribute.value);
        }
        view.children = reconcileChildren(view.node, view.children, Array.from(next.childNodes), context);
        view.source = source;
      }
      return view;
    }
    const source = nodeSource(next, context);
    if (current?.kind === "other" && current.node.nodeType === next.nodeType && current.source === source) return current;
    return { kind: "other", node: next.cloneNode(true), source };
  };

  const reconcileChildren = (parent: HTMLElement | Element, current: LiveNode[], incoming: Node[], context: RenderContext): LiveNode[] => {
    const available = new Map<string, { items: LiveNode[]; index: number }>();
    for (const view of current) {
      const key = viewKey(view);
      const pool = available.get(key);
      if (pool) pool.items.push(view);
      else available.set(key, { items: [view], index: 0 });
    }
    const keys = incoming.map(node => `${node.nodeType}:${nodeSource(node, context)}`);
    const remaining = new Map<string, number>();
    for (const key of keys) remaining.set(key, (remaining.get(key) || 0) + 1);
    const used = new Set<LiveNode>();
    let cursorIndex = 0;
    const next = incoming.map((node, index) => {
      const key = keys[index];
      remaining.set(key, remaining.get(key)! - 1);
      const candidate = current[cursorIndex];
      const pool = available.get(key);
      while (pool && pool.index < pool.items.length && used.has(pool.items[pool.index])) pool.index += 1;
      // Prefer the growing node over an identical later sibling: appending
      // " more\n\nHello" to "Hello" must not move the live first paragraph.
      let view = extendsText(candidate, node) ? candidate : pool?.items[pool.index++];
      if (!view) {
        // An unchanged sibling is an anchor, even when a late reference or
        // inline delimiter inserts new nodes before it. Don't consume it for
        // the new insertion; reconcile only the unanchored changing content.
        if (candidate && !remaining.get(viewKey(candidate))) view = candidate;
      }
      if (view) used.add(view);
      while (cursorIndex < current.length && used.has(current[cursorIndex])) cursorIndex += 1;
      return reconcileNode(view, node, context);
    });
    const nodes = next.flatMap(mountedNodes);
    const retained = new Set(nodes);
    // Remove obsolete children before placing additions, so an insertion never
    // moves a retained sibling merely to get past an obsolete node.
    for (const node of Array.from(parent.childNodes)) if (!retained.has(node)) node.remove();
    let cursor: ChildNode | null = parent.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
    return next;
  };

  return {
    render(body: HTMLElement, fragment: DocumentFragment) {
      const now = performance.now();
      const text = fragment.textContent || "";
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const state = reducedMotion ? { text, ranges: [] } : updateStreamingReveal(states.get(body) || { text: body.textContent || "", ranges: [] }, text, now);
      states.set(body, state);
      if (reducedMotion) settleReveals(body);
      views.set(body, reconcileChildren(body, views.get(body) || [], Array.from(fragment.childNodes), { offset: 0, now, ranges: state.ranges, sources: new WeakMap() }));
    },
    finish(body: HTMLElement) {
      states.delete(body);
      views.delete(body);
    },
    cancel(body: HTMLElement) {
      states.delete(body);
      views.delete(body);
      settleReveals(body);
    },
  };
}
