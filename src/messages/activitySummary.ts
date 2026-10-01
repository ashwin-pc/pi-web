import { isMinimalDensity } from "../app/appearance.js";
import { iconElement } from "../app/icons.js";
import { createSessionRefChip, maxSessionRefs, type SessionRef } from "../app/sessionRefs.js";

/** Explicit render metadata, not a parser for tool output or referenced-session state. */
export type ActivityCardMetadata = { key?: string; refs?: readonly SessionRef[] };
const metadata = new WeakMap<HTMLElement, ActivityCardMetadata>();
export function setActivityCardMetadata(card: HTMLElement, value: ActivityCardMetadata) {
  metadata.set(card, { ...metadata.get(card), ...value });
}

export function liveThinkingPreview(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(-320);
}

export function consecutiveActivity<T>(items: readonly T[], eligible: (item: T) => boolean): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    if (eligible(item)) current.push(item);
    else if (current.length) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function activitySessionRefs(cards: readonly ActivityCardMetadata[]): SessionRef[] {
  const refs = new Map<string, SessionRef>();
  for (const card of cards) for (const ref of card.refs || []) {
    if (!refs.has(ref.sessionId) && refs.size < maxSessionRefs) refs.set(ref.sessionId, ref);
  }
  return [...refs.values()];
}

type Group = {
  element: HTMLDivElement;
  header: HTMLDivElement;
  toggle: HTMLButtonElement;
  label: HTMLSpanElement;
  status: HTMLSpanElement;
  body: HTMLDivElement;
  sessionRefs: HTMLDivElement;
  cards: HTMLElement[];
  refsKey: string;
  menu?: HTMLDivElement;
  more?: HTMLButtonElement;
};

