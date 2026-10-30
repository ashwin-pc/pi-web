// pi-web (usability round 2): the /view/vr page on touch screens (the foldable's inner and cover screens, phones and
// tablets), without a headset. Touch gets its own gestures, each with a visible, tappable way to do the same thing:
//
//   tap                       select what is under the finger (an avatar, a button, a city card)
//   swipe the conversation    sideways: the next or previous session (the panel follows the finger, then snaps)
//   drag the conversation     up or down: scroll it (a flick keeps it moving)
//   drag the city             up or down: change height; sideways: look around
//   pinch                     zoom (the city, or the conversation's text size)
//   long-press an avatar      its card: Open, Beside, Fly to (tapping the current one again does the same)
//
// The 3D bar is replaced by a DOM dock along the bottom (sideways scrolling with the thumb, 48 dp targets), with
// Needs you, Home and More fixed at its end; More opens a sheet with every setting, zoom and height buttons, the
// layouts, and help. Swipes starting within EDGE px of the left or right edge are left to the browser's back gesture.
import {S, get, indicator, statusText, unreadTurns, needsYou, on} from './state.js';
import {A, renderer, clamp, DEG} from './core.js';
import {host} from './host.js';
import * as V from './views.js';
import {UIB} from './bar.js';
import {drawAvatar} from './avatars.js';
import {previewText} from './city-text.js';
import {switchBy, isTable, setTable, goHome, flyToSession} from './app.js';
import {mouse, pressStart, pressMove, pressEnd, logInput, head, intersect} from './input.js';
import {desk, setPointerAt, pointerGone, updateMouseRay, fitCamera} from './desktop.js';
import * as N from './city-nav.js';
import {readers} from './reader.js';

const UI = V.UI;
const EDGE = 24, LONG_MS = 450, SLOP = 8;
export const coarse = window.matchMedia('(pointer: coarse)');
export const touch = {dock: false, log: [], card: null, sheet: null};
A.touch = touch;
const tlog = (kind, extra = {}) => { touch.log.push({t: Math.round(performance.now()), kind, ...extra}); if (touch.log.length > 200) touch.log.shift(); logInput(`touch:${kind}`); };
const root = () => host.el || document.body;
const el = renderer.domElement;

// ------------------------------------------------------------------ framing: what a touch screen shows while reading
/** The view's horizontal field (degrees) while reading in the focus layout: a narrow portrait screen (the cover
 * screen) frames the conversation alone (its columns are a look or a More button away); a wider one frames the whole
 * cockpit, wide enough horizontally (72°) and vertically (58°). Multi layouts keep their own widths. */
function frameHfov() {
  if (!touch.dock || A.r3?.multi()) return null;
  const a = window.innerWidth / Math.max(1, window.innerHeight);
  if (a < 0.8) return 40;
  const fromV = 2 * Math.atan(Math.tan((58 * DEG) / 2) * a) / DEG;
  return Math.max(72, fromV);
}
desk.frameHfov = frameHfov;

