// Round 3, several sessions at once. Layouts arrange panels around you on the sphere (FOCUS.D away); they never move
// you. focus: the cockpit (focus.js). pair: two tiles at ±28°, 50° wide. triptych: three at −45°, 0°, +45°. wall: up
// to six in a 3 × 2 curved grid out to ±73°. The first item is the focused one (the primary slot); the others are
// throttled live tiles (tiles.js). Open beside adds a session; selecting a tile refocuses it (250 ms swap); a tile's
// grab bar moves it (it snaps to the nearest slot, swapping with whoever is there) and its corner resizes it.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, indicator, fenceLine} from './state.js';
import {C, fillRR, icon, text} from './draw.js';
import {Tile, TILE, eqOf} from './tiles.js';
import {room, placeRel, relOf, angOf, faceEye, ANG, restPos} from './focus.js';
import {A, world, FOCUS, DEG, clamp, animMs, easeOut} from './core.js';

export const LAYOUTS = {
  focus: {primary: 0, slots: []},
  pair: {primary: 0, slots: [{yaw: -28, elev: 0, w: 50, h: 40}, {yaw: 28, elev: 0, w: 50, h: 40}]},
  triptych: {primary: 1, slots: [-45, 0, 45].map((yaw) => ({yaw, elev: 0, w: 42, h: 40}))},
  wall: {primary: 1, slots: [11.5, -11.5].flatMap((elev) => [-50, 0, 50].map((yaw) => ({yaw, elev, w: 46, h: 21})))},
};
export const ORDER = ['focus', 'pair', 'triptych', 'wall'];
export const MIN = {w: 24, h: 16}, SWAP_MS = 250;
const byCount = (n) => (n <= 1 ? 'focus' : n === 2 ? 'pair' : n === 3 ? 'triptych' : 'wall');
export const L = {mode: 'focus', items: [], tiles: [], log: [], flash: null};
const keyOf = (it) => `${it.kind}:${it.id}`;

// ------------------------------------------------------------------ slots and poses
/** Slot index for each item: item 0 (focused) takes the primary slot, the rest fill the others in order. */
export function slotOrder(mode = L.mode) { const D = LAYOUTS[mode]; const rest = D.slots.map((_, i) => i).filter((i) => i !== D.primary); return [D.primary, ...rest]; }
export const visibleCount = () => (L.mode === 'focus' ? 0 : Math.min(L.items.length, LAYOUTS[L.mode].slots.length));
function slotPose(i) { const s = LAYOUTS[L.mode].slots[slotOrder()[i]]; return {yaw: s.yaw, elev: s.elev, w: s.w, h: s.h}; }
function tileFor(i) {
  while (L.tiles.length <= i) {
    const t = new Tile({grab: grabHandler, resize: resizeHandler, focus: (tt) => refocus(L.tiles.indexOf(tt)), close: (tt) => closeTile(L.tiles.indexOf(tt))});
    world.add(t.g); L.tiles.push(t);
  }
  return L.tiles[i];
}
/** Move every visible tile to its slot (or its custom place), in SWAP_MS. */
function arrange(instant = false) {
  const n = visibleCount();
  for (let i = 0; i < n; i++) {
    const t = tileFor(i), to = t.custom || slotPose(i);
    t.pose = {from: instant || !t.cur ? {...to} : {...t.cur}, to, t0: animMs(), dur: instant || S.reduceMotion ? 0 : SWAP_MS};
  }
}
function setReader(on) {
  for (const r of [A.active]) r.pose = {from: {pos: r.g.position.clone(), scale: r.g.scale.x, alpha: r.alpha}, to: {pos: restPos(), scale: FOCUS.S, alpha: on ? 1 : 0}, t0: animMs(), dur: S.reduceMotion ? 0 : 200};
  for (const r of A.readers || []) if (r !== A.active && r.pose) r.pose.to.alpha = 0;
}

