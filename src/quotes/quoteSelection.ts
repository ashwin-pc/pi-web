export const selectableBlockSelector = "p, li, blockquote, pre, td, th";

export type PendingSelection = {
  range: Range;
  quote: string;
  body: HTMLElement;
  block: HTMLElement;
  sourceMessageId?: string;
  startOffset: number;
  endOffset: number;
};

function textOffset(root: HTMLElement, target: Node, targetOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("[data-quote-reply-ui]")) continue;
    if (node === target) return offset + targetOffset;
    offset += node.data.length;
  }
  return offset;
}

/** Inspect the live selection without changing the toolbar, focus or DOM. */
export function readQuoteSelection(messages: HTMLElement): PendingSelection | undefined {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
  if (!start || !end) return;
  const body = start.closest<HTMLElement>(".message.assistant > .body");
  if (!body || !messages.contains(body) || body !== end.closest(".message.assistant > .body") || start.closest("[data-quote-reply-ui]")) return;
  const block = start.closest<HTMLElement>(selectableBlockSelector) || body;
  const endBlock = end.closest<HTMLElement>(selectableBlockSelector) || body;
  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (block !== endBlock || quote.length < 2) return;
  if (!Array.from(range.getClientRects()).some((rect) => rect.width && rect.height)) return;
  return {
    range: range.cloneRange(),
    quote,
    body,
    block,
    sourceMessageId: body.closest<HTMLElement>(".message.assistant")?.dataset.entryId,
    startOffset: textOffset(body, range.startContainer, range.startOffset),
    endOffset: textOffset(body, range.endContainer, range.endOffset),
  };
}