// ------------------------------------------------------------------ gestures on the scene
const pts = new Map();
let g = null; // the current one-finger gesture
// On the conversation (its text, chips and header): a sideways drag is a swipe, a vertical one scrolls, a tap clicks.
const onReader = (h) => !!(h && (h.reader || h.panel?.isTurn || h.panel?.reader) && !h.region?.strip && !h.region?.drag);
// The cockpit's other columns swipe too (on a wide screen the conversation is only a third of it); the sky looks around.
const COCKPIT = new Set(['nav', 'context', 'rail', 'composer', 'layout-chip']);
const swipeable = (h) => onReader(h) || (COCKPIT.has(h?.panel?.name) && !h.region?.drag);
const radPerPx = () => (desk.hfov * DEG) / Math.max(1, window.innerWidth);
function cancelLong() { if (g?.timer) { clearTimeout(g.timer); g.timer = 0; } }
function endGesture() { cancelLong(); desk.instant = false; g = null; pointerGone(); }
el.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || renderer.xr.isPresenting) return;
  e.preventDefault();
  el.setPointerCapture?.(e.pointerId);
  pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
  hideCoach(); closeSheet();
  if (pts.size === 2) { // a second finger: pinch (whatever the first one was doing is dropped)
    if (g?.mode === 'swipe') desk.readYaw = 0;
    cancelLong(); mouse.press = null;
    const [a, b] = [...pts.values()];
    g = {mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: desk.zoom};
    return;
  }
  if (pts.size > 2) return;
  setPointerAt(e); updateMouseRay();
  pressStart(mouse);
  const hit = mouse.press?.hit, reg = hit?.region;
  g = {x0: e.clientX, y0: e.clientY, t0: performance.now(), hit, mode: null, edge: e.clientX < EDGE || e.clientX > window.innerWidth - EDGE,
    look: {yaw: desk.lookYaw, ryaw: desk.readYaw || 0, rpitch: desk.readPitch || 0}, lastY: e.clientY};
  const sid = reg?.session || hit?.card;
  if (sid) g.timer = setTimeout(() => { if (!g || g.mode) return; g.mode = 'long'; mouse.press = null; navigator.vibrate?.(12); openCard(sid); tlog('long-press', {sid}); }, LONG_MS);
});
el.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
  pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (!g) return;
  if (g.mode === 'pinch') {
    if (pts.size < 2) return;
    const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    const z = clamp(g.z0 * g.d0 / Math.max(20, d), 0.45, 1.8);
    if (Math.abs(z - desk.zoom) > 0.002) { desk.zoom = z; fitCamera(); g.moved = true; }
    return;
  }
  if (g.mode === 'long') return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.mode) {
    if (Math.hypot(dx, dy) < SLOP) return;
    cancelLong();
    const pm = mouse.press?.mode, horiz = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (pm === 'strip' && horiz && S.reading) g.mode = g.edge ? 'none' : 'swipe'; // sideways off the strip: a swipe
    else if (pm === 'drag' || pm === 'strip') g.mode = 'press'; // a region that owns its drag (the strip, a tile's corner)
    else if (S.reading && onReader(g.hit)) g.mode = horiz ? (g.edge ? 'none' : 'swipe') : 'press';
    else if (S.reading && swipeable(g.hit)) g.mode = horiz ? (g.edge ? 'none' : 'swipe') : 'press';
    else if (!S.reading && !horiz) g.mode = 'alt';
    else g.mode = g.edge ? 'none' : 'look';
    if (g.mode !== 'press') mouse.press = null;
    desk.instant = g.mode === 'swipe' || g.mode === 'look';
    tlog(`drag:${g.mode}`);
  }
  if (g.mode === 'press') { setPointerAt(e); updateMouseRay(); pressMove(mouse); return; }
  if (g.mode === 'swipe') { desk.readYaw = dx * radPerPx(); (g.trail ||= []).push([performance.now(), e.clientX]); if (g.trail.length > 6) g.trail.shift(); return; } // the conversation follows the finger
  if (g.mode === 'look') {
    if (S.reading) { desk.readYaw = g.look.ryaw + dx * radPerPx(); desk.readPitch = clamp(g.look.rpitch + dy * radPerPx(), -0.6, 0.6); }
    else desk.lookYaw = g.look.yaw + dx * radPerPx();
    return;
  }
  if (g.mode === 'alt') { const step = (g.lastY - e.clientY) / Math.max(1, window.innerHeight); g.lastY = e.clientY; if (step) N.fly(head.yaw, 0, 0, step * 3, 1, head.local); } // drag up: higher
});
/** A tap that lands just beside a small 3D button takes it: the nearest clickable target within SLOP_PX (a 33 px button
 * then answers like a 48+ px one; the cover screen held sideways draws the cockpit's buttons that small). */
