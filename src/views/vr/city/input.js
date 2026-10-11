// Input for the City: pointers (mouse, controllers, hands, transient), hit testing (the bar, its pop-ups, the
// reading panel and its columns, live cards, block signs), gestures that work from anywhere (flick, pinch-drag to
// scroll, double tap), and the hand pan: a pinch on empty space that is not a flick grabs the city.
import * as THREE from 'three';
import {panels} from './panel.js';
import {S} from './state.js';
import {PPM} from './turns.js';
import * as V from './views.js';
import {A, renderer, scene, camera, uiRoot, nowMs, clamp, DEG, EYE, R, STREAM_TOP, STREAM_BOT} from './core.js';
import {readers, VIEW_PX} from './reader.js';
import {city, composer, switchBy, choose, openReader, flyToPath} from './app.js';

const UI = V.UI;
export const raycaster = new THREE.Raycaster();
export const pointers = new Set();
export class Pointer {
  constructor(kind, source = null) { this.kind = kind; this.source = source; this.ray = new THREE.Ray(); this.valid = false; this.hit = null; this.press = null; this.grip = null; pointers.add(this); }
}
export const mouse = new Pointer('mouse');
export function inScene(o) { while (o) { if (!o.visible) return false; if (o === scene) return true; o = o.parent; } return false; }
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
function targets() {
  const list = [];
  for (const p of panels) if (p.interactive && inScene(p.mesh) && (p.isTurn ? p.mat.opacity > 0.5 : p.mat.opacity > 0.3 || p.batch)) list.push(p.mesh);
  for (const r of readers) if (r.alpha > 0.5) list.push(r.frame);
  return list;
}
/** What a ray hits: panels in front win (the bar and its pop-ups first: they are nearest), then a live card or coin,
 * then a block or district sign (within 3°, the nearest wins). */
