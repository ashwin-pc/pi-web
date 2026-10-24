// Round 3, focus: a session in focus gets the room. The cockpit is three columns on a sphere around your eye, about
// FOCUS.D = 1.9 m away: the context column (left: navigation, a turn outline, the files it touched, its workers), the
// conversation (centre: the reading panel, 55° × 44°, text 1.2°), and the artifacts (right: the artifact rail above the
// composer). Every column faces your eye, so the cockpit curves around you. Its centre sits FOCUS.E (3°) below where
// you looked when you opened it (clamped), so it stays within ±15° of that gaze. Nothing here moves your viewpoint.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, turnsOf, indicator, statusText} from './state.js';
import {C, SANS, MONO, font, fillRR, icon, text, ellipsize} from './draw.js';
import {drawAvatar} from './avatars.js';
import {touchedFiles} from './activity.js';
import {A, world, FOCUS, DEG, clamp, RW, RH} from './core.js';
import * as V from './views.js';

const S_ = FOCUS.S;
/** Column sizes in metres at the round 1 scale (shown at FOCUS.S); the gap between columns in degrees. */
export const COL = {w: 0.36, ctxH: 0.54, railH: 0.54, gapDeg: 1.0};
const angW = (wEq) => 2 * Math.atan((wEq * S_ / 2) / FOCUS.D) / DEG; // angular width of a width at FOCUS.S, FOCUS.D
export const ANG = {readerW: angW(RW), readerH: angW(RH), colW: angW(COL.w)};
ANG.totalW = ANG.readerW + 2 * (COL.gapDeg + ANG.colW);

// ------------------------------------------------------------------ the room: where you were looking when you focused
/** E: your eye when the cockpit (or a layout) was placed, in `world` coordinates; pitch: the cockpit's centre elevation
 * (degrees); shift: how far the cockpit has stepped left to make room for a pulled-out artifact (degrees). */
export const room = {E: new THREE.Vector3(0, 1.6, 0), gaze: 0, pitch: FOCUS.E, shift: 0, shiftTo: 0};
export function setAnchor(headWorld, gazePitchDeg) {
  room.E.copy(world.worldToLocal(headWorld.clone()));
  room.gaze = gazePitchDeg;
  room.pitch = clamp(gazePitchDeg, -32, 10) + FOCUS.E;
}
/** Direction for yaw (degrees, positive = right) and elevation (degrees), in `world` coordinates. */
export function dirOf(yaw, elev, out = new THREE.Vector3()) { const a = yaw * DEG, b = elev * DEG; return out.set(Math.sin(a) * Math.cos(b), Math.sin(b), -Math.cos(a) * Math.cos(b)); }
const eyeW = new THREE.Vector3();
/** Put an object at (yaw, elev, dist) from the room's eye, facing the eye. */
export function placeAt(obj, yaw, elev, dist = FOCUS.D) {
  obj.position.copy(room.E).addScaledVector(dirOf(yaw, elev), dist);
  obj.updateMatrixWorld(); world.updateMatrixWorld();
  obj.lookAt(world.localToWorld(eyeW.copy(room.E)));
}
/** Offsets (degrees) in the frame of a base direction (yaw, elev): +dYaw to its right, +dElev above it, measured as
 * true angles at that direction (not along meridians), so panels beside a low or high one keep their gaps. */
const qRel = new THREE.Quaternion(), eRel = new THREE.Euler();
export function relDir(dYaw, dElev, base = {yaw: 0, elev: room.pitch}, out = new THREE.Vector3()) {
  qRel.setFromEuler(eRel.set(base.elev * DEG, -base.yaw * DEG, 0, 'YXZ'));
  return dirOf(dYaw, dElev, out).applyQuaternion(qRel);
}
const upL = new THREE.Vector3();
/** Place at offsets from a base direction, facing the eye with the base frame's "up": the pieces of a layout keep one
 * consistent orientation (like one curved screen tilted toward you), so their angular gaps hold at any pitch. */