const SLOP_PX = 14;
const clickable = (h) => !!(h && (h.region?.click || h.card || h.label));
function nearTap(x, y) {
  let best = null;
  for (const r of [7, SLOP_PX]) for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    setPointerAt({clientX: x + Math.cos(a) * r, clientY: y + Math.sin(a) * r}); updateMouseRay();
    const h = intersect(mouse);
    if (clickable(h) && (!best || r < best.r)) best = {h, r};
    if (best && best.r === 7 && k === 7) break;
  }
  setPointerAt({clientX: x, clientY: y}); updateMouseRay();
  return best?.h || null;
}
function up(e, cancelled) {
  if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (!g) { if (!pts.size) pointerGone(); return; }
  if (g.mode === 'pinch') { if (!pts.size) { tlog('pinch', {zoom: +desk.zoom.toFixed(2)}); endGesture(); } return; }
  cancelLong();
  const dx = e.clientX - g.x0, dt = Math.max(1, performance.now() - g.t0);
  if (!cancelled) {
    if (!g.mode && mouse.press && !clickable(mouse.press.hit) && !mouse.press.hit?.region?.strip) { const n = nearTap(e.clientX, e.clientY); if (n) { mouse.press.hit = n; mouse.press.reg = n.region; tlog('tap-near', {target: n.region?.id}); } }
    if (g.mode === 'press' || !g.mode) { setPointerAt(e); updateMouseRay(); if (!g.mode && touch.dock && g.hit?.region?.session === S.currentId && S.reading) openCard(S.currentId); else pressEnd(mouse); if (!g.mode) tlog('tap', {target: g.hit?.region?.id || (g.hit?.reader ? 'reader' : null)}); }
    else if (g.mode === 'swipe') {
      // Fast: the last ~100 ms of the finger's motion (px/ms), not the whole gesture's average.
      const tr = (g.trail || []).filter(([t]) => performance.now() - t < 160), v = tr.length > 1 ? (tr.at(-1)[1] - tr[0][1]) / Math.max(1, tr.at(-1)[0] - tr[0][0]) : dx / dt;
      const fast = Math.abs(v) > 0.4 && Math.abs(dx) > 40 && Math.sign(v) === Math.sign(dx);
      // Far or fast enough: the next session slides in from the side the finger left (the panels animate the switch;
      // the view returns to the middle at once, so nothing slides back the other way).
      if (Math.abs(dx) > Math.min(window.innerWidth * 0.18, 110) || fast) { const dir = dx < 0 ? 1 : -1; desk.readYaw = 0; desk.yaw -= dx * radPerPx(); switchBy(dir); navigator.vibrate?.(8); tlog('swipe', {dir}); }
      else { desk.readYaw = 0; tlog('swipe-back'); } // not far enough: it springs back
    }
  } else { if (g.mode === 'swipe') desk.readYaw = 0; mouse.press = null; }
  endGesture();
}
el.addEventListener('pointerup', (e) => up(e, false));
el.addEventListener('pointercancel', (e) => up(e, true));
el.addEventListener('contextmenu', (e) => { if (touch.dock) e.preventDefault(); });

