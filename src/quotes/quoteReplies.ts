import { createQuoteReplyPositioning } from "./quoteReplyPositioning.js";
import { readQuoteSelection, selectableBlockSelector, type PendingSelection } from "./quoteSelection.js";
import type { AttachedImage, QuoteReplyAttachment } from "../app/types.js";
import type { SessionDraftStore, StoredQuoteDraft } from "../drafts/sessionDraftStore.js";

export type QuoteReplySubmission = {
  sessionId: string;
  message: string;
  attachments: QuoteReplyAttachment[];
  referenceIds: number[];
};

type QuoteReference = {
  id: number;
  quote: string;
  question: string;
  sourceMessageId?: string;
  startOffset: number;
  endOffset: number;
  mark: HTMLElement;
  pin: HTMLButtonElement;
  note: HTMLDivElement;
  submitted: boolean;
};

export type QuoteRepliesController = {
  hasDrafts: () => boolean;
  hasReplyableSelection: () => boolean;
  replyToSelection: () => void;
  prepareSubmission: (overallInstruction: string) => QuoteReplySubmission | undefined;
  commitSubmission: (submission: QuoteReplySubmission) => void;
  checkpoint: () => { restore: () => void };
  clear: () => void;
  restoreSubmittedReferences: (body?: HTMLElement) => void;
  renderSubmittedMessage: (body: HTMLElement, message: string, attachments: AttachedImage[]) => boolean;
};

