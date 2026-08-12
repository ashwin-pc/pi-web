import type { AttachedImage, QuoteReplyAttachment } from "../app/types.js";

export type QuoteReplySubmission = {
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

type PendingSelection = {
  range: Range;
  quote: string;
  body: HTMLElement;
  block: HTMLElement;
  sourceMessageId?: string;
  startOffset: number;
  endOffset: number;
};

export type QuoteRepliesController = {
  hasDrafts: () => boolean;
  prepareSubmission: (overallInstruction: string) => QuoteReplySubmission | undefined;
  commitSubmission: (submission: QuoteReplySubmission) => void;
  clear: () => void;
  restoreSubmittedReferences: (body?: HTMLElement) => void;
  renderSubmittedMessage: (body: HTMLElement, message: string, attachments: AttachedImage[]) => boolean;
};

const selectableBlockSelector = "p, li, blockquote, pre, td, th";

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

function textRange(root: HTMLElement, startOffset: number, endOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: { node: Text; offset: number } | undefined;
  let end: { node: Text; offset: number } | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("[data-quote-reply-ui]")) continue;
    const nextOffset = offset + node.data.length;
    if (!start && startOffset >= offset && startOffset <= nextOffset) start = { node, offset: startOffset - offset };
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

export function createQuoteReplies(options: {
  messagesEl: HTMLElement;
  composerEl: HTMLFormElement;
  getSessionId: () => string;
  onChange: () => void;
}): QuoteRepliesController {
  const { messagesEl, composerEl, getSessionId, onChange } = options;
  let references: QuoteReference[] = [];
  let pending: PendingSelection | undefined;
  let nextId = 1;
  let settleTimer = 0;
  const persistedReplies = new Map<string, Map<string, AttachedImage>>();
  const draftStorageKey = "pi-web-quote-reply-drafts-v1";
  type StoredDraft = Pick<QuoteReference, "id" | "quote" | "question" | "sourceMessageId" | "startOffset" | "endOffset">;
  let restoredDraftSession = "";
  let persistTimer = 0;
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

  function readStoredDrafts() {
    try {
      const value = JSON.parse(localStorage.getItem(draftStorageKey) || "{}") as Record<string, StoredDraft[]>;
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function persistDrafts() {
    window.clearTimeout(persistTimer);
    persistTimer = 0;
    const sessionId = getSessionId();
    if (!sessionId) return;
    const stored = readStoredDrafts();
    const drafts = draftReferences().map(({ id, quote, question, sourceMessageId, startOffset, endOffset }) => ({
      id, quote, question, sourceMessageId, startOffset, endOffset,
    }));
    if (drafts.length) stored[sessionId] = drafts;
    else delete stored[sessionId];
    try {
      if (Object.keys(stored).length) localStorage.setItem(draftStorageKey, JSON.stringify(stored));
      else localStorage.removeItem(draftStorageKey);
    } catch { /* ignore unavailable storage */ }
  }

  function schedulePersistDrafts() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persistDrafts, 120);
  }

  function hideToolbar(clearSelection = false) {
    toolbar.hidden = true;
    pending = undefined;
    if (clearSelection) getSelection()?.removeAllRanges();
  }

  function showSelection() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      hideToolbar();
      return;
    }
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
    if (!startElement || !endElement) {
      hideToolbar();
      return;
    }
    const body = startElement.closest<HTMLElement>(".message.assistant > .body");
    if (!body || body !== endElement.closest(".message.assistant > .body") || startElement.closest("[data-quote-reply-ui]")) {
      hideToolbar();
      return;
    }
    const startBlock = startElement.closest<HTMLElement>(selectableBlockSelector) || body;
    const endBlock = endElement.closest<HTMLElement>(selectableBlockSelector) || body;
    const quote = selection.toString().replace(/\s+/g, " ").trim();
    if (startBlock !== endBlock || quote.length < 2) {
      hideToolbar();
      return;
    }
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
    const rect = rects.at(-1) || range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const message = body.closest<HTMLElement>(".message.assistant");
    pending = {
      range: range.cloneRange(),
      quote,
      body,
      block: startBlock,
      sourceMessageId: message?.dataset.entryId,
      startOffset: textOffset(body, range.startContainer, range.startOffset),
      endOffset: textOffset(body, range.endContainer, range.endOffset),
    };
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
    reference.mark.scrollIntoView({ behavior: "smooth", block: "center" });
    reference.mark.classList.add("flash");
    window.setTimeout(() => reference.mark.classList.remove("flash"), 700);
  }

  function updateSummary() {
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
        if (!reference.question.trim()) window.setTimeout(() => reference.note.querySelector<HTMLInputElement>("input")?.focus(), 350);
      });
      summaryPopover.append(row);
    }
    onChange();
  }

  function removeReference(reference: QuoteReference) {
    if (reference.submitted) return;
    reference.mark.replaceWith(...reference.mark.childNodes);
    reference.pin.remove();
    reference.note.remove();
    references = references.filter((candidate) => candidate !== reference);
    persistDrafts();
    updateSummary();
  }

  function saveReference(reference: QuoteReference) {
    const input = reference.note.querySelector<HTMLInputElement>("input")!;
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
    const range = textRange(body, source.startOffset, source.endOffset);
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

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "quoteReplyPin submitted";
    pin.dataset.quoteReplyUi = "true";
    pin.textContent = number;
    pin.title = attachment.question;
    mark.after(pin);

    const note = document.createElement("div");
    note.className = "quoteFootnote submitted saved";
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${number}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span></div></div>`;
    note.querySelector<HTMLElement>(".quoteFootnoteQuestion")!.textContent = attachment.question;
    let noteAnchor: Element = mark.closest(selectableBlockSelector) || body;
    while (noteAnchor.nextElementSibling?.classList.contains("quoteFootnote")) noteAnchor = noteAnchor.nextElementSibling;
    noteAnchor.after(note);

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
    const range = textRange(body, draft.startOffset, draft.endOffset);
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
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "quoteReplyPin";
    pin.dataset.quoteReplyUi = "true";
    pin.textContent = String(draft.id);
    pin.title = draft.question || "Open linked question";
    mark.after(pin);

    const note = document.createElement("div");
    note.className = `quoteFootnote ${draft.question.trim() ? "saved" : "editing"}`;
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${draft.id}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteEditor"><input aria-label="Question for quote ${draft.id}" placeholder="Question for this quote…"><button class="quoteFootnoteConfirm" type="button" aria-label="Confirm question" title="Confirm question">✓</button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span><button class="quoteFootnoteEdit" type="button" aria-label="Edit question" title="Edit question"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4"/></svg></button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div></div>`;
    const input = note.querySelector<HTMLInputElement>("input")!;
    input.value = draft.question;
    note.querySelector<HTMLElement>(".quoteFootnoteQuestion")!.textContent = draft.question;
    let noteAnchor: Element = mark.closest(selectableBlockSelector) || body;
    while (noteAnchor.nextElementSibling?.classList.contains("quoteFootnote")) noteAnchor = noteAnchor.nextElementSibling;
    noteAnchor.after(note);

    const reference: QuoteReference = { ...draft, mark, pin, note, submitted: false };
    references.push(reference);
    nextId = Math.max(nextId, draft.id + 1);
    input.addEventListener("input", () => { reference.question = input.value; schedulePersistDrafts(); updateSummary(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); saveReference(reference); }
    });
    note.querySelector<HTMLButtonElement>(".quoteFootnoteConfirm")!.addEventListener("click", () => saveReference(reference));
    note.querySelector<HTMLButtonElement>(".quoteFootnoteEdit")!.addEventListener("click", () => {
      note.classList.remove("saved");
      note.classList.add("editing", "open");
      input.focus();
      input.select();
    });
    note.querySelectorAll<HTMLButtonElement>(".quoteFootnoteRemove").forEach((button) => button.addEventListener("click", () => removeReference(reference)));
    pin.addEventListener("click", () => {
      note.classList.toggle("open");
      if (note.classList.contains("open")) jumpToReference(reference);
    });
    updateSummary();
  }

  function restoreSubmittedReferences(body?: HTMLElement) {
    const sessionId = getSessionId();
    if (sessionId && restoredDraftSession !== sessionId) {
      restoredDraftSession = sessionId;
      const drafts = readStoredDrafts()[sessionId];
      if (Array.isArray(drafts)) {
        for (const draft of drafts) {
          if (!draft || !Number.isSafeInteger(draft.id) || typeof draft.quote !== "string" || typeof draft.question !== "string" || typeof draft.sourceMessageId !== "string" || !Number.isSafeInteger(draft.startOffset) || !Number.isSafeInteger(draft.endOffset)) continue;
          const sourceBody = messagesEl.querySelector<HTMLElement>(`.message.assistant[data-entry-id="${CSS.escape(draft.sourceMessageId)}"] > .body`);
          if (sourceBody) restoreDraftReference(draft, sourceBody);
        }
      }
    }
    const bodies = body
      ? [body]
      : Array.from(messagesEl.querySelectorAll<HTMLElement>(".message.assistant > .body"));
    for (const assistantBody of bodies) {
      const messageId = assistantBody.closest<HTMLElement>(".message.assistant")?.dataset.entryId;
      if (!messageId) continue;
      for (const attachment of persistedReplies.get(messageId)?.values() || []) restoreSubmittedReference(attachment, assistantBody);
    }
  }

  function createReference() {
    if (!pending) return;
    const selection = pending;
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
    mark.after(pin);

    const note = document.createElement("div");
    note.className = "quoteFootnote editing open";
    note.dataset.quoteReplyUi = "true";
    note.innerHTML = `<span class="quoteFootnoteNumber">${id}</span><div class="quoteFootnoteBody"><div class="quoteFootnoteEditor"><input aria-label="Question for quote ${id}" placeholder="Question for this quote…"><button class="quoteFootnoteConfirm" type="button" aria-label="Confirm question" title="Confirm question">✓</button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div><div class="quoteFootnoteRead"><span class="quoteFootnoteQuestion"></span><button class="quoteFootnoteEdit" type="button" aria-label="Edit question" title="Edit question"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4"/></svg></button><button class="quoteFootnoteRemove" type="button" aria-label="Remove quote" title="Remove quote">×</button></div></div>`;
    let noteAnchor: Element = selection.block;
    while (noteAnchor.nextElementSibling?.classList.contains("quoteFootnote")) noteAnchor = noteAnchor.nextElementSibling;
    noteAnchor.after(note);

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
    persistDrafts();
    const input = note.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      reference.question = input.value;
      schedulePersistDrafts();
      updateSummary();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveReference(reference);
      }
    });
    note.querySelector<HTMLButtonElement>(".quoteFootnoteConfirm")!.addEventListener("click", () => saveReference(reference));
    note.querySelector<HTMLButtonElement>(".quoteFootnoteEdit")!.addEventListener("click", () => {
      if (reference.submitted) return;
      note.classList.remove("saved");
      note.classList.add("editing", "open");
      input.focus();
      input.select();
    });
    note.querySelectorAll<HTMLButtonElement>(".quoteFootnoteRemove").forEach((button) => button.addEventListener("click", () => removeReference(reference)));
    pin.addEventListener("click", () => {
      note.classList.toggle("open");
      if (note.classList.contains("open")) jumpToReference(reference);
    });
    updateSummary();
    hideToolbar(true);
    window.setTimeout(() => input.focus(), 30);
  }

  toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
  reply.addEventListener("click", createReference);
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
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !toolbar.hidden) hideToolbar(true);
  });
  messagesEl.addEventListener("scroll", () => hideToolbar(), { passive: true });
  window.addEventListener("resize", () => hideToolbar());
  window.addEventListener("pagehide", persistDrafts);
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
    hasDrafts: () => draftReferences().length > 0,
    prepareSubmission(overallInstruction) {
      const drafts = draftReferences();
      if (!drafts.length) return undefined;
      const incomplete = drafts.find((reference) => !reference.question.trim());
      if (incomplete) {
        jumpToReference(incomplete);
        window.setTimeout(() => incomplete.note.querySelector<HTMLInputElement>("input")?.focus(), 350);
        throw new Error("Each linked quote needs its own question.");
      }
      return {
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
      references.forEach((reference) => {
        if (!submittedIds.has(reference.id)) return;
        reference.submitted = true;
        reference.note.classList.add("submitted", "saved");
        reference.note.classList.remove("open");
        reference.pin.classList.add("submitted");
      });
      persistDrafts();
      updateSummary();
    },
    clear() {
      references = [];
      persistedReplies.clear();
      restoredDraftSession = "";
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