// ------------------------------------------------------------------ the dock (replaces the 3D bar on touch screens)
const dock = document.createElement('nav');
dock.id = 'vrDock'; dock.className = 'vrChrome'; dock.setAttribute('aria-label', 'Sessions');
dock.innerHTML = '<div class="vrDockScroll" role="list"></div><div class="vrDockFixed"></div>';
const scroller = dock.firstChild, fixed = dock.lastChild;
const mk = (id, cls, html, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.dataset.id = id; b.innerHTML = html; b.setAttribute('aria-label', label); return b; };
const ICON = {
  bell: '<svg viewBox="0 0 24 24"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
  house: '<svg viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
};
const needsBtn = mk('bar:needs', 'vrChip', `${ICON.bell}<span class="l">Needs you</span><b class="n"></b>`, 'What needs you');
const homeBtn = mk('bar:home', 'vrChip', `${ICON.house}<span class="l">Home</span>`, 'Fly home');
const moreBtn = mk('bar:more', 'vrChip', `${ICON.more}<span class="l">More</span><b class="n"></b>`, 'More: settings, zoom, layouts, help');
// While reading, Reply takes Home's place (Home is in More, and City is on the conversation's header): the reply box is
// always one tap away, whatever the zoom or the scene shows.
const replyBtn = mk('dock:reply', 'vrChip', `${ICON.reply}<span class="l">Reply</span>`, 'Reply to this session');
fixed.append(replyBtn, needsBtn, homeBtn, moreBtn);
replyBtn.addEventListener('click', () => { closeSheet(); UI.focusComposer('dock'); tlog('reply'); });
needsBtn.addEventListener('click', () => { const id = UI.needsYou(); tlog('needs', {id}); if (!id) flash(needsBtn); });
homeBtn.addEventListener('click', () => { closeSheet(); if (S.reading) UI.closeReader(); goHome(); tlog('home'); });
moreBtn.addEventListener('click', () => { if (touch.sheet === 'more') closeSheet(); else openMore(); });
function flash(b) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
const avatarBtns = new Map();
function avatarBtn(id) {
  let b = avatarBtns.get(id);
  if (b) return b;
  b = mk(`avatar:${id}`, 'vrAv', '<canvas width="96" height="96"></canvas><b class="badge"></b><span class="t"></span>', '');
  b.setAttribute('role', 'listitem');
  // Long-press: the session's card. A tap opens it (or, for the one already open, shows its card).
  let timer = 0, sx = 0, sy = 0, fired = false;
  b.addEventListener('pointerdown', (e) => { fired = false; sx = e.clientX; sy = e.clientY; clearTimeout(timer); timer = setTimeout(() => { fired = true; navigator.vibrate?.(12); openCard(id); tlog('long-press', {sid: id}); }, LONG_MS); });
  b.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP) clearTimeout(timer); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => clearTimeout(timer));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    if (fired) { e.preventDefault(); fired = false; return; }
    if (id === S.currentId && S.reading) { openCard(id); return; }
    closeSheet(); UIB.choose(id); tlog('dock', {sid: id});
  });
  avatarBtns.set(id, b);
  return b;
}
let dockSig = '';
function syncDock() {
  const show = coarse.matches && !renderer.xr.isPresenting;
  if (show !== touch.dock) { touch.dock = show; UI.touch = show; document.body.classList.toggle('vrTouch', show); dockSig = ''; fitCamera(); for (const r of readers) r.header.invalidate(); }
  if (!show) return;
  const need = needsYou().length;
  const sig = S.pinned.map((id) => { const s = get(id); return `${id}:${indicator(s)}:${unreadTurns(s)}:${s.title}`; }).join('|') + `|${S.currentId}|${S.reading}|${need}`;
  if (sig === dockSig) return;
  dockSig = sig;
  const want = S.pinned.map(avatarBtn);
  if (want.length !== scroller.children.length || want.some((b, i) => scroller.children[i] !== b)) scroller.replaceChildren(...want);
  for (const id of S.pinned) {
    const s = get(id), b = avatarBtns.get(id), k = indicator(s), cur = id === S.currentId;
    b.dataset.state = k; b.classList.toggle('cur', cur);
    b.setAttribute('aria-label', `${s.title}: ${statusText(s)}`); b.setAttribute('aria-current', cur ? 'true' : 'false');
    b.querySelector('.t').textContent = s.short || s.title;
    const n = k === 'unread' || k === 'asking' ? (k === 'asking' ? '?' : String(unreadTurns(s))) : k === 'error' ? '!' : '';
    const badge = b.querySelector('.badge'); badge.textContent = n; badge.hidden = !n;
    const c = b.querySelector('canvas').getContext('2d'); c.clearRect(0, 0, 96, 96); drawAvatar(c, id, 48, 48, 44, {dim: k === 'idle' ? 0.45 : 0});
  }
  needsBtn.querySelector('.n').textContent = need ? String(need) : '';
  needsBtn.querySelector('.l').textContent = need ? 'Needs you' : 'Nobody';
  needsBtn.classList.toggle('on', need > 0);
  replyBtn.hidden = !S.reading; homeBtn.hidden = S.reading;
  const cur = avatarBtns.get(S.currentId);
  if (cur && cur !== touch.lastCur) { touch.lastCur = cur; cur.scrollIntoView({inline: 'nearest', block: 'nearest', behavior: S.reduceMotion ? 'auto' : 'smooth'}); }
}
coarse.addEventListener?.('change', () => syncDock());
on((topic) => { if (topic === 'sessions' || topic === 'current' || topic === 'tick') syncDock(); });
setInterval(syncDock, 400);

