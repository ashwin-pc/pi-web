// The UI's state: which session is current, reading or not, read positions and "new since you looked" marks, the
// queue of sessions that need you, and the 2 s dwell. Session data (titles, status, unread, transcripts) comes only
// from the client (src/client.js): this module keeps a view of its snapshot in sync and re-emits its events.
import {client} from './client.js';
import {asksQuestion} from './city-text.js';
const HOME = client.files.home;

const now = () => Date.now();
const listeners = new Set();
export const on = (fn) => listeners.add(fn);
export function emit(topic, detail) { for (const fn of listeners) fn(topic, detail); }

export const S = {
  sessions: new Map(),
  pinned: [], // the pinned lane order
  order: [], // the town's stable flick order (set by the town: plot by plot, row by row); people who are out
  currentId: client.initialSessionId,
  selectedId: client.initialSessionId, // the person in the spotlight (town view); equals currentId while reading
  reading: false, // the reading panel is open
  reduceMotion: false,
  broughtOut: new Set(), // quiet sessions you called out of their cottage
  queue: [], // the fence line: finished-and-unread sessions, first come first served
  quietMs: 12 * 36e5,
  settingsOpen: false,
  composer: {text: '', dictating: false, focused: false},
};

export function folderLabel(cwd) {
  if (cwd === HOME) return '~';
  return cwd.replace(HOME + '/', '');
}
export const folderTag = (cwd) => (cwd === HOME ? '~' : cwd.split('/').pop());

/** Group messages into turns: a turn is your prompt plus everything until the next prompt. */
export function turnsOf(s) {
  const turns = [];
  s.messages.forEach((m, i) => {
    if (m.type === 'user' || !turns.length) turns.push({start: i, end: i + 1});
    else turns[turns.length - 1].end = i + 1;
  });
  return turns;
}

/** Keep S.sessions (view objects: the client's session fields, its live message array, and UI-only read state) in
 * step with the client's snapshot. A session that becomes unread joins the back of the queue. */
function sync(first = false) {
  const snap = client.sessions.getSnapshot(), seen = new Set();
  for (const c of snap) {
    seen.add(c.id);
    let s = S.sessions.get(c.id);
    if (!s) {
      s = {seenCount: null, newMark: null, savedScroll: null, unreadAt: 0};
      S.sessions.set(c.id, s);
    }
    const wasUnread = s.unread;
    Object.assign(s, {id: c.id, title: c.title, short: c.short, cwd: c.cwd, origin: c.parent, lane: c.lane, note: c.note, model: c.model, ctx: c.context,
      running: c.running, error: c.error, unread: c.unread, synthetic: c.synthetic, messages: client.messages(c.id)});
    if (s.updatedAt !== c.updatedAt) { s.updatedAt = c.updatedAt; s.touched = c.updatedAt; }
    if (s.seenCount == null) {
      // Where you last looked: all of it, unless the client says otherwise.
      const turns = turnsOf(s);
      s.seenCount = c.seenTurns != null && c.seenTurns < turns.length ? turns[c.seenTurns].start : s.messages.length;
    }
    if (c.unread && !wasUnread && !first) { s.unreadAt = performance.now(); S.queue = [...S.queue.filter((x) => x !== c.id), c.id]; }
    if (!c.unread) S.queue = S.queue.filter((x) => x !== c.id);
  }
  for (const id of [...S.sessions.keys()]) if (!seen.has(id)) { S.sessions.delete(id); S.queue = S.queue.filter((x) => x !== id); }
  S.pinned = snap.filter((c) => c.pinned).sort((a, b) => a.pinOrder - b.pinOrder).map((c) => c.id);
  S.order = [...S.pinned];
  if (!S.sessions.has(S.currentId)) { S.currentId = S.pinned[0]; S.selectedId = S.currentId; client.actions.openSession(S.currentId); }
}
sync(true);
// The queue starts with the sessions that are already unread, oldest finish first.
S.queue = S.pinned.map((id) => S.sessions.get(id)).filter((s) => s.unread).sort((a, b) => a.touched - b.touched).map((s) => s.id);
client.actions.openSession(S.currentId);
client.sessions.subscribe(() => { sync(); emit('sessions'); });
client.events.subscribe((e) => emit('transcript', e.sessionId));

export const get = (id) => S.sessions.get(id);
export const pinnedIndex = (id) => S.pinned.indexOf(id);

export function waitingCount(s) {
  let n = 0;
  for (const o of S.sessions.values()) if (o.origin === s.id && o.running) n++;
  return n;
}
/** Status precedence as in pi-web: running > waiting on workers > error > unread (never the current one) > asking a
 * question > idle. "unread" and "asking" are the two kinds of "needs attention". */
