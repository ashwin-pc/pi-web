type QuoteSurface = { mark: HTMLElement; pin: HTMLButtonElement; note: HTMLDivElement };

/** Keep all interactive quote UI out of Markdown, table and SVG layout trees. */
export function createQuoteReplyPositioning(messages: HTMLElement, getReferences: () => QuoteSurface[]) {
  const layer = document.createElement("div");
  layer.className = "quoteReplyLayer";
  layer.dataset.quoteReplyUi = "true";
  document.body.append(layer);
  let frame = 0;

  function position() {
    frame = 0;
    const transcript = messages.getBoundingClientRect();
    const edge = 12;
    // Fixed coordinates use layout-viewport space; the keyboard/pinch zoom can
    // leave only an offset portion of that space visible.
    const viewport = window.visualViewport;
    const viewportLeft = (viewport?.offsetLeft || 0) + edge;
    const viewportTop = (viewport?.offsetTop || 0) + edge;
    const viewportRight = (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - edge;
    const bottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - edge;
    const transcriptNoteTop = Math.max(viewportTop, transcript.top + edge);
    const transcriptNoteBottom = Math.min(bottom, transcript.bottom - edge);
    const references = [...getReferences()].sort((a, b) => a.mark.compareDocumentPosition(b.mark) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    references.forEach(({ pin, note }, index) => {
      if (layer.children[index * 2] !== pin) layer.insertBefore(pin, layer.children[index * 2] || null);
      if (layer.children[index * 2 + 1] !== note) layer.insertBefore(note, layer.children[index * 2 + 1] || null);
    });
    for (const { mark, pin, note } of references) {
      const range = document.createRange();
      range.selectNodeContents(mark);
      const rect = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).at(-1) || mark.getBoundingClientRect();
      let left = Math.max(viewportLeft, transcript.left), right = Math.min(viewportRight, transcript.right);
      let topEdge = Math.max(viewportTop, transcript.top), bottomEdge = Math.min(bottom, transcript.bottom);
      // A source can also scroll or be clipped inside code/artifact previews.
      for (let parent = mark.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { topEdge = Math.max(topEdge, bounds.top); bottomEdge = Math.min(bottomEdge, bounds.bottom); }
      }
      const visible = mark.isConnected && rect.width > 0 && rect.height > 0
        && rect.bottom > topEdge && rect.top < bottomEdge && rect.right > left && rect.left < right;
      pin.hidden = !visible;
      if (!mark.isConnected) {
        // Lazy source replacement is repaired on the next frame. Do not hide
        // (and blur) the active editor during that temporary detached interval.
        note.style.visibility = note.classList.contains("editing") ? "visible" : "hidden";
        continue;
      }
      pin.style.left = `${Math.max(viewportLeft, Math.min(viewportRight - 20, rect.right - 10))}px`;
      pin.style.top = `${Math.max(viewportTop, Math.min(bottom - 20, rect.top - 18))}px`;
      // Keep an active editor reachable even if its anchor scrolls out of view.
      note.style.visibility = visible || note.classList.contains("editing") ? "visible" : "hidden";
      if (!note.classList.contains("open")) continue;
      // Saved notes stay in the transcript so they cannot hide behind the
      // composer. Editing hides composer/footer chrome; if a keyboard leaves a
      // tiny transcript band, use the remaining visual viewport below its top
      // rather than shrinking the textarea and confirmation controls to zero.
      const editing = note.classList.contains("editing");
      const noteTop = transcriptNoteTop;
      const noteBottom = editing && transcriptNoteBottom - noteTop < 120 ? bottom : transcriptNoteBottom;
      const availableHeight = Math.max(0, noteBottom - noteTop);
      const width = Math.max(0, Math.min(680, transcript.width - edge * 2, viewportRight - viewportLeft));
      note.style.width = `${width}px`;
      note.style.maxHeight = `${availableHeight}px`;
      const input = note.querySelector<HTMLTextAreaElement>("textarea");
      if (input && editing) {
        input.style.maxHeight = `${Math.max(0, Math.min(360, availableHeight - 24))}px`;
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight}px`;
      }
      // Enter animations transform the painted box; use its final layout size
      // so placement remains valid after the animation completes.
      const height = note.offsetHeight;
      const below = rect.bottom + 8;
      const above = rect.top - height - 8;
      const top = below + height <= noteBottom ? below : above >= noteTop ? above : Math.max(noteTop, noteBottom - height);
      note.style.left = `${Math.max(viewportLeft, Math.min(viewportRight - width, rect.left))}px`;
      note.style.top = `${Math.max(noteTop, top)}px`;
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(position);
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(messages);
  new MutationObserver(schedule).observe(messages, { childList: true, subtree: true });
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);

  return {
    mount(reference: QuoteSurface) {
      layer.append(reference.pin, reference.note);
      resize.observe(reference.note);
      schedule();
    },
    remove(reference: QuoteSurface) {
      resize.unobserve(reference.note);
      reference.pin.remove();
      reference.note.remove();
    },
    position,
    schedule,
  };
}