// ------------------------------------------------------------------ sheets: a session's card, and More
const sheet = document.createElement('section');
sheet.id = 'vrSheet'; sheet.className = 'vrChrome'; sheet.hidden = true; sheet.setAttribute('role', 'dialog');
function closeSheet() { if (!touch.sheet) return; touch.sheet = null; touch.card = null; sheet.hidden = true; moreBtn.classList.remove('on'); }
function sheetShell(title, body) {
  sheet.innerHTML = `<header><h2></h2><button type="button" class="x" aria-label="Close">×</button></header>${body}`;
  sheet.querySelector('h2').textContent = title;
  sheet.querySelector('.x').addEventListener('click', closeSheet);
  sheet.hidden = false;
}
export function openCard(sid) {
  const s = get(sid); if (!s) return;
  touch.sheet = 'card'; touch.card = sid;
  sheetShell(s.title, '<p class="st"></p><p class="pv"></p><div class="acts"><button type="button" data-a="open" class="pri">Open</button><button type="button" data-a="beside">Beside</button><button type="button" data-a="fly">Fly to</button></div>');
  const k = indicator(s);
  sheet.querySelector('.st').textContent = k === 'unread' ? `${statusText(s)} · ${unreadTurns(s)} unread turn${unreadTurns(s) > 1 ? 's' : ''}` : statusText(s);
  sheet.querySelector('.pv').textContent = previewText(s) || 'No messages yet.';
  sheet.querySelector('[data-a="open"]').addEventListener('click', () => { closeSheet(); UIB.choose(sid); tlog('card:open', {sid}); });
  sheet.querySelector('[data-a="beside"]').addEventListener('click', () => { closeSheet(); if (!S.reading) UIB.choose(S.currentId === sid ? sid : S.currentId); UIB.beside(sid); tlog('card:beside', {sid}); });
  sheet.querySelector('[data-a="fly"]').addEventListener('click', () => { closeSheet(); if (S.reading) UI.closeReader(); flyToSession(sid); tlog('card:fly', {sid}); });
}
function openMore() {
  touch.sheet = 'more'; moreBtn.classList.add('on');
  const row = (label, html) => `<div class="row"><span>${label}</span><div class="ctl">${html}</div></div>`;
  const tog = (id, on) => `<button type="button" data-t="${id}" class="tog" aria-pressed="${on}">${on ? 'On' : 'Off'}</button>`;
  const r3m = A.r3?.mode?.() || 'focus';
  sheetShell('More', `<div class="rows">
    ${row('Zoom <small>or pinch</small>', '<button type="button" data-z="1.18" aria-label="Zoom out">−</button><output class="zv"></output><button type="button" data-z="0.85" aria-label="Zoom in">+</button>')}
    ${row('Height <small>or drag the city up and down</small>', '<button type="button" data-h="-1" aria-label="Lower">↓</button><button type="button" data-h="1" aria-label="Higher">↑</button>')}
    ${S.reading ? row('Look <small>or drag beside the conversation</small>', '<button type="button" data-l="-1">◀ Outline</button><button type="button" data-l="0">Centre</button><button type="button" data-l="1">Artifacts ▶</button>') : ''}
    ${S.reading ? row('Layout', ['focus', 'pair', 'triptych', 'wall'].map((m) => `<button type="button" data-m="${m}" aria-pressed="${r3m === m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('')) : ''}
    ${S.reading ? row('Home <small>the city from above</small>', '<button type="button" data-home="1">Fly home</button>') : ''}
    ${row('Reduce motion', tog('motion', S.reduceMotion))}
    ${row('Vignette', tog('vignette', S.vignette !== false))}
    ${row('Tabletop', tog('table', isTable()))}
    ${row('Gestures', '<button type="button" data-help="1">Show the gestures</button>')}
    ${row('Back to chat', '<button type="button" data-exit="1">Open the chat</button>')}
  </div>`);
  const zv = sheet.querySelector('.zv'), showZ = () => { zv.textContent = `${Math.round(100 / desk.zoom)}%`; };
  showZ();
  sheet.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => { desk.zoom = clamp(desk.zoom * +b.dataset.z, 0.45, 1.8); fitCamera(); showZ(); tlog('zoom', {zoom: +desk.zoom.toFixed(2)}); }));
  sheet.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => { if (S.reading) UI.closeReader(); N.fly(head.yaw, 0, 0, +b.dataset.h * 0.6, 1, head.local); tlog('height', {dir: +b.dataset.h}); }));
  // Look closes the sheet (round 3: it stayed open over what it had just turned to).
  sheet.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => { desk.readYaw = -(+b.dataset.l) * 26 * DEG; desk.readPitch = 0; closeSheet(); tlog('look', {to: +b.dataset.l}); }));
  sheet.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { A.r3?.setMode(b.dataset.m); closeSheet(); tlog('layout', {mode: b.dataset.m}); }));
  sheet.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.t;
    if (t === 'motion') UIB.setReduceMotion(!S.reduceMotion); else if (t === 'vignette') UIB.setVignette(S.vignette === false); else setTable(!isTable());
    const onNow = t === 'motion' ? S.reduceMotion : t === 'vignette' ? S.vignette !== false : !isTable();
    b.setAttribute('aria-pressed', String(onNow)); b.textContent = onNow ? 'On' : 'Off';
  }));
  sheet.querySelector('[data-home]')?.addEventListener('click', () => { closeSheet(); UI.closeReader(); goHome(); tlog('home'); });
  sheet.querySelector('[data-help]').addEventListener('click', () => { closeSheet(); showCoach(true); });
  sheet.querySelector('[data-exit]').addEventListener('click', () => UIB.exit());
}

// ------------------------------------------------------------------ the gesture coach (first visit, and from More)
const coach = document.createElement('aside');
coach.id = 'vrCoach'; coach.className = 'vrChrome'; coach.hidden = true; coach.setAttribute('role', 'note');
coach.innerHTML = `<button type="button" class="x" aria-label="Dismiss">×</button><b>Touch gestures</b><ul>
  <li><b>Tap</b> an avatar to read that session</li><li><b>Swipe</b> the conversation sideways for the next one</li>
  <li><b>Drag</b> to scroll; in the city, drag up or down to change height</li><li><b>Pinch</b> to zoom</li>
  <li><b>Long-press</b> an avatar for Open, Beside and Fly to</li></ul>`;
coach.querySelector('.x').addEventListener('click', () => hideCoach());
document.addEventListener('pointerdown', (e) => { if (!coach.hidden && !coach.contains(e.target)) hideCoach(); }, true); // any touch dismisses it
let coachTimer = 0;
function showCoach(force = false) {
  let seen = false; try { seen = localStorage.getItem('pi-web.vr.coach') === '1'; } catch { /* storage may be blocked */ }
  if (seen && !force) return;
  coach.hidden = false; clearTimeout(coachTimer); coachTimer = setTimeout(hideCoach, 12000);
  try { localStorage.setItem('pi-web.vr.coach', '1'); } catch { /* optional */ }
}
function hideCoach() { coach.hidden = true; clearTimeout(coachTimer); }

// ------------------------------------------------------------------ typing on a touch screen
// The reply box shows as a real field above the dock while you type (the on-screen keyboard covers the 3D one).
const typing = document.createElement('div');
typing.id = 'vrTyping'; typing.className = 'vrChrome'; typing.hidden = true;
typing.innerHTML = '<button type="button" class="nl" aria-pressed="false" title="Enter adds a new line">↵ New line</button><button type="button" class="send">Send</button>';
const nlBtn = typing.querySelector('.nl');
typing.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the field focused (and the keyboard up)
nlBtn.addEventListener('click', () => { UI.toggleNewline(); nlBtn.setAttribute('aria-pressed', String(!!S.composer.newline)); nlBtn.textContent = S.composer.newline ? '↵ New line: on' : '↵ New line'; });
typing.querySelector('.send').addEventListener('click', () => { UI.send(); tlog('send'); });
function syncTyping() { const show = touch.dock && document.activeElement === UI.composerInput; typing.hidden = !show; document.body.classList.toggle('vrTyping', show); }
document.addEventListener('focusin', syncTyping); document.addEventListener('focusout', () => setTimeout(syncTyping, 0));

root().append(dock, sheet, coach, typing);
syncDock();
if (touch.dock) showCoach();

/** For tests and tools: the DOM element that stands for a bar target on touch screens (avatar:<id>, bar:needs,
 * bar:home, bar:more), or null when the 3D bar is in use. */
export function domTarget(id) {
  if (!touch.dock) return null;
  if (id.startsWith('avatar:')) return avatarBtns.get(id.slice(7)) || null;
  return {'bar:needs': needsBtn, 'bar:home': homeBtn, 'bar:more': moreBtn}[id] || null;
}
touch.domTarget = domTarget; touch.openCard = openCard; touch.openMore = openMore; touch.closeSheet = closeSheet; touch.showCoach = showCoach;