export function indicator(s) {
  if (s.running) return 'running';
  if (waitingCount(s)) return 'waiting';
  if (s.error) return 'error';
  if (s.unread && s.id !== S.currentId) return 'unread';
  if (s.id !== S.currentId && asksQuestion(s)) return 'asking';
  return s.id === S.currentId ? 'current' : 'idle';
}
export const needsAttention = (s) => { const k = indicator(s); return k === 'unread' || k === 'asking'; };
/** Unread turns: turns that started after you last looked (at least 1 for an unread session). */
export function unreadTurns(s) { if (!s.unread) return asksQuestion(s) ? 1 : 0; return Math.max(1, turnsOf(s).filter((t) => t.end > s.seenCount).length); }
export function ageText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function durText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
export function statusText(s) {
  const k = indicator(s);
  if (k === 'running') return `Running ${durText(now() - s.running.since)}`;
  if (k === 'waiting') { const n = waitingCount(s); return `Waiting on ${n} worker${n > 1 ? 's' : ''}`; }
  if (k === 'unread') return 'Finished · unread';
  if (k === 'error') return `Error · ${s.error}`;
  if (k === 'asking') return 'Asking you a question';
  return `Idle · ${ageText(now() - s.touched)}`;
}
/** Quiet = idle, read, and untouched for 12 h or more: gone home to the cottage (unless you called them out). */
export function isQuiet(s) {
  return indicator(s) === 'idle' && !s.unread && now() - s.touched >= S.quietMs && !S.broughtOut.has(s.id) && s.id !== S.selectedId;
}
/** The fence line, in order: people who finished and whom you have not read yet. First come, first served. */
export const fenceLine = () => {
  const q = S.queue.map(get).filter((s) => s && s.unread && !s.running && !waitingCount(s));
  // Then the sessions whose latest reply asks you something (in pinned order).
  for (const id of S.pinned) { const s = get(id); if (s && !q.includes(s) && !s.running && !waitingCount(s) && !s.unread && asksQuestion(s)) q.push(s); }
  return q;
};
/** Who "what needs me" takes you to next: the fence line, minus the session you are already in. */
export const needsYou = () => fenceLine().filter((s) => s.id !== S.currentId);
/** Read only after a dwell: a session is marked read once you have been reading it for DWELL_MS without leaving. A quick
 * flick through the town leaves the fence line, and each "new since you looked" mark, as they were. */
export const DWELL_MS = 2000;
export function tickDwell(reading) {
  const d = S.dwell;
  if (!d || d.done) return;
  if (!reading) { d.since = null; return; }
  const t = performance.now();
  if (d.since == null) d.since = t;
  if (t - d.since >= (S.dwellMs ?? DWELL_MS)) markRead(d.id);
}
export function markRead(id) {
  const s = get(id);
  if (!s) return;
  if (S.dwell?.id === id) S.dwell.done = true;
  S.queue = S.queue.filter((x) => x !== id);
  if (s.unread) client.actions.markRead(id); // the client's snapshot changes, and the view follows
  else emit('sessions');
}
/** "What needs me": the first person in the fence line. */
/** "What needs me": the first in the fence line, or, while you are reading someone in the line (they stay in it
 * until the 2 s dwell marks them read), the one after them, so repeated presses walk the line instead of bouncing. */
export function nextNeedingYou() {
  const line = fenceLine(), i = line.findIndex((x) => x.id === S.currentId);
  if (i < 0) return line[0] || null;
  return line.length > 1 ? line[(i + 1) % line.length] : null;
}
/** What a running session is doing right now, from its latest running tool. */
export function currentTool(s) {
  if (!s.running) return null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.type === 'tool' && m.status === 'running') {
      const cmd = (m.args?.command || m.sub || '').trim();
      if (m.name === 'read') return {act: 'read', label: 'reading', tool: 'read'};
      if (m.name === 'write' || m.name === 'edit') return {act: 'edit', label: 'editing', tool: m.name};
      if (m.name === 'bash' && /^(rg|grep|find|fd|ag)\b/.test(cmd)) return {act: 'search', label: 'searching', tool: 'search'};
      return {act: 'bash', label: 'running', tool: m.name};
    }
  }
  return {act: 'bash', label: 'working', tool: 'bash'};
}

/** Make a session current. The caller saves the outgoing scroll first. */
export function openSession(id) {
  if (!S.sessions.has(id) || id === S.currentId) return false;
  const prev = get(S.currentId);
  // Leaving: only a session you actually read (dwelled in) loses its "new since you looked" mark.
  if (prev) { prev.touched = now(); if (S.dwell?.id === prev.id && S.dwell.done) { prev.seenCount = prev.messages.length; prev.newMark = null; } }
  S.currentId = id;
  S.selectedId = id;
  client.actions.openSession(id);
  const s = get(id);
  s.newMark = s.seenCount < s.messages.length ? s.seenCount : null;
  s.touched = now();
  S.dwell = {id, since: null, done: !s.unread && s.newMark == null};
  S.dwellLog = S.dwellLog || []; S.dwellLog.push({id, at: Math.round(performance.now())});
  emit('sessions');
  emit('current', {prev: prev?.id});
  return true;
}

// ---- prompts (the client runs them) -----------------------------------------------------------
export const clock = () => new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
export function sendPrompt(textIn) {
  const t = (textIn ?? S.composer.text).trim();
  if (!t) return false;
  if (!client.actions.prompt(S.currentId, t)) return false;
  S.composer.text = '';
  emit('composer');
  return true;
}
