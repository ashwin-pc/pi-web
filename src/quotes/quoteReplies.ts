export type QuoteReplySubmission = {
  message: string;
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
  renderSubmittedMessage: (body: HTMLElement, message: string) => boolean;
};

const promptStart = '<pi-web-quote-replies version="1">';
const promptEnd = "</pi-web-quote-replies>";
const selectableBlockSelector = "p, li, blockquote, pre, td, th";

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function unescapeXml(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  })[entity]!);
}

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

function parseSubmittedMessage(message: string) {
  if (!message.includes(promptStart) || !message.includes(promptEnd)) return undefined;
  const references = Array.from(message.matchAll(/<quote-reply\s+([^>]*)>\s*<quote>([\s\S]*?)<\/quote>\s*<question>([\s\S]*?)<\/question>\s*<\/quote-reply>/g)).map((match) => {
    const id = match[1].match(/\bid="(\d+)"/)?.[1] || "?";
    return { id, quote: unescapeXml(match[2].trim()), question: unescapeXml(match[3].trim()) };
  });
  if (!references.length) return undefined;
  const overall = message.match(/<overall-instruction>([\s\S]*?)<\/overall-instruction>/)?.[1];
  return { references, overall: overall ? unescapeXml(overall.trim()) : "" };
}

export function createQuoteReplies(options: {
  messagesEl: HTMLElement;
  composerEl: HTMLFormElement;
  onChange: () => void;
}): QuoteRepliesController {
  const { messagesEl, composerEl, onChange } = options;
  let references: QuoteReference[] = [];
  let pending: PendingSelection | undefined;
  let nextId = 1;
  let settleTimer = 0;
  const isMobileSelection = () => matchMedia("(pointer: coarse)").matches || innerWidth <= 760;

  const toolbar = document.createElement("div");
  toolbar.className = "quoteSelectionToolbar";
  toolbar.dataset.quoteReplyUi = "true";
  toolbar.hidden = true;
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "quoteSelectionReply";
  reply.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21c3-4 7-6 13-6h4M13 8l7 7-7 7M20 15H9a6 6 0 0 1-6-6V3"/></svg><span>Reply</span>';
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quoteSelectionCancel";
  cancel.setAttribute("aria-label", "Cancel quote reply");
  cancel.textContent = "×";
  toolbar.append(reply, cancel);
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
    const toolbarHalfWidth = 58;
    toolbar.style.left = `${Math.max(toolbarHalfWidth + 6, Math.min(innerWidth - toolbarHalfWidth - 6, rect.right))}px`;
    const viewportHeight = visualViewport?.height || innerHeight;
    const above = rect.bottom + 52 > viewportHeight;
    toolbar.dataset.placement = above ? "above" : "below";
    toolbar.style.top = `${above ? rect.top - 7 : rect.bottom + 7}px`;
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
    updateSummary();
  }

  function createReference() {
    if (!pending) return;
    const selection = pending;
    const id = nextId++;
    const mark = document.createElement("mark");
    mark.className = "quoteReplyMark";
    mark.dataset.quoteReference = String(id);
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
    const input = note.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      reference.question = input.value;
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
  cancel.addEventListener("click", () => hideToolbar(true));
  messagesEl.addEventListener("pointerup", () => {
    if (!isMobileSelection()) window.setTimeout(showSelection);
  });
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(settleTimer);
    if (isMobileSelection() && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")) settleTimer = window.setTimeout(showSelection, 320);
  });
  messagesEl.addEventListener("scroll", () => hideToolbar(), { passive: true });
  window.addEventListener("resize", () => hideToolbar());
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
      const entries = drafts.map((reference) => {
        const source = reference.sourceMessageId ? ` source-message-id="${escapeXml(reference.sourceMessageId)}"` : "";
        return `  <quote-reply id="${reference.id}"${source} start-offset="${reference.startOffset}" end-offset="${reference.endOffset}">\n    <quote>${escapeXml(reference.quote)}</quote>\n    <question>${escapeXml(reference.question.trim())}</question>\n  </quote-reply>`;
      }).join("\n");
      const overall = overallInstruction.trim() ? `\n  <overall-instruction>${escapeXml(overallInstruction.trim())}</overall-instruction>` : "";
      return {
        message: `${promptStart}\n${entries}${overall}\n${promptEnd}`,
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
      updateSummary();
    },
    clear() {
      references = [];
      pending = undefined;
      nextId = 1;
      toolbar.hidden = true;
      summaryPopover.hidden = true;
      updateSummary();
    },
    renderSubmittedMessage(body, message) {
      const parsed = parseSubmittedMessage(message);
      if (!parsed) return false;
      body.classList.add("submittedQuoteReplies");
      if (parsed.overall) {
        const overall = document.createElement("div");
        overall.className = "submittedQuoteOverall";
        overall.textContent = parsed.overall;
        body.append(overall);
      }
      const details = document.createElement("details");
      details.className = "submittedQuoteDetails";
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = `${parsed.references.length} linked ${parsed.references.length === 1 ? "excerpt" : "excerpts"}`;
      details.append(detailsSummary);
      parsed.references.forEach((reference) => {
        const row = document.createElement("div");
        row.className = "submittedQuoteRow";
        const number = document.createElement("b");
        number.textContent = reference.id;
        const copy = document.createElement("span");
        const quote = document.createElement("small");
        quote.textContent = `“${reference.quote}”`;
        const question = document.createElement("strong");
        question.textContent = reference.question;
        copy.append(quote, question);
        row.append(number, copy);
        details.append(row);
      });
      body.append(details);
      return true;
    },
  };
}