export function intersect(ptr) {
  if (!ptr.valid) return null;
  raycaster.ray.copy(ptr.ray);
  raycaster.far = 8000;
  for (const h of raycaster.intersectObjects(targets(), false)) {
    if (h.object.userData.frame) {
      if (h.object.material.uniforms.uOpacity.value < 0.5) continue;
      return {reader: readers.find((x) => x.frame === h.object), point: h.point, distance: h.distance, region: null};
    }
    const panel = h.object.userData.panel;
    if (!panel || !h.uv) continue;
    if (panel.isTurn) {
      const r = readers.find((x) => x.set?.group === panel.mesh.parent);
      if (!r) continue;
      tmpV.copy(h.point); r.g.worldToLocal(tmpV);
      if (tmpV.y > STREAM_TOP || tmpV.y < STREAM_BOT) continue;
    }
    const reg = panel.regionAt(h.uv);
    if ((panel.name === 'bar' || panel.name === 'preview' || panel.name === 'menu') && !reg) continue;
    return {panel, uv: h.uv.clone(), point: h.point, distance: h.distance, region: reg};
  }
  if (S.reading) return null; // while reading, the city ignores selects (a resting ray often lands there)
  const c = city.pick(ptr.ray);
  if (c?.session) return {card: c.session, point: ptr.ray.at(c.distance, new THREE.Vector3()), distance: c.distance, region: {id: `card:${c.session}`, session: c.session}};
  if (c?.label && ptr.kind === 'mouse' || c?.label && c.angle === 0) return {label: c.label, point: c.point, distance: c.distance, region: {id: c.label.id}};
  if (c?.label) return {label: c.label, point: c.point, distance: c.distance, region: {id: c.label.id}};
  return null;
}
export function updateHovers() {
  const per = new Map();
  A.hoverAvatar = null;
  for (const p of pointers) {
    if (p.kind === 'transient' && !p.press) { p.hit = null; continue; }
    p.hit = intersect(p);
    const reg = p.hit?.region, panel = p.hit?.panel;
    if (reg?.id?.startsWith('avatar:')) A.hoverAvatar = reg.session;
    if (reg?.id?.startsWith('card:')) A.hoverAvatar ||= reg.session;
    if (reg && p.hoverId !== reg.id) { p.hoverId = reg.id; if (!reg.chip) haptic(p, 0.12, 10); }
    if (!reg || !panel) continue;
    if (!per.has(panel)) per.set(panel, new Set());
    per.get(panel).add(reg.id);
  }
  // The preview keeps showing while you point at it (so its buttons can be reached).
  if (!A.hoverAvatar && [...per.keys()].some((p) => p.name === 'preview')) A.hoverAvatar = A.pops?.preview.sid;
  for (const panel of panels) {
    if (panel.isTurn) continue;
    const next = per.get(panel) || new Set();
    const prev = panel.hoverIds;
    let same = next.size === prev.size;
    if (same) for (const id of next) if (!prev.has(id)) { same = false; break; }
    if (!same) { panel.hoverIds = next; if (panel.hoverRedraw) panel.invalidate(); }
  }
}
export function haptic(p, v = 0.35, ms = 18) { try { p?.source?.gamepad?.hapticActuators?.[0]?.pulse?.(v, ms); } catch { /* optional */ } }
// Head frame, in uiRoot's space (your space) and in world space.
export const head = {pos: new THREE.Vector3(0, EYE, 0), right: new THREE.Vector3(1, 0, 0), fwd: new THREE.Vector3(0, 0, -1), local: new THREE.Vector3(0, EYE, 0), yaw: 0, pitch: 0};
export function updateHead() {
  if (renderer.xr.isPresenting && A.viewer) {
    head.pos.copy(A.viewer.pos);
    head.fwd.set(0, 0, -1).applyQuaternion(A.viewer.quat);
  } else if (renderer.xr.isPresenting) {
    const xc = renderer.xr.getCamera();
    xc.getWorldPosition(head.pos);
    head.fwd.set(0, 0, -1).applyQuaternion(xc.getWorldQuaternion(new THREE.Quaternion()));
  } else {
    camera.getWorldPosition(head.pos);
    head.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }
  head.right.set(-head.fwd.z, 0, head.fwd.x).normalize();
  head.local.copy(head.pos); uiRoot.worldToLocal(head.local);
  const f = head.fwd.clone().transformDirection(new THREE.Matrix4().copy(uiRoot.matrixWorld).invert());
  head.yaw = Math.atan2(-f.x, -f.z); head.pitch = Math.asin(clamp(f.y, -1, 1));
  A.headYaw = head.yaw; A.headLocal = head.local;
}
function gesturePoint(p, out) {
  if (p.kind === 'mouse') {
    const g = A.active.g;
    g.updateMatrixWorld(true);
    const n = tmpV2.set(0, 0, 1).transformDirection(g.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, g.getWorldPosition(new THREE.Vector3()));
    return p.ray.intersectPlane(plane, out) || out.copy(p.ray.origin).addScaledVector(p.ray.direction, 1.8);
  }
  if (p.grip && p.kind === 'transient') return out.copy(p.grip);
  return out.copy(p.ray.origin).addScaledVector(p.ray.direction, p.kind === 'hand' ? 0.35 : 0.6);
}
const GC = {mouse: {flick: 0.1, scroll: 0.012, gain: PPM}, hand: {flick: 0.06, scroll: 0.02, gain: 3200}, controller: {flick: 0.07, scroll: 0.02, gain: 3200}, transient: {flick: 0.06, scroll: 0.02, gain: 3200}};
const gcfg = (p) => GC[p.kind] || GC.hand;
export const FLICK_MS = 450, PAN_START = 0.025; // a pinch that moves sideways fast is a flick; any other drag pans
export const effortLog = [];
export function logInput(kind) { effortLog.push({t: Math.round(nowMs()), kind}); if (effortLog.length > 400) effortLog.shift(); }
export function pressStart(p) {
  p.hit = intersect(p);
  if (S.composer.focused && p.hit?.panel !== composer) { S.composer.focused = false; composer.invalidate(); }
  const reg = p.hit?.region || null;
  const P0 = gesturePoint(p, new THREE.Vector3());
  p.press = {t0: nowMs(), reg, hit: p.hit, P0, last: P0.clone(), samples: [{t: nowMs(), y: 0}], mode: null, startScroll: A.active.scroll, right: head.right.clone()};
  if (reg?.strip) { p.press.mode = 'strip'; p.press.reader = p.hit.panel.reader; p.press.y0 = stripF(p); }
  if (p.kind === 'mouse' && !p.hit) p.press.mode = 'look';
  if (p.kind === 'mouse' && p.hit?.label) p.press.mode = 'look-or-tap';
  logInput(`${p.kind}:press`);
}
function stripF(p) {
  const r = p.press?.reader || A.active;
  r.g.updateMatrixWorld(true);
  const n = tmpV2.set(0, 0, 1).transformDirection(r.g.matrixWorld);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, r.g.getWorldPosition(new THREE.Vector3()));
  const hit = p.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return 0;
  r.g.worldToLocal(hit);
  return clamp((STREAM_TOP - hit.y - 14 / V.STRIP.ppm) / (R.streamH - 28 / V.STRIP.ppm), 0, 1);
}
export function pressMove(p) {
  const pr = p.press;
  if (!pr || pr.mode === 'look' || pr.mode === 'done' || pr.mode === 'flicked' || pr.mode === 'pan') return;
  const r = A.active;
  if (pr.mode === 'strip' || pr.mode === 'scrub') {
    const f = stripF(p);
    if (pr.mode === 'strip' && Math.abs(f - pr.y0) > 0.015) { pr.mode = 'scrub'; pr.reader.scrubbing = true; pr.reader.strip.invalidate(); }
    if (pr.mode === 'scrub' && pr.reader === r && r.set?.turns.length) { r.anim = null; r.vel = 0; r.scroll = clamp(r.posAtF(f, false), 0, r.maxScroll); }
    return;
  }
  if (pr.mode === 'look-or-tap') return;
  const P = gesturePoint(p, tmpV);
  const d = P.clone().sub(pr.P0);
  const dx = d.dot(pr.right), dy = d.y;
  const cfg = gcfg(p), age = nowMs() - pr.t0;
  if (!pr.mode) {
    const dz = Math.abs(d.dot(tmpV2.copy(pr.right).cross(new THREE.Vector3(0, 1, 0))));
    if (Math.abs(dx) >= cfg.flick && Math.abs(dx) > 1.4 * Math.max(Math.abs(dy), dz) && (age < FLICK_MS || p.kind === 'mouse' || S.reading || pr.hit)) {
      // Pinch-and-flick sideways: one session. Hand moves left -> the next session.
      pr.mode = 'flicked';
      switchBy(dx < 0 ? 1 : -1);
      logInput(`${p.kind}:flick`);
      haptic(p, 0.4, 20);
      return;
    }
    if (S.reading && Math.abs(dy) >= cfg.scroll && Math.abs(dy) > Math.abs(dx)) { pr.mode = 'scroll'; pr.P0 = P.clone(); pr.startScroll = r.scroll; r.anim = null; r.vel = 0; r.drag = true; pr.samples = [{t: nowMs(), y: 0}]; }
    // A pinch on empty space in the city view that is not a quick flick: grab the city and pan it.
    else if (!S.reading && !pr.hit && p.kind === 'hand' && (d.length() > PAN_START && !(Math.abs(dx) > 1.4 * Math.max(Math.abs(dy), dz)) || age >= FLICK_MS && d.length() > 0.008)) { pr.mode = 'pan'; logInput('hand:pan'); return; }
  }
  if (pr.mode === 'scroll') {
    const dyS = P.y - pr.P0.y;
    r.scroll = clamp(pr.startScroll + dyS * cfg.gain, 0, r.maxScroll);
    pr.samples.push({t: nowMs(), y: dyS});
    while (pr.samples.length > 2 && nowMs() - pr.samples[0].t > 110) pr.samples.shift();
  }
}
export function pressEnd(p) {
  const pr = p.press;
  p.press = null;
  if (!pr) return;
  const r = A.active;
  if (pr.mode === 'pan') { logInput(`${p.kind}:pan-end`); return; }
  if (pr.mode === 'strip') { const f = stripF({...p, press: pr}); if (pr.reader === r && r.set?.turns.length) r.to(r.posAtF(f, true)); logInput(`${p.kind}:strip-jump`); return; }
  if (pr.mode === 'scrub') { pr.reader.scrubbing = false; pr.reader.strip.invalidate(); return; }
  if (pr.mode === 'scroll') {
    r.drag = false;
    const a = pr.samples[0], b = pr.samples[pr.samples.length - 1];
    const dtS = (b.t - a.t) / 1000;
    if (dtS > 0.01) r.vel = clamp(((b.y - a.y) / dtS) * gcfg(p).gain, -9000, 9000);
    return;
  }
  if (pr.mode && pr.mode !== 'look-or-tap') return;
  if (nowMs() - pr.t0 > 700) return;
  if (pr.mode === 'look-or-tap' && pr.moved) return;
  tap(p, pr.hit);
}
let lastEmptyTap = -1e9, pendingOpen = null;
/** A select (click, trigger, pinch) on whatever was under the pointer at the press. */
function tap(p, hit) {
  const reg = hit?.region;
  if (reg?.click) { cancelPending(); reg.click(); logInput(`${p.kind}:click:${reg.id}`); return; }
  if (hit?.card) { cancelPending(); choose(hit.card); logInput(`${p.kind}:card`); return; }
  if (hit?.label) { cancelPending(); const c = hit.label.click; if (c?.fly) flyToPath(c.fly); logInput(`${p.kind}:sign`); return; }
  if (hit?.reader) return;
  // Empty space: a quick second tap is "what needs me"; one tap (headset) opens the current session after a short wait.
  if (nowMs() - lastEmptyTap < 450) { lastEmptyTap = -1e9; cancelPending(); UI.needsYou(); logInput(`${p.kind}:double-tap`); return; }
  lastEmptyTap = nowMs();
  if (!S.reading && p.kind !== 'mouse') { cancelPending(); pendingOpen = setTimeout(() => { pendingOpen = null; openReader(S.currentId); }, 330); }
}
function cancelPending() { if (pendingOpen) { clearTimeout(pendingOpen); pendingOpen = null; } }
/** The hands that are panning the city this frame, in your space (for city-nav's grab). */
export function panPoints() {
  const out = [];
  const inv = new THREE.Matrix4().copy(uiRoot.matrixWorld).invert();
  for (const p of pointers) if (p.press?.mode === 'pan' && p.valid) out.push({p: uiRoot.worldToLocal(p.ray.origin.clone()), o: uiRoot.worldToLocal(p.ray.origin.clone()), d: p.ray.direction.clone().transformDirection(inv), side: p.source?.handedness || 'none'});
  return out;
}
export {VIEW_PX, DEG};