// ------------------------------------------------------------------ actions
export function setMode(mode) {
  if (!S.reading || !LAYOUTS[mode] || mode === L.mode) return L.mode;
  const was = L.mode; L.mode = mode;
  if (!L.items.length) L.items = [{kind: 'session', id: S.currentId}];
  if (mode === 'wall') fillWall();
  for (const t of L.tiles) t.custom = null;
  if (mode === 'focus') { A.r3.closeTiles(); setReader(true); if (L.items[0]?.kind === 'session' && L.items[0].id !== S.currentId) A.focusQuiet(L.items[0].id); }
  else { if (was === 'focus') { setReader(false); A.r3.closeArtifactViews(); } arrange(was === 'focus'); }
  L.log.push({t: Math.round(animMs()), mode}); A.r3.invalidateChip();
  return mode;
}
/** The wall is for watching: fill free slots with the sessions that are running or need you (in pinned order). */
function fillWall() {
  const shown = new Set(L.items.map(keyOf));
  for (const id of S.pinned) {
    if (L.items.length >= 6) break;
    const k = indicator(get(id));
    if (['running', 'waiting', 'unread', 'asking', 'error'].includes(k) && !shown.has(`session:${id}`)) L.items.push({kind: 'session', id});
  }
}
/** Add an item; when all six places are taken it replaces the last session that is not focused (pins stay). */
function addItem(it) {
  if (L.items.length < 6) { L.items.push(it); return; }
  let j = -1; for (let k = L.items.length - 1; k > 0; k--) if (L.items[k].kind === 'session') { j = k; break; }
  L.items[j > 0 ? j : L.items.length - 1] = it;
}
export function openBeside(id) {
  if (!get(id)) return null;
  if (!S.reading) { A.openReader(id); return 'focus'; }
  if (!L.items.length) L.items = [{kind: 'session', id: S.currentId}];
  const k = `session:${id}`, i = L.items.findIndex((it) => keyOf(it) === k);
  if (i >= 0) { if (L.mode !== 'focus' && i < visibleCount()) return refocus(i); }
  else addItem({kind: 'session', id});
  const want = byCount(L.items.length), mode = ORDER.indexOf(want) > ORDER.indexOf(L.mode) ? want : L.mode;
  if (mode !== L.mode) setMode(mode); else arrange();
  return L.mode;
}
/** Pin an artifact into the layout (to the wall, beside other sessions and their artifacts). Pinning again unpins. */
export function pin(a) {
  if (!S.reading) A.openReader(a.sessionId);
  if (!L.items.length) L.items = [{kind: 'session', id: S.currentId}];
  const k = `artifact:${a.id}`, i = L.items.findIndex((it) => keyOf(it) === k);
  if (i > 0) { closeTile(i); return false; }
  addItem({kind: 'artifact', id: a.id});
  if (L.mode !== 'wall') setMode('wall'); else arrange();
  A.r3.railChanged();
  return true;
}
export const isPinned = (id) => L.items.some((it) => it.kind === 'artifact' && it.id === id);
/** Make the i-th visible tile the focused one: it swaps into the primary slot, the others step aside (250 ms). */
export function refocus(i) {
  if (i <= 0 || i >= visibleCount()) return i === 0 ? L.items[0] : null;
  [L.items[0], L.items[i]] = [L.items[i], L.items[0]];
  [L.tiles[0], L.tiles[i]] = [L.tiles[i], L.tiles[0]];
  for (const t of [L.tiles[0], L.tiles[i]]) t.custom = null;
  if (L.items[0].kind === 'session') A.focusQuiet(L.items[0].id);
  arrange();
  L.log.push({t: Math.round(animMs()), refocus: keyOf(L.items[0])});
  return L.items[0];
}
export function closeTile(i) {
  if (i < 0 || i >= L.items.length) return;
  if (i === 0 && L.items.length === 1) { A.closeReader(); return; }
  L.items.splice(i, 1);
  const t = L.tiles.splice(i, 1)[0]; if (t) { t.g.visible = false; L.tiles.push(t); t.custom = null; }
  if (i === 0 && L.items[0].kind === 'session') A.focusQuiet(L.items[0].id);
  const want = byCount(L.items.length);
  if (ORDER.indexOf(want) < ORDER.indexOf(L.mode)) setMode(want); else arrange();
  A.r3.railChanged();
}
/** A flick in a multi layout replaces the focused tile's session with the next pinned one not already shown. */
export function switchFocused(dir) {
  const shown = new Set(L.items.slice(1).map(keyOf)), n = S.pinned.length;
  let i = S.pinned.indexOf(L.items[0].kind === 'session' ? L.items[0].id : S.currentId);
  for (let k = 0; k < n; k++) { i = ((i + dir) % n + n) % n; if (!shown.has(`session:${S.pinned[i]}`)) break; }
  L.items[0] = {kind: 'session', id: S.pinned[i]};
  A.focusQuiet(S.pinned[i]);
  return S.pinned[i];
}
/** "What needs me" in a multi layout: highlight the tile (or the avatar) that needs you; nothing moves. */
export function highlightNeeds() {
  const s = fenceLine().find((x) => x.id !== S.currentId) || fenceLine()[0];
  if (!s) return null;
  const i = L.items.findIndex((it) => it.kind === 'session' && it.id === s.id);
  L.flash = {id: s.id, tile: i >= 0 && i < visibleCount() ? i : -1, until: animMs() + 2500};
  if (L.flash.tile < 0) A.bar && (A.bar.flashId = s.id, A.bar.flashUntil = performance.now() + 2500, A.bar.invalidate());
  return s.id;
}

