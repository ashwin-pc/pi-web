import type { SessionLaneId, SessionMarkerColorId } from "../app/types.js";
import { sessionLaneIcon, sessionLaneMeta } from "./lanes.js";

export type SessionInspectorItem = {
  sessionId: string;
  name: string;
  lane?: SessionLaneId;
  bucket?: SessionMarkerColorId;
  note?: string;
  unread?: boolean;
};

export type SessionInspectorInvocationContext = "tab" | "lane" | "session";

type InspectorOptions = {
  item: (sessionId: string) => SessionInspectorItem;
  moveToLane: (sessionId: string, lane: SessionLaneId) => void;
  setBucket: (sessionId: string, color: SessionMarkerColorId) => void;
  setNote: (sessionId: string, note: string) => void;
  removeFromLanes: (sessionId: string) => void;
  openSession: (sessionId: string) => void;
  setUnread: (sessionId: string, unread: boolean) => void;
};

const colors: SessionMarkerColorId[] = ["blue", "purple", "yellow", "red", "green", "orange", "cyan", "pink"];

export function buildSessionInspector(options: InspectorOptions) {
  let backdrop: HTMLDivElement | undefined;
  let suppressClickUntil = 0;
  const close = () => { backdrop?.remove(); backdrop = undefined; };

  const show = (clientX: number, clientY: number, item: SessionInspectorItem, context: SessionInspectorInvocationContext) => {
    close();
    backdrop = document.createElement("div"); backdrop.className = "sessionInspectorBackdrop";
    const card = document.createElement("section"); card.className = "sessionInspector"; card.setAttribute("role", "dialog"); card.setAttribute("aria-label", `Actions for ${item.name}`);
    const header = document.createElement("header"); const title = document.createElement("strong"); title.textContent = item.name; header.append(title); card.append(header);

    const laneRow = document.createElement("div"); laneRow.className = "sessionInspectorRow"; const laneLabel = document.createElement("span"); laneLabel.textContent = "Lane"; laneRow.append(laneLabel);
    const lanes = document.createElement("div"); lanes.className = "sessionInspectorLanes";
    const none = document.createElement("button"); none.type = "button"; none.textContent = "×"; none.title = "Remove from lanes"; none.className = item.lane ? "" : "selected"; none.addEventListener("click", () => { options.removeFromLanes(item.sessionId); close(); }); lanes.append(none);
    for (const lane of ["pinned", "parked", "bookmarks"] as SessionLaneId[]) {
      const button = document.createElement("button"); button.type = "button"; button.className = item.lane === lane ? "selected" : ""; button.title = sessionLaneMeta[lane].label; button.setAttribute("aria-label", `Move to ${sessionLaneMeta[lane].label}`); button.append(sessionLaneIcon(lane)); button.addEventListener("click", () => { if (item.lane !== lane) options.moveToLane(item.sessionId, lane); close(); }); lanes.append(button);
    }
    laneRow.append(lanes); card.append(laneRow);

    const bucketRow = document.createElement("div"); bucketRow.className = "sessionInspectorRow"; const bucketLabel = document.createElement("span"); bucketLabel.textContent = "Bucket"; bucketRow.append(bucketLabel);
    const buckets = document.createElement("div"); buckets.className = "sessionInspectorBuckets";
    for (const color of colors) { const button = document.createElement("button"); button.type = "button"; button.className = `marker-${color}${item.bucket === color ? " selected" : ""}`; button.title = `${color} bucket`; button.setAttribute("aria-label", button.title); button.addEventListener("click", () => { options.setBucket(item.sessionId, color); close(); }); buckets.append(button); }
    bucketRow.append(buckets); card.append(bucketRow);

    const note = document.createElement("input"); note.type = "text"; note.className = "sessionInspectorNote"; note.placeholder = item.lane ? "Add a one-line note" : "Move to a lane to add a note"; note.value = item.note || ""; note.disabled = !item.lane; note.setAttribute("aria-label", "Session note");
    const saveNote = () => { if (note.value.trim() !== (item.note || "")) options.setNote(item.sessionId, note.value.trim()); };
    note.addEventListener("change", saveNote);
    const keepNoteVisible = () => {
      const viewport = window.visualViewport;
      const visibleTop = viewport?.offsetTop || 0;
      const visibleBottom = visibleTop + (viewport?.height || window.innerHeight);
      const rect = card.getBoundingClientRect();
      if (rect.bottom > visibleBottom - 8) card.style.top = `${Math.max(visibleTop + 8, visibleBottom - rect.height - 8)}px`;
    };
    note.addEventListener("focus", () => { card.classList.add("editing-note"); requestAnimationFrame(keepNoteVisible); window.visualViewport?.addEventListener("resize", keepNoteVisible); });
    note.addEventListener("blur", () => { card.classList.remove("editing-note"); window.visualViewport?.removeEventListener("resize", keepNoteVisible); });
    note.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveNote(); close(); } }); card.append(note);

    const actions = document.createElement("footer");
    const unread = document.createElement("button"); unread.type = "button"; unread.textContent = item.unread ? "Mark as read" : "Mark as unread"; unread.addEventListener("click", () => { options.setUnread(item.sessionId, !item.unread); close(); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger"; remove.textContent = "Remove"; remove.disabled = !item.lane; remove.addEventListener("click", () => { options.removeFromLanes(item.sessionId); close(); });
    actions.append(unread);
    if (context !== "tab") { const open = document.createElement("button"); open.type = "button"; open.textContent = "↗ Open"; open.addEventListener("click", () => { options.openSession(item.sessionId); close(); }); actions.append(open); }
    actions.append(remove); actions.dataset.actionCount = String(actions.childElementCount); card.append(actions);
    backdrop.append(card); document.body.append(backdrop);

    requestAnimationFrame(() => {
      const rect = card.getBoundingClientRect(); const margin = 8;
      const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, clientX - rect.width / 2));
      const top = clientY + rect.height + 8 <= window.innerHeight ? clientY + 8 : Math.max(margin, clientY - rect.height - 8);
      card.style.left = `${left}px`; card.style.top = `${top}px`; backdrop?.classList.add("open");
    });
    backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop) close(); });
  };

  window.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  const attach = (element: HTMLElement, sessionId: string, context: SessionInspectorInvocationContext, holdDelayMs = 280) => {
    let timer: number | undefined; let startX = 0; let startY = 0;
    const cancel = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; element.classList.remove("sessionInspectorPressing"); };
    element.addEventListener("pointerdown", (event) => { if (event.button !== 0 || (event.target as Element | null)?.closest(".sessionLaneDragHandle,.sessionLaneDrawerActions,.sessionBarTabAction")) return; startX = event.clientX; startY = event.clientY; element.classList.add("sessionInspectorPressing"); timer = window.setTimeout(() => { timer = undefined; element.classList.remove("sessionInspectorPressing"); element.dispatchEvent(new CustomEvent("session-inspector-open", { bubbles: true })); suppressClickUntil = performance.now() + 350; show(startX, startY, options.item(sessionId), context); }, holdDelayMs); });
    element.addEventListener("pointermove", (event) => { if (timer !== undefined && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel(); });
    element.addEventListener("pointerup", cancel); element.addEventListener("pointercancel", cancel);
    element.addEventListener("contextmenu", (event) => { if ((event.target as Element | null)?.closest(".sessionLaneDragHandle,.sessionLaneDrawerActions,.sessionBarTabAction")) return; event.preventDefault(); cancel(); show(event.clientX, event.clientY, options.item(sessionId), context); });
    element.addEventListener("click", (event) => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } }, true);
  };
  const openAt = (element: HTMLElement, sessionId: string, context: SessionInspectorInvocationContext) => { const rect = element.getBoundingClientRect(); show(rect.left + rect.width / 2, rect.bottom, options.item(sessionId), context); };
  return { attach, openAt, close };
}