/** Only consecutive cards are grouped. Prose, notifications and errors are boundaries. */
export function createActivitySummaries(options: {
  messagesEl: HTMLElement;
  openSession?: (id: string) => void;
  isStreaming: () => boolean;
  onLayout?: () => void;
}) {
  const { messagesEl, openSession } = options;
  const groups = new Set<Group>();
  const choices = new Map<string, { open: boolean; revision: number }>();
  const cardChoices = new Map<string, boolean>();
  const linkWidths = new WeakMap<HTMLElement, number>();
  let revision = 0;
  let nextId = 0;
  let frame = 0;
  let paused = false;
  let openMenu: Group | undefined;

  function key(card: HTMLElement) {
    return metadata.get(card)?.key || card.dataset.activityKey;
  }

  function remember(group: Group, open: boolean) {
    const choice = { open, revision: ++revision };
    for (const card of group.cards) {
      const id = key(card);
      if (id) choices.set(id, choice);
    }
    while (choices.size > 2000) choices.delete(choices.keys().next().value!);
  }

  function closeMenu(restoreFocus = false) {
    const previous = openMenu;
    if (!previous) return;
    previous.menu!.hidden = true;
    previous.more!.setAttribute("aria-expanded", "false");
    openMenu = undefined;
    if (restoreFocus) previous.more!.focus();
  }

  function positionMenu(group: Group) {
    if (!group.menu || !group.more) return;
    const anchor = group.more.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    group.menu.style.width = `${width}px`;
    group.menu.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
    const height = group.menu.getBoundingClientRect().height;
    const top = anchor.bottom + 4 + height <= window.innerHeight - 12 ? anchor.bottom + 4 : anchor.top - height - 4;
    group.menu.style.top = `${Math.max(12, top)}px`;
  }

  function sessionLink(ref: SessionRef) {
    const link = createSessionRefChip(ref, { openSession, className: "activitySessionLink" });
    link.textContent = ref.name || ref.sessionId.slice(-8);
    // A reference proves participation, not that the referenced session is running now.
    link.dataset.status = ref.status || "referenced";
    link.title = `Open session ${ref.name || ref.sessionId}${ref.status ? ` · ${ref.status}` : ""}`;
    link.setAttribute("aria-label", link.title);
    return link;
  }

  function renderSessionRefs(group: Group) {
    const refs = activitySessionRefs(group.cards.map(card => metadata.get(card) || {}));
    const signature = JSON.stringify(refs);
    if (signature === group.refsKey) return;
    if (openMenu === group) closeMenu();
    group.refsKey = signature;
    group.sessionRefs.replaceChildren();
    group.sessionRefs.hidden = !refs.length;
    group.menu = undefined;
    group.more = undefined;
    if (!refs.length) return;
    group.sessionRefs.append(iconElement("git-branch"));
    refs.forEach((ref, index) => {
      const link = sessionLink(ref);
      link.dataset.refIndex = String(index);
      group.sessionRefs.append(link);
    });
    const more = document.createElement("button");
    more.type = "button";
    more.className = "activitySessionMore";
    more.setAttribute("aria-label", `Show all ${refs.length} referenced sessions`);
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-haspopup", "dialog");
    const menu = document.createElement("div");
    menu.className = "activitySessionMenu";
    menu.id = `activity-sessions-${++nextId}`;
    menu.hidden = true;
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Referenced sessions");
    for (const ref of refs) menu.append(sessionLink(ref));
    more.setAttribute("aria-controls", menu.id);
    more.addEventListener("click", () => {
      if (openMenu === group) { closeMenu(); return; }
      closeMenu();
      menu.hidden = false;
      more.setAttribute("aria-expanded", "true");
      openMenu = group;
      positionMenu(group);
    });
    group.sessionRefs.append(more, menu);
    group.menu = menu;
    group.more = more;
  }

  function fitSessionRefs(group: Group) {
    const links = Array.from(group.sessionRefs.querySelectorAll<HTMLAnchorElement>(":scope > .activitySessionLink"));
    if (!links.length || !group.more) return;
    // Bound the nav, not the timestamp/user message. Leave counts readable at zoom.
    const style = getComputedStyle(group.header);
    const capacity = Math.max(0, group.header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - group.toggle.getBoundingClientRect().width - 10);
    const widths = links.map(link => {
      if (!link.hidden) linkWidths.set(link, link.getBoundingClientRect().width);
      return Math.min(120, linkWidths.get(link) || 100) + 8;
    });
    let used = 20;
    let visible = 0;
    const reserve = used + widths.reduce((sum, width) => sum + width, 0) <= capacity ? 0 : 32;
    for (const width of widths) {
      if (used + width + reserve > capacity) break;
      used += width;
      visible++;
    }
    links.forEach((link, index) => { link.hidden = index >= visible; });
    const hidden = links.length - visible;
    group.more.hidden = hidden === 0;
    const label = visible ? `+${hidden}` : `${hidden} session${hidden === 1 ? "" : "s"}`;
    if (group.more.textContent !== label) group.more.textContent = label;
  }

  function setOpen(group: Group, open: boolean) {
    group.element.classList.toggle("activitySummary--collapsed", !open);
    if (group.toggle.getAttribute("aria-expanded") !== String(open)) group.toggle.setAttribute("aria-expanded", String(open));
    const label = `${open ? "Hide" : "Show"} ${group.label.textContent}`;
    if (group.toggle.getAttribute("aria-label") !== label) group.toggle.setAttribute("aria-label", label);
    group.body.hidden = !open;
  }

  function createGroup(): Group {
    const element = document.createElement("div");
    element.className = "activitySummary";
    element.dataset.activityGroup = "true";
    const header = document.createElement("div");
    header.className = "activitySummaryHeader";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "activitySummaryToggle";
    const label = document.createElement("span");
    const status = document.createElement("span");
    status.className = "activitySummaryStatus";
    toggle.append(label, status);
    const sessionRefs = document.createElement("div");
    sessionRefs.className = "activitySessionRefs";
    sessionRefs.setAttribute("role", "navigation");
    sessionRefs.setAttribute("aria-label", "Sessions referenced by these tools");
    const body = document.createElement("div");
    body.className = "activitySummaryBody";
    body.id = `activity-cards-${++nextId}`;
    toggle.setAttribute("aria-controls", body.id);
    header.append(toggle, sessionRefs);
    element.append(header, body);
    const group: Group = { element, header, toggle, label, status, sessionRefs, body, cards: [], refsKey: "" };
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      remember(group, open);
      setOpen(group, open);
      if (!open) closeMenu();
      options.onLayout?.();
    });
    groups.add(group);
    return group;
  }

  function eligible(node: HTMLElement) {
    return node.matches(".toolCard:not(.runtimeErrorCard):not(.toolCard--error)");
  }

  function reconcile() {
    if (paused || (!isMinimalDensity() && groups.size === 0)) return;
    const flat = Array.from(messagesEl.children).flatMap(node => {
      const known = [...groups].find(group => group.element === node);
      return known ? Array.from(known.body.children) as HTMLElement[] : [node as HTMLElement];
    });
    const runs = isMinimalDensity() ? consecutiveActivity(flat, eligible) : [];
    const desired = new Map<HTMLElement, Group>();
    const activeGroups = new Set<Group>();
    for (const cards of runs) {
      const existing = [...groups].find(group => group.cards[0] === cards[0]);
      const group = existing || createGroup();
      group.cards = cards;
      const thinking = cards.filter(card => card.classList.contains("toolCard--thinking")).length;
      const tools = cards.length - thinking;
      const label = [tools ? `${tools} tool${tools === 1 ? "" : "s"}` : "", thinking ? `${thinking} thinking` : ""].filter(Boolean).join(" · ");
      if (group.label.textContent !== label) group.label.textContent = label;
      const active = cards.some(card => card.matches(".toolCard--running, .toolCard--thinkingStreaming"))
        || (options.isStreaming() && flat[flat.length - 1] === cards[cards.length - 1]);
      const status = active ? "running" : "";
      if (group.status.textContent !== status) group.status.textContent = status;
      const choice = cards.map(key).map(id => id ? choices.get(id) : undefined).filter(Boolean)
        .sort((a, b) => b!.revision - a!.revision)[0];
      if (choice) rememberChoiceForNewCards(group, choice);
      setOpen(group, choice?.open ?? active);
      renderSessionRefs(group);
      desired.set(cards[0], group);
      activeGroups.add(group);
    }
    const groupedCards = new Set(runs.flat());
    const output: HTMLElement[] = [];
    for (const node of flat) {
      const group = desired.get(node);
      if (group) output.push(group.element);
      else if (!groupedCards.has(node)) output.push(node);
    }
    // Move only when necessary: focused controls and live tool cards retain identity.
    let cursor = messagesEl.firstElementChild;
    for (const node of output) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else messagesEl.insertBefore(node, cursor);
    }
    for (const group of activeGroups) {
      let child = group.body.firstElementChild;
      for (const card of group.cards) {
        if (card === child) child = child.nextElementSibling;
        else group.body.insertBefore(card, child);
      }
    }
    for (const group of [...groups]) {
      if (activeGroups.has(group)) continue;
      if (openMenu === group) closeMenu();
      group.element.remove();
      groups.delete(group);
    }
    for (const group of activeGroups) fitSessionRefs(group);
  }

  function rememberChoiceForNewCards(group: Group, choice: { open: boolean; revision: number }) {
    for (const card of group.cards) {
      const id = key(card);
      if (id) choices.set(id, choice);
    }
  }

  function schedule() {
    if (paused || frame || (!isMinimalDensity() && groups.size === 0)) return;
    frame = requestAnimationFrame(() => { frame = 0; reconcile(); options.onLayout?.(); });
  }

  function capture() {
    cardChoices.clear();
    for (const card of messagesEl.querySelectorAll<HTMLElement>(".toolCard")) {
      const id = key(card);
      if (id) cardChoices.set(id, !card.classList.contains("toolCard--compactCollapsed"));
    }
    paused = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    closeMenu();
    groups.clear();
  }

  function restore() {
    for (const card of messagesEl.querySelectorAll<HTMLElement>(".toolCard")) {
      const id = key(card);
      const open = id ? cardChoices.get(id) : undefined;
      if (open === undefined) continue;
      card.classList.toggle("toolCard--compactCollapsed", !open);
      const toggle = card.querySelector<HTMLButtonElement>(".toolCardExpandToggle");
      if (toggle) {
        const name = card.classList.contains("toolCard--thinking") ? "thinking" : "tool details";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", `${open ? "Hide" : "Show"} ${name}`);
        toggle.title = toggle.getAttribute("aria-label")!;
      }
    }
    paused = false;
    reconcile();
  }

  document.addEventListener("pointerdown", event => {
    if (openMenu && event.target instanceof Node && !openMenu.sessionRefs.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && openMenu) { event.preventDefault(); closeMenu(true); }
  });
  messagesEl.addEventListener("scroll", () => { if (openMenu) positionMenu(openMenu); }, { passive: true });
  const resize = new ResizeObserver(() => {
    for (const group of groups) fitSessionRefs(group);
    if (openMenu) positionMenu(openMenu);
  });
  resize.observe(messagesEl);

  return {
    schedule,
    reconcile,
    capture,
    restore,
    reset() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      paused = false;
      closeMenu();
      groups.clear(); choices.clear(); cardChoices.clear();
    },
  };
}