// ------------------------------------------------------------------ grab and resize (region drag handlers)
const rayAng = (p) => relOf(world.worldToLocal(p.ray.origin.clone().add(p.ray.direction)).sub(world.worldToLocal(p.ray.origin.clone()))); // in the room's frame
function grabHandler(t) {
  let off = null;
  return {
    start: (p) => { const r = rayAng(p); off = {yaw: t.cur.yaw - r.yaw, elev: t.cur.elev - r.elev}; t.dragging = true; },
    move: (p) => { const r = rayAng(p); t.custom = {...t.cur, yaw: clamp(r.yaw + off.yaw, -75 + t.cur.w / 2, 75 - t.cur.w / 2), elev: clamp(r.elev + off.elev, -10, 30)}; t.pose = {from: t.custom, to: t.custom, t0: 0, dur: 0}; },
    end: (p, pr, tapped) => {
      t.dragging = false; if (tapped) { t.custom = null; arrange(); return; }
      // Snap to the nearest slot; whoever was there swaps into this tile's old slot.
      const i = L.tiles.indexOf(t), n = visibleCount(); let best = i, bd = 1e9;
      for (let j = 0; j < n; j++) { const s = slotPose(j), d = Math.hypot(s.yaw - t.custom.yaw, s.elev - t.custom.elev); if (d < bd) { bd = d; best = j; } }
      t.custom = null;
      if (best !== i) { [L.items[i], L.items[best]] = [L.items[best], L.items[i]]; [L.tiles[i], L.tiles[best]] = [L.tiles[best], L.tiles[i]]; if (best === 0 || i === 0) { if (L.items[0].kind === 'session') A.focusQuiet(L.items[0].id); } }
      arrange(); L.log.push({t: Math.round(animMs()), grab: keyOf(L.items[best]), to: best});
    },
  };
}
/** The largest size a tile can take at its place without overlapping any other tile (2° gaps). */
function maxSize(t) {
  let w = 2 * (75 - Math.abs(t.cur.yaw)), h = 2 * Math.min(35 - t.cur.elev, t.cur.elev + 30);
  for (const o of L.tiles.slice(0, visibleCount())) {
    if (o === t || !o.cur) continue;
    const vOverlap = Math.abs(o.cur.elev - t.cur.elev) < (o.cur.h + t.cur.h) / 2 + 2, hOverlap = Math.abs(o.cur.yaw - t.cur.yaw) < (o.cur.w + t.cur.w) / 2 + 2;
    if (vOverlap && Math.abs(o.cur.yaw - t.cur.yaw) >= (o.cur.w + MIN.w) / 2) w = Math.min(w, 2 * (Math.abs(o.cur.yaw - t.cur.yaw) - o.cur.w / 2 - 2));
    if (hOverlap && Math.abs(o.cur.elev - t.cur.elev) >= (o.cur.h + MIN.h) / 2) h = Math.min(h, 2 * (Math.abs(o.cur.elev - t.cur.elev) - o.cur.h / 2 - 2));
  }
  return {w, h};
}
function resizeHandler(t) {
  return {
    start: () => { t.dragging = true; t.maxSz = maxSize(t); },
    move: (p) => { const r = rayAng(p); const w = clamp(2 * Math.abs(r.yaw - t.cur.yaw), MIN.w, t.maxSz.w), h = clamp(2 * Math.abs(t.cur.elev - r.elev), MIN.h, t.maxSz.h); t.custom = {...t.cur, w, h}; t.pose = {from: t.custom, to: t.custom, t0: 0, dur: 0}; },
    end: () => { t.dragging = false; L.log.push({t: Math.round(animMs()), resize: keyOf(L.items[L.tiles.indexOf(t)]), w: +t.custom?.w.toFixed(1), h: +t.custom?.h.toFixed(1)}); },
  };
}

// ------------------------------------------------------------------ per frame
export function tickTiles() {
  const n = S.reading ? visibleCount() : 0;
  L.tiles.forEach((t, i) => {
    t.g.visible = i < n;
    if (i >= n) return;
    const P = t.pose, u = P && P.dur ? clamp((animMs() - P.t0) / P.dur, 0, 1) : 1, e = easeOut(u);
    const f = P?.from || slotPose(i), to = P?.to || slotPose(i);
    t.cur = {yaw: f.yaw + (to.yaw - f.yaw) * e, elev: f.elev + (to.elev - f.elev) * e, w: to.w, h: to.h};
    t.setSize(to.w, to.h, i === 0 ? 1 : TILE.dens);
    t.setItem(L.items[i], i === 0);
    placeRel(t.g, t.cur.yaw, t.cur.elev, FOCUS.D);
    const fl = L.flash && L.flash.tile === i && animMs() < L.flash.until;
    t.panel.mat.color.setScalar(fl ? 1 + 0.25 * Math.sin(animMs() / 90) : 1);
    t.update();
  });
}
export const settledTiles = () => L.tiles.every((t) => !t.pose || !t.pose.dur || animMs() - t.pose.t0 >= t.pose.dur);
export {Panel, C, fillRR, icon, text, eqOf, angOf, faceEye, ANG, THREE};