export function placeRel(obj, dYaw, dElev, dist = FOCUS.D, base = {yaw: 0, elev: room.pitch}) {
  obj.position.copy(room.E).addScaledVector(relDir(dYaw, dElev, base), dist);
  qRel.setFromEuler(eRel.set(base.elev * DEG, -base.yaw * DEG, 0, 'YXZ'));
  upL.set(0, 1, 0).applyQuaternion(qRel).applyQuaternion(world.quaternion); // the frame's up, in world space
  obj.up.copy(upL); faceEye(obj); obj.up.set(0, 1, 0);
}
/** A direction (in `world` coordinates) as offsets in the room's frame: the inverse of relDir. */
export function relOf(dir, base = {yaw: 0, elev: room.pitch}) {
  qRel.setFromEuler(eRel.set(base.elev * DEG, -base.yaw * DEG, 0, 'YXZ')).invert();
  const d = dir.clone().normalize().applyQuaternion(qRel);
  return {yaw: Math.atan2(d.x, -d.z) / DEG, elev: Math.asin(clamp(d.y, -1, 1)) / DEG};
}
/** Where an object is, as (yaw, elev, dist) from the room's eye. */
export function angOf(pos) { const d = pos.clone().sub(room.E), n = d.length(); return {yaw: Math.atan2(d.x, -d.z) / DEG, elev: Math.asin(clamp(d.y / n, -1, 1)) / DEG, dist: n}; }
/** The conversation's rest pose (focus layout). */
export function restPos() { return room.E.clone().addScaledVector(relDir(-room.shift, 0), FOCUS.D); }
/** Face the eye with the room frame's "up" (the reader, so it lines up with its columns and the layout). */
export function faceRoom(obj) { qRel.setFromEuler(eRel.set(room.pitch * DEG, 0, 0, 'YXZ')); obj.up.set(0, 1, 0).applyQuaternion(qRel).applyQuaternion(world.quaternion); faceEye(obj); obj.up.set(0, 1, 0); }
export function faceEye(obj) { world.updateMatrixWorld(); obj.lookAt(world.localToWorld(eyeW.copy(room.E))); }
/** Ease the cockpit's step-aside (when an artifact is pulled out beside it). */
export function tickRoom(dt) { const d = room.shiftTo - room.shift; room.shift += S.reduceMotion ? d : d * Math.min(1, dt / 0.08); if (Math.abs(d) < 0.01) room.shift = room.shiftTo; }

// ------------------------------------------------------------------ the context column (left, below the navigation)
export const context = new Panel('context', {w: COL.w, h: COL.ctxH, ppm: 1100, draw: drawContext, renderOrder: 5});
world.add(context.mesh);
context.mesh.visible = false;
export const ctxState = {file: null, fileRow: null};
const base = (p) => p.split('/').pop();
function drawContext(ctx, p) {
  const s = get(S.currentId), W = p.cw, H = p.ch;
  fillRR(ctx, 2, 2, W - 4, H - 4, 22, '#0b0b0b', '#262626', 2);
  if (!s) return;
  let y = 40;
  const head = (t, n) => { text(ctx, t, 22, y, {size: 22, weight: 800, color: C.dim}); if (n != null) text(ctx, String(n), W - 22, y, {size: 22, weight: 700, color: C.dim, align: 'right'}); y += 34; };
  // Outline: one row per turn (the prompt's first words), the turn you are reading in gold; select one to jump there.
  const ts = turnsOf(s), r = A.active, cur = r?.sid === s.id ? r.turnIdx : -1, max = 5, from = Math.max(0, Math.min(ts.length - max, cur - 2));
  head('OUTLINE', `${ts.length} turns`);
  ts.slice(from, from + max).forEach((t, k) => {
    const i = from + k, m = s.messages[t.start], label = m?.type === 'user' ? m.text : (m?.type === 'assistant' ? 'Reply' : 'Start');
    const on = i === cur, hov = p.isHover(`ctx:turn:${i}`);
    if (on || hov) fillRR(ctx, 10, y - 18, W - 20, 38, 10, on ? '#1f1a10' : '#161616', on ? 'rgba(226,177,95,0.6)' : '#262626', 1.5);
    ctx.font = font(23, on ? 700 : 400);
    text(ctx, `${i + 1}`, 30, y + 1, {size: 22, weight: 700, color: on ? C.accent : C.dim, align: 'center'});
    text(ctx, ellipsize(ctx, label, W - 80), 52, y + 1, {size: 23, weight: on ? 700 : 400, color: on ? '#f2f2f2' : '#cfcfcf'});
    p.region(`ctx:turn:${i}`, 0, y - 20, W, 40, {click: () => { const rr = A.active; if (rr?.set?.turns[i]) rr.to(rr.set.snapPos(i)); }});
    y += 42;
  });
  // Files it touched: select one and its building lights up in the city, with a gold thread down to it.
  y += 12;
  const files = [...touchedFiles(s).files].slice(0, 4);
  head('FILES', files.length);
  for (const f of files) {
    const id = `ctx:file:${f}`, on = ctxState.file === f, hov = p.isHover(id);
    if (on || hov) fillRR(ctx, 10, y - 18, W - 20, 38, 10, on ? '#1f1a10' : '#161616', on ? 'rgba(226,177,95,0.6)' : '#262626', 1.5);
    icon(ctx, 'file-text', 30, y + 1, 22, on ? C.accent : C.dim, 2);
    ctx.font = font(22, 400, MONO);
    text(ctx, ellipsize(ctx, base(f), W - 80), 52, y + 1, {size: 22, family: MONO, color: on ? '#f2f2f2' : '#cfcfcf'});
    p.region(id, 0, y - 20, W, 40, {click: () => { ctxState.file = ctxState.file === f ? null : f; p.invalidate(); }, file: f});
    y += 42;
  }
  // Workers: small live tiles (avatar, title, status); select one to open it.
  y += 12;
  const workers = [...S.sessions.values()].filter((w) => w.origin === s.id);
  head('WORKERS', workers.length || 'none');
  for (const w of workers.slice(0, 2)) {
    const id = `ctx:worker:${w.id}`, k = indicator(w), hov = p.isHover(id);
    fillRR(ctx, 10, y - 14, W - 20, 64, 12, hov ? '#1a1a1a' : '#121212', k === 'running' ? 'rgba(226,177,95,0.5)' : '#262626', 1.5);
    drawAvatar(ctx, w.id, 40, y + 18, 20);
    ctx.font = font(22, 700);
    text(ctx, ellipsize(ctx, w.title, W - 90), 70, y + 6, {size: 22, weight: 700});
    text(ctx, ellipsize(ctx, statusText(w), W - 90), 70, y + 32, {size: 19, color: k === 'running' ? C.accent : C.dim});
    p.region(id, 0, y - 16, W, 68, {click: () => A.choose?.(w.id)});
    y += 74;
  }
  p.sig = `${s.id}|${cur}|${ts.length}|${files.length}|${ctxState.file}|${workers.map((w) => indicator(w)).join()}`;
}
/** Redraw the context column when what it shows changes. */
let lastSig = '';
export function contextSig() { const s = get(S.currentId); if (!s) return ''; const ws = [...S.sessions.values()].filter((w) => w.origin === s.id); return `${s.id}|${A.active?.turnIdx}|${s.messages.length}|${ctxState.file}|${ws.map((w) => indicator(w)).join()}`; }
export function syncContext() { const sig = contextSig(); if (sig !== lastSig) { lastSig = sig; context.invalidate(); } }