function textRange(root: HTMLElement, startOffset: number, endOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: { node: Text; offset: number } | undefined;
  let end: { node: Text; offset: number } | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("[data-quote-reply-ui]")) continue;
    const nextOffset = offset + node.data.length;
    if (!start && startOffset >= offset && startOffset < nextOffset) start = { node, offset: startOffset - offset };
    if (endOffset >= offset && endOffset <= nextOffset) {
      end = { node, offset: endOffset - offset };
      break;
    }
    offset = nextOffset;
  }
  if (!start || !end) return undefined;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function quoteRange(root: HTMLElement, startOffset: number, endOffset: number, quote: string) {
  const matches = (range: Range) => !range.collapsed && range.toString().replace(/\s+/g, " ").trim() === quote.replace(/\s+/g, " ").trim();
  const anchored = textRange(root, startOffset, endOffset);
  if (anchored && matches(anchored)) return anchored;
  // Lazy diagram/artifact rendering can change the preceding generated text.
  // Recover only an unambiguous excerpt, never guess among repeated matches.
  const candidates: Range[] = [];
  for (const block of root.querySelectorAll<HTMLElement>(selectableBlockSelector)) {
    if (!block.getClientRects().length || block.closest("[data-quote-reply-ui]")) continue;
    const text = block.textContent || "";
    let index = text.indexOf(quote);
    while (index >= 0) {
      const range = textRange(block, index, index + quote.length);
      if (range && matches(range) && !candidates.some((candidate) => candidate.compareBoundaryPoints(Range.START_TO_START, range) === 0 && candidate.compareBoundaryPoints(Range.END_TO_END, range) === 0)) candidates.push(range);
      index = text.indexOf(quote, index + 1);
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function createQuoteReplies(options: {
  messagesEl: HTMLElement;
  composerEl: HTMLFormElement;
  getSessionId: () => string;
  drafts: SessionDraftStore;
  onChange: () => void;
}): QuoteRepliesController {
  const { messagesEl, composerEl, getSessionId, drafts, onChange } = options;
  let references: QuoteReference[] = [];
  const positioning = createQuoteReplyPositioning(messagesEl, () => references);
  let pending: PendingSelection | undefined;
  let nextId = 1;
  let settleTimer = 0;
  const persistedReplies = new Map<string, Map<string, AttachedImage>>();
  type StoredDraft = StoredQuoteDraft;
  const isMobileSelection = () => matchMedia("(pointer: coarse)").matches || innerWidth <= 760;

  const toolbar = document.createElement("div");
  toolbar.className = "quoteSelectionToolbar";
  toolbar.dataset.quoteReplyUi = "true";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Selected text actions");
  toolbar.hidden = true;
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "quoteSelectionReply";
  reply.title = "Reply to selected text";
  reply.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h9a7 7 0 0 1 7 7"/></svg><span>Reply</span>';
  toolbar.append(reply);
  document.body.append(toolbar);

  const summary = document.createElement("div");
  summary.className = "quoteReplyComposerSummary";
  summary.dataset.quoteReplyUi = "true";
  summary.hidden = true;
  const summaryButton = document.createElement("button");
  summaryButton.type = "button";
  summaryButton.className = "quoteReplySummaryButton";
  summaryButton.setAttribute("aria-expanded", "false");
  const summaryPopover = document.createElement("div");
  summaryPopover.className = "quoteReplySummaryPopover";
  summaryPopover.hidden = true;
  summary.append(summaryButton, summaryPopover);
  composerEl.insertBefore(summary, composerEl.querySelector("textarea"));

  function draftReferences() {
    return references.filter((reference) => !reference.submitted);
  }

  function serializedDrafts() {
    return draftReferences().map(({ id, quote, question, sourceMessageId, startOffset, endOffset }) => ({
      id, quote, question, sourceMessageId, startOffset, endOffset,
    }));
  }

  function persistDrafts(immediate = false) {
    drafts.update(getSessionId(), { quoteReplies: serializedDrafts() }, immediate);
  }

  function schedulePersistDrafts() {
    // Ownership is resolved now, never later when the shared debounce fires.
    drafts.update(getSessionId(), { quoteReplies: serializedDrafts() });
  }

  function hideToolbar(clearSelection = false) {
    toolbar.hidden = true;
    pending = undefined;
    if (clearSelection) getSelection()?.removeAllRanges();
  }

  function showSelection() {
    pending = readQuoteSelection(messagesEl);
    if (!pending) {
      hideToolbar();
      return;
    }
    const { range, block: startBlock } = pending;
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
    const rect = rects.at(-1) || range.getBoundingClientRect();
    toolbar.hidden = false;
    const actionRect = toolbar.getBoundingClientRect();
    const safeEdge = 8;
    const blockRect = startBlock.getBoundingClientRect();
    const sameLine = (candidate: DOMRect) => candidate.bottom > rect.top + 1 && candidate.top < rect.bottom - 1;
    let occupiedLeft = rect.left;
    let occupiedRight = rect.right;
    try {
      const before = document.createRange();
      before.selectNodeContents(startBlock);
      before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.selectNodeContents(startBlock);
      after.setStart(range.endContainer, range.endOffset);
      const lineRects = [...before.getClientRects(), ...after.getClientRects()].filter(sameLine);
      occupiedLeft = Math.min(occupiedLeft, ...lineRects.map((candidate) => candidate.left));
      occupiedRight = Math.max(occupiedRight, ...lineRects.map((candidate) => candidate.right));
    } catch {
      // The selection itself remains a sufficient anchor if a browser cannot
      // construct a range around generated markdown nodes.
    }

    const lineTop = Math.max(safeEdge, Math.min(innerHeight - actionRect.height - safeEdge, rect.top + (rect.height - actionRect.height) / 2));
    const rightBoundary = Math.min(innerWidth - safeEdge, blockRect.right);
    const leftBoundary = Math.max(safeEdge, blockRect.left);
    const maxSideTether = 112;
    if (occupiedRight - rect.right + 8 <= maxSideTether && occupiedRight + 8 + actionRect.width <= rightBoundary) {
      toolbar.dataset.placement = "right";
      toolbar.style.left = `${Math.round(occupiedRight + 8)}px`;
      toolbar.style.top = `${Math.round(lineTop)}px`;
      return;
    }
    if (rect.left - occupiedLeft + 8 <= maxSideTether && occupiedLeft - 8 - actionRect.width >= leftBoundary) {
      toolbar.dataset.placement = "left";
      toolbar.style.left = `${Math.round(occupiedLeft - actionRect.width - 8)}px`;
      toolbar.style.top = `${Math.round(lineTop)}px`;
      return;
    }

    const anchorX = Math.max(safeEdge, Math.min(innerWidth - safeEdge, rect.right));
    const left = Math.max(safeEdge, Math.min(innerWidth - actionRect.width - safeEdge, anchorX - actionRect.width + 12));
    const viewportHeight = visualViewport?.height || innerHeight;
    const above = rect.bottom + actionRect.height + 10 > viewportHeight;
    const top = above ? rect.top - actionRect.height - 8 : rect.bottom + 8;
    toolbar.dataset.placement = above ? "above" : "below";
    toolbar.style.left = `${Math.round(left)}px`;
    toolbar.style.top = `${Math.round(top)}px`;
    toolbar.style.setProperty("--quote-selection-tail-x", `${Math.round(Math.max(11, Math.min(actionRect.width - 11, anchorX - left)))}px`);
  }

  function jumpToReference(reference: QuoteReference) {
    reference.note.classList.add("open");
    positioning.position();
    const input = reference.note.querySelector<HTMLTextAreaElement>("textarea");
    if (input) resizeEditor(input);
    reference.mark.scrollIntoView({ behavior: "smooth", block: "center" });
    reference.mark.classList.add("flash");
    window.setTimeout(() => reference.mark.classList.remove("flash"), 700);
  }

  function updateSummary() {
    positioning.schedule();
    const drafts = draftReferences();
    summary.hidden = drafts.length === 0;
    const incomplete = drafts.filter((reference) => !reference.question.trim()).length;
    summaryButton.innerHTML = `<span class="quoteReplySummaryDots" aria-hidden="true">••</span><strong>${drafts.length}</strong> linked ${drafts.length === 1 ? "reply" : "replies"}${incomplete ? ` <span>· ${incomplete} needs a question</span>` : ""}`;
    summaryPopover.replaceChildren();
    for (const reference of drafts) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "quoteReplySummaryRow";
      const question = reference.question.trim() || "Add a question…";
      const number = document.createElement("b");
      number.textContent = String(reference.id);
      const copy = document.createElement("span");
      const quote = document.createElement("small");
      const shortQuote = reference.quote.length > 64 ? `${reference.quote.slice(0, 63)}…` : reference.quote;
      quote.textContent = `“${shortQuote}”`;
      const questionText = document.createElement("strong");
      questionText.textContent = question;
      copy.append(quote, questionText);
      const jump = document.createElement("i");
      jump.textContent = "↗";
      row.append(number, copy, jump);
      row.addEventListener("click", () => {
        summaryPopover.hidden = true;
        summaryButton.setAttribute("aria-expanded", "false");
        jumpToReference(reference);
        if (!reference.question.trim()) window.setTimeout(() => reference.note.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 350);
      });
      summaryPopover.append(row);
    }
    onChange();
  }

  // Animation state only: footer visibility remains derived from .editing.open.
  let transition: ViewTransition | undefined;
  let transcriptGeneration = 0;
  let pendingTransitionUpdate: (() => void) | undefined;
  function transitionEditor(update: () => void) {
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      update();
      return;
    }
    // Rapid interactions must not queue stale snapshots or delay an editor action.
    if (transition) {
      transition.skipTransition();
      pendingTransitionUpdate?.();
      update();
      return;
    }
    document.documentElement.classList.add("quoteReplyTransition");
    const generation = transcriptGeneration;
    const sessionId = getSessionId();
    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      if (pendingTransitionUpdate === apply) pendingTransitionUpdate = undefined;
      // Apply once, only to the originating transcript/session.
      if (generation === transcriptGeneration && sessionId === getSessionId()) update();
    };
    pendingTransitionUpdate = apply;
    transition = document.startViewTransition(apply);
    // skipTransition() rejects ready during normal rapid actions and teardown.
    void transition.ready.catch(() => {});
    void transition.finished.catch(() => {}).finally(() => {
      transition = undefined;
      document.documentElement.classList.remove("quoteReplyTransition");
    });
  }

  function removeReference(reference: QuoteReference) {
    transitionEditor(() => removeReferenceImmediately(reference));
  }

  function removeReferenceImmediately(reference: QuoteReference) {
    if (reference.submitted) return;
    reference.mark.replaceWith(...reference.mark.childNodes);
    positioning.remove(reference);
    references = references.filter((candidate) => candidate !== reference);
    persistDrafts();
    updateSummary();
  }

  function resizeEditor(input: HTMLTextAreaElement) {
    if (!input.getClientRects().length) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function bindEditor(reference: QuoteReference) {
    const { note } = reference;
    const input = note.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = reference.question;
    input.addEventListener("input", () => {
      resizeEditor(input);
      reference.question = input.value;
      schedulePersistDrafts();
      updateSummary();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        saveReference(reference);
      }
    });
    note.querySelector<HTMLButtonElement>(".quoteFootnoteConfirm")!.addEventListener("click", () => saveReference(reference));
    note.querySelector<HTMLButtonElement>(".quoteFootnoteEdit")!.addEventListener("click", () => {
      if (reference.submitted) return;
      note.classList.remove("saved");
      note.classList.add("editing", "open");
      resizeEditor(input);
      input.focus();
      input.select();
    });
    note.querySelectorAll<HTMLButtonElement>(".quoteFootnoteRemove").forEach((button) => button.addEventListener("click", () => removeReference(reference)));
    reference.pin.addEventListener("click", () => {
      note.classList.toggle("open");
      if (note.classList.contains("open")) {
        resizeEditor(input);
        jumpToReference(reference);
      }
    });
    resizeEditor(input);
    return input;
  }

  function saveReference(reference: QuoteReference) {
    if (!reference.note.querySelector<HTMLTextAreaElement>("textarea")!.value.trim()) {
      saveReferenceImmediately(reference);
      return;
    }
    transitionEditor(() => saveReferenceImmediately(reference));
  }

  function saveReferenceImmediately(reference: QuoteReference) {
    const input = reference.note.querySelector<HTMLTextAreaElement>("textarea")!;
    const question = input.value.trim();
    if (!question) {
      reference.note.classList.remove("shake");
      void reference.note.offsetWidth;
      reference.note.classList.add("shake");
      input.focus();
      return;
    }
    reference.question = question;
    reference.pin.title = question;
    reference.note.querySelector<HTMLElement>(".quoteFootnoteQuestion")!.textContent = question;
    reference.note.classList.add("saved");
    reference.note.classList.remove("editing", "open");
    persistDrafts();
    updateSummary();
  }

  function restoreSubmittedReference(attachment: AttachedImage, body: HTMLElement) {
    const source = attachment.source;
    if (!source || !attachment.quote || !attachment.question || !attachment.id) return;
    if (body.closest<HTMLElement>(".message.assistant")?.dataset.entryId !== source.messageId) return;
    if (body.querySelector(`[data-quote-attachment-id="${CSS.escape(attachment.id)}"]`)) return;
    const range = quoteRange(body, source.startOffset, source.endOffset, attachment.quote);
    if (!range || range.collapsed || range.toString().replace(/\s+/g, " ").trim() !== attachment.quote.replace(/\s+/g, " ").trim()) return;

    const number = attachment.label?.match(/\d+/)?.[0] || "•";
    const mark = document.createElement("mark");
    mark.className = "quoteReplyMark";
    mark.dataset.quoteAttachmentId = attachment.id;
    try {
      mark.append(range.extractContents());
      range.insertNode(mark);
    } catch {
      return;
    }

    const existing = references.find((reference) => reference.submitted && reference.sourceMessageId === source.messageId && reference.mark.dataset.quoteAttachmentId === attachment.id);
    if (existing) {
      existing.mark = mark;
      positioning.schedule();
      return;
    }
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "quoteReplyPin submitted";
    pin.dataset.quoteReplyUi = "true";
    pin.textContent = number;
    pin.title = attachment.question;

    const note = document.createElement("div");
    note.className = "quoteFootnote submitted saved";
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${number}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span></div></div>`;
    note.querySelector<HTMLElement>(".quoteFootnoteQuestion")!.textContent = attachment.question;
    const id = Number(number);
    const reference: QuoteReference = {
      id: Number.isSafeInteger(id) ? id : nextId,
      quote: attachment.quote,
      question: attachment.question,
      sourceMessageId: source.messageId,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      mark,
      pin,
      note,
      submitted: true,
    };
    references.push(reference);
    positioning.mount(reference);
    nextId = Math.max(nextId, reference.id + 1);
    pin.addEventListener("click", () => {
      note.classList.toggle("open");
      if (note.classList.contains("open")) jumpToReference(reference);
    });
  }

  function restoreDraftReference(draft: StoredDraft, body: HTMLElement) {
    if (!draft.sourceMessageId || body.closest<HTMLElement>(".message.assistant")?.dataset.entryId !== draft.sourceMessageId) return;
    const attachmentId = `quote-reply-${draft.id}`;
    if (body.querySelector(`[data-quote-attachment-id="${CSS.escape(attachmentId)}"]`)) return;
    const range = quoteRange(body, draft.startOffset, draft.endOffset, draft.quote);
    if (!range || range.collapsed || range.toString().replace(/\s+/g, " ").trim() !== draft.quote.replace(/\s+/g, " ").trim()) return;

    const mark = document.createElement("mark");
    mark.className = "quoteReplyMark";
    mark.dataset.quoteReference = String(draft.id);
    mark.dataset.quoteAttachmentId = attachmentId;
    try {
      mark.append(range.extractContents());
      range.insertNode(mark);
    } catch {
      return;
    }
    const existing = references.find((reference) => reference.id === draft.id && reference.sourceMessageId === draft.sourceMessageId);
    if (existing) {
      existing.mark = mark;
      positioning.schedule();
      return;
    }
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "quoteReplyPin";
    pin.dataset.quoteReplyUi = "true";
    pin.textContent = String(draft.id);
    pin.title = draft.question || "Open linked question";

    const note = document.createElement("div");
    note.className = `quoteFootnote ${draft.question.trim() ? "saved" : "editing"}`;
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${draft.id}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteEditor"><textarea rows="2" aria-label="Question for quote ${draft.id}" placeholder="Question for this quote…"></textarea><button class="quoteFootnoteConfirm" type="button" aria-label="Confirm question" title="Confirm question">✓</button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span><button class="quoteFootnoteEdit" type="button" aria-label="Edit question" title="Edit question"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4"/></svg></button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div></div>`;
    note.querySelector<HTMLElement>(".quoteFootnoteQuestion")!.textContent = draft.question;
    const reference: QuoteReference = { ...draft, mark, pin, note, submitted: false };
    references.push(reference);
    positioning.mount(reference);
    nextId = Math.max(nextId, draft.id + 1);
    bindEditor(reference);
    updateSummary();
  }

  function restoreSubmittedReferences(body?: HTMLElement, allowDeferredRetry = true) {
    const sessionId = getSessionId();
    let hasPendingSource = false;
    // Rendering is incremental: keep retrying drafts whose source body has not
    // arrived yet, while existing references make each successful restore idempotent.
    if (sessionId) {
      for (const draft of drafts.get(sessionId).quoteReplies) {
        if (!draft.sourceMessageId || references.some((reference) => reference.mark.isConnected && reference.id === draft.id && reference.sourceMessageId === draft.sourceMessageId)) continue;
        if (body && body.closest<HTMLElement>(".message.assistant")?.dataset.entryId !== draft.sourceMessageId) continue;
        const sourceBody = body || messagesEl.querySelector<HTMLElement>(`.message.assistant[data-entry-id="${CSS.escape(draft.sourceMessageId)}"] > .body`);
        if (sourceBody) restoreDraftReference(draft, sourceBody);
        else hasPendingSource = true;
      }
    }
    // Markdown rendering runs before message metadata is attached. Retry once
    // after that synchronous render completes; subsequent bodies trigger fresh retries.
    if (hasPendingSource && allowDeferredRetry) queueMicrotask(() => restoreSubmittedReferences(undefined, false));
    const bodies = body
      ? [body]
      : Array.from(messagesEl.querySelectorAll<HTMLElement>(".message.assistant > .body"));
    for (const assistantBody of bodies) {
      const messageId = assistantBody.closest<HTMLElement>(".message.assistant")?.dataset.entryId;
      if (!messageId) continue;
      for (const attachment of persistedReplies.get(messageId)?.values() || []) restoreSubmittedReference(attachment, assistantBody);
    }
  }

  function createReference(selection = pending) {
    if (!selection) return;
    const id = nextId++;
    const mark = document.createElement("mark");
    mark.className = "quoteReplyMark";
    mark.dataset.quoteReference = String(id);
    mark.dataset.quoteAttachmentId = `quote-reply-${id}`;
    try {
      mark.append(selection.range.extractContents());
      selection.range.insertNode(mark);
    } catch {
      hideToolbar(true);
      return;
    }
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "quoteReplyPin";
    pin.dataset.quoteReplyUi = "true";
    pin.textContent = String(id);
    pin.title = "Open linked question";

    const note = document.createElement("div");
    note.className = "quoteFootnote editing open quoteFootnoteEntering";
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${id}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteEditor"><textarea rows="2" aria-label="Question for quote ${id}" placeholder="Question for this quote…"></textarea><button class="quoteFootnoteConfirm" type="button" aria-label="Confirm question" title="Confirm question">✓</button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span><button class="quoteFootnoteEdit" type="button" aria-label="Edit question" title="Edit question"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4"/></svg></button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div></div>`;
    const reference: QuoteReference = {
      id,
      quote: selection.quote,
      question: "",
      sourceMessageId: selection.sourceMessageId,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      mark,
      pin,
      note,
      submitted: false,
    };
    references.push(reference);
    positioning.mount(reference);
    positioning.position();
    persistDrafts();
    const input = bindEditor(reference);
    updateSummary();
    hideToolbar(true);
    window.setTimeout(() => input.focus(), 30);
    window.setTimeout(() => note.classList.remove("quoteFootnoteEntering"), 1800);
  }

  // Artifact text and Mermaid labels arrive after the initial Markdown render.
  // Retry only unresolved anchors when those asynchronous surfaces become ready.
  const changedBodies = new Set<HTMLElement>();
  let restoreFrame = 0;
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const body = target?.closest<HTMLElement>(".message.assistant > .body");
      if (body) changedBodies.add(body);
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(".message.assistant > .body")) changedBodies.add(node);
        node.querySelectorAll<HTMLElement>(".message.assistant > .body").forEach((body) => changedBodies.add(body));
      }
    }
    if (!changedBodies.size || restoreFrame) return;
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = 0;
      const bodies = [...changedBodies];
      changedBodies.clear();
      for (const body of bodies) {
        if (!body.isConnected) continue;
        const sourceMessageId = body.closest<HTMLElement>(".message.assistant")?.dataset.entryId;
        if (!sourceMessageId) continue;
        // Only retry unresolved anchors whose own source changed. A missing or
        // ambiguous old quote must not rescan history on every new streamed token.
        const pendingDraft = drafts.get(getSessionId()).quoteReplies.some((draft) => draft.sourceMessageId === sourceMessageId && !references.some((reference) => reference.mark.isConnected && reference.id === draft.id && reference.sourceMessageId === sourceMessageId));
        const pendingSubmitted = Array.from(persistedReplies.get(sourceMessageId)?.values() || []).some((attachment) => !references.some((reference) => reference.mark.isConnected && reference.submitted && reference.sourceMessageId === sourceMessageId && reference.mark.dataset.quoteAttachmentId === attachment.id));
        if (pendingDraft || pendingSubmitted) restoreSubmittedReferences(body, false);
      }
    });
  }).observe(messagesEl, { childList: true, subtree: true });

  toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
  reply.addEventListener("click", () => {
    const selection = pending;
    transitionEditor(() => createReference(selection));
  });
  messagesEl.addEventListener("pointerup", () => {
    if (!isMobileSelection()) window.setTimeout(showSelection);
  });
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(settleTimer);
    const selection = getSelection();
    if (!selection || selection.isCollapsed) {
      hideToolbar();
      return;
    }
    if (!["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")) {
      settleTimer = window.setTimeout(showSelection, isMobileSelection() ? 320 : 120);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!toolbar.hidden && !toolbar.contains(event.target as Node)) hideToolbar();
    for (const reference of references) {
      if (reference.note.classList.contains("saved") && !reference.note.contains(event.target as Node) && !reference.pin.contains(event.target as Node)) {
        reference.note.classList.remove("open");
      }
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !toolbar.hidden) hideToolbar(true);
  });
  messagesEl.addEventListener("scroll", () => hideToolbar(), { passive: true });
  window.addEventListener("resize", () => {
    hideToolbar();
    for (const reference of references) {
      const input = reference.note.querySelector<HTMLTextAreaElement>("textarea");
      if (input) resizeEditor(input);
    }
  });
  // Keep the compact composer from moving this control between pointerdown
  // and click; keyboard activation still retains its normal focus behavior.
  summaryButton.addEventListener("pointerdown", (event) => event.preventDefault());
  summaryButton.addEventListener("click", (event) => {
    event.stopPropagation();
    summaryPopover.hidden = !summaryPopover.hidden;
    summaryButton.setAttribute("aria-expanded", String(!summaryPopover.hidden));
  });
  document.addEventListener("click", (event) => {
    if (!summary.contains(event.target as Node)) {
      summaryPopover.hidden = true;
      summaryButton.setAttribute("aria-expanded", "false");
    }
  });

  return {
    hasReplyableSelection: () => Boolean(readQuoteSelection(messagesEl)),
    replyToSelection() {
      const selection = readQuoteSelection(messagesEl);
      if (selection) transitionEditor(() => createReference(selection));
    },
    hasDrafts: () => draftReferences().length > 0,
    prepareSubmission(overallInstruction) {
      const drafts = draftReferences();
      if (!drafts.length) return undefined;
      const incomplete = drafts.find((reference) => !reference.question.trim());
      if (incomplete) {
        jumpToReference(incomplete);
        window.setTimeout(() => incomplete.note.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 350);
        throw new Error("Each linked quote needs its own question.");
      }
      return {
        sessionId: getSessionId(),
        message: overallInstruction.trim(),
        attachments: drafts.map((reference) => ({
          type: "quote-reply" as const,
          id: `quote-reply-${reference.id}`,
          label: `Excerpt ${reference.id}`,
          quote: reference.quote,
          question: reference.question.trim(),
          source: {
            ...(reference.sourceMessageId ? { messageId: reference.sourceMessageId } : {}),
            startOffset: reference.startOffset,
            endOffset: reference.endOffset,
          },
        })),
        referenceIds: drafts.map((reference) => reference.id),
      };
    },
    commitSubmission(submission) {
      const submittedIds = new Set(submission.referenceIds);
      const remaining = drafts.get(submission.sessionId).quoteReplies.filter((reference) => !submittedIds.has(reference.id));
      drafts.update(submission.sessionId, { quoteReplies: remaining }, true);
      if (getSessionId() !== submission.sessionId) return;
      references.forEach((reference) => {
        if (!submittedIds.has(reference.id)) return;
        reference.submitted = true;
        reference.note.classList.add("submitted", "saved");
        reference.note.classList.remove("open");
        reference.pin.classList.add("submitted");
      });
      updateSummary();
    },
    checkpoint() {
      const saved = { references: [...references], pending, nextId, persisted: new Map(persistedReplies) };
      return { restore() {
        references = saved.references;
        references.forEach(positioning.mount);
        pending = saved.pending;
        nextId = saved.nextId;
        persistedReplies.clear();
        saved.persisted.forEach((value, key) => persistedReplies.set(key, value));
        updateSummary();
      } };
    },
    clear() {
      // Finish a same-session action before its draft is flushed and DOM removed.
      // The captured session check rejects this action during a session switch.
      pendingTransitionUpdate?.();
      transcriptGeneration += 1;
      transition?.skipTransition();
      // Transcript teardown only clears rendered UI. Draft deletion is reserved
      // for explicit submission/removal paths.
      drafts.flush();
      references.forEach(positioning.remove);
      references = [];
      persistedReplies.clear();
      pending = undefined;
      nextId = 1;
      toolbar.hidden = true;
      summaryPopover.hidden = true;
      updateSummary();
    },
    restoreSubmittedReferences,
    renderSubmittedMessage(body, message, attachments) {
      const quoteReplies = attachments.filter((attachment) => attachment.type === "quote-reply" && attachment.quote && attachment.question);
      if (!quoteReplies.length) return false;
      quoteReplies.forEach((attachment) => {
        const messageId = attachment.source?.messageId;
        if (!messageId) return;
        let sourceReplies = persistedReplies.get(messageId);
        if (!sourceReplies) {
          sourceReplies = new Map();
          persistedReplies.set(messageId, sourceReplies);
        }
        sourceReplies.set(`${attachment.id}:${attachment.source?.startOffset}`, attachment);
      });
      restoreSubmittedReferences();
      body.classList.add("submittedQuoteReplies");
      if (message) {
        const overall = document.createElement("div");
        overall.className = "submittedQuoteOverall";
        overall.textContent = message;
        body.append(overall);
      }
      const details = document.createElement("details");
      details.className = "submittedQuoteDetails";
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = `${quoteReplies.length} linked ${quoteReplies.length === 1 ? "excerpt" : "excerpts"}`;
      details.append(detailsSummary);
      quoteReplies.forEach((reference, index) => {
        const row = document.createElement("div");
        row.className = "submittedQuoteRow";
        const number = document.createElement("b");
        number.textContent = reference.label?.match(/\d+/)?.[0] || String(index + 1);
        const copy = document.createElement("span");
        const quote = document.createElement("small");
        quote.textContent = `“${reference.quote}”`;
        const question = document.createElement("strong");
        question.textContent = reference.question || "";
        copy.append(quote, question);
        row.append(number, copy);
        details.append(row);
      });
      body.append(details);
      return true;
    },
  };
}