// ------------------------------------------------------------------ placing the cockpit's columns around the reader
/** Angular offsets (degrees, from the reader's centre) of the side pieces: [panel, dyaw, delev]. */
export function columnSlots(nav, composer, rail) {
  const yaw = ANG.readerW / 2 + COL.gapDeg + ANG.colW / 2, half = ANG.readerH / 2;
  const hNav = angW(V.NAV.h), hCtx = angW(COL.ctxH), hRail = angW(COL.railH), hComp = angW(V.COMPOSER.h);
  return [[nav, -yaw, half - hNav / 2], [context, -yaw, -half + hCtx / 2], [rail, yaw, half - hRail / 2], [composer, yaw, -half + hComp / 2]];
}
/** Each frame while reading in the focus layout: the side columns follow the reader (also while it opens or slides). */
export function layoutCockpit(r, {nav, composer, rail}, show) {
  const vis = show && S.reading && r.alpha > 0.02;
  // The reader's place in the room's frame; the columns sit at fixed offsets from it in the same frame.
  const d = angOf(r.g.position), a = relOf(r.g.position.clone().sub(room.E)), k = r.g.scale.x / S_;
  for (const [p, dy, de] of columnSlots(nav, composer, rail)) {
    p.mesh.visible = vis;
    if (!vis) continue;
    placeRel(p.mesh, a.yaw + dy * k, a.elev + de * k, d.dist);
    p.mesh.scale.setScalar(r.g.scale.x);
    p.mat.opacity = r.alpha;
  }
  if (vis) syncContext();
}
/** The cockpit's angular box (degrees, relative to the room): for the bar and the overlap tests. */
export function cockpitBox() { const c = -room.shift; return {yaw0: c - ANG.totalW / 2, yaw1: c + ANG.totalW / 2, elev0: room.pitch - ANG.readerH / 2, elev1: room.pitch + ANG.readerH / 2}; }
export {SANS};
