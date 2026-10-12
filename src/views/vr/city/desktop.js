// Desktop preview: the camera stands in for your head at the mayor's vantage. Mouse drag looks around, right-drag
// (or shift-drag) grabs the city and pans it, the wheel changes altitude (or scrolls the panel you point at),
// WASD flies, Q and E go down and up, H flies home, F flies to the current session, and the rest are the keys.
import * as THREE from 'three';
import {S} from './state.js';
import * as V from './views.js';
import {A, renderer, camera, uiRoot, clamp, DEG, EYE} from './core.js';
import {VIEW_PX} from './reader.js';
import {composer, switchBy, openReader, closeReader, goHome, setTable, isTable, city} from './app.js';
import {mouse, raycaster, intersect, pressStart, pressMove, pressEnd, logInput, head} from './input.js';
import * as N from './city-nav.js';
import {relDir} from './focus.js';

const UI = V.UI;
export const desk = {yaw: 0, pitch: -34 * DEG, hfov: 90, lookYaw: 0, lookPitch: -34 * DEG, view: 'city', keys: new Set()};
window.__desk = desk;
export function fitCamera() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const vfov = 2 * Math.atan(Math.tan((desk.hfov * DEG) / 2) / camera.aspect);
  camera.fov = clamp(vfov / DEG, 30, 100);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', fitCamera);
fitCamera();
export function updateDeskCamera(dt) {
  swipe.quiet += Math.min(50, dt * 1000);
  const k = S.reduceMotion ? 1 : 1 - Math.exp(-dt / 0.09);
  // Round 3: while reading, look at the layout's centre (plus any drag-look offset; it resets when you close).
  if (!S.reading) { desk.readYaw = 0; desk.readPitch = 0; }
  const vc = S.reading ? relDir(A.r3?.viewCentre().yaw || 0, A.r3?.viewCentre().elev || 0) : null;
  const wantPitch = S.reading ? Math.asin(vc.y) + (desk.readPitch || 0) : desk.lookPitch, wantYaw = S.reading ? A.world.rotation.y + Math.atan2(-vc.x, -vc.z) + (desk.readYaw || 0) : desk.lookYaw;
  desk.pitch += (wantPitch - desk.pitch) * k;
  // Round 3: the cockpit is 81° wide; the desktop preview widens its view to 100° while panels are open.
  const wantH = S.reading ? A.r3?.viewHfov() || 100 : 90; if (Math.abs(wantH - desk.hfov) > 0.05) { desk.hfov += (wantH - desk.hfov) * k; fitCamera(); }
  let dy = Math.atan2(Math.sin(wantYaw - desk.yaw), Math.cos(wantYaw - desk.yaw)); desk.yaw += dy * k;
  camera.position.set(0, EYE, 0); uiRoot.localToWorld(camera.position);
  camera.rotation.set(desk.pitch, desk.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
}
/** Keyboard flight, applied after the head is known (main.js). */
export function deskFlight(dt) {
  const K = desk.keys, f = (K.has('w') ? 1 : 0) - (K.has('s') ? 1 : 0), st = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0), cl = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0);
  if (f || st || cl) N.fly(head.yaw, f, st, cl, dt, head.local);
}
const ndc = new THREE.Vector2();
let mouseInside = false;
export function updateMouseRay() {
  if (!mouseInside || renderer.xr.isPresenting) { mouse.valid = false; return; }
  raycaster.setFromCamera(ndc, camera);
  mouse.ray.copy(raycaster.ray);
  mouse.valid = true;
}
const el = renderer.domElement;
/** Right-drag: grab the point of the city under the mouse (on the ground plane) and keep it under the mouse. */
let pan = null;
function groundPoint() { const p = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0).applyMatrix4(city.root.matrixWorld); return mouse.ray.intersectPlane(p, new THREE.Vector3()); }
el.addEventListener('pointermove', (e) => {
  const r = el.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  mouseInside = true;
  if (pan) {
    updateMouseRay();
    const g = groundPoint();
    if (g) { const a = city.root.worldToLocal(pan.clone()), b = city.root.worldToLocal(g.clone()); N.nav.pos.x += a.x - b.x; N.nav.pos.z += a.z - b.z; N.nav.speed = 1; N.apply(city.root); }
    return;
  }
  const pr = mouse.press;
  if (pr?.mode === 'look' || pr?.mode === 'look-or-tap') {
    const L = pr.lookStart;
    if (Math.hypot(e.clientX - L.x, e.clientY - L.y) > 4) pr.moved = true;
    if (pr.moved && S.reading) { desk.readYaw = L.ryaw - (e.clientX - L.x) * 0.0035; desk.readPitch = clamp(L.rpitch - (e.clientY - L.y) * 0.0035, -0.6, 0.6); el.style.cursor = 'grabbing'; return; } // round 3: look around the layout
    if (pr.moved) {
      desk.lookYaw = L.yaw - (e.clientX - L.x) * 0.0035;
      desk.lookPitch = clamp(L.pitch - (e.clientY - L.y) * 0.0035, -1.45, 0.5);
      el.style.cursor = 'grabbing';
      return;
    }
  }
  updateMouseRay();
  pressMove(mouse);
  const h = intersect(mouse);
  el.style.cursor = mouse.press?.mode === 'scroll' ? 'grabbing' : h?.region ? 'pointer' : 'grab';
});
el.addEventListener('pointerleave', () => { mouseInside = false; mouse.valid = false; });
el.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting) return;
  el.setPointerCapture?.(e.pointerId);
  updateMouseRay();
  // Round 3: Shift+click on an avatar (or a live card) opens that session beside the focused one.
  if (e.button === 0 && e.shiftKey) { const h = intersect(mouse), sid = h?.region?.session || h?.card; if (sid && A.r3) { A.r3.openBeside(sid); logInput('mouse:beside'); return; } }
  if (e.button === 2 || (e.button === 0 && e.shiftKey)) { const g = groundPoint(); if (g) { pan = g; logInput('mouse:pan'); } return; }
  if (e.button !== 0) return;
  pressStart(mouse);
  if (mouse.press.mode === 'look' || mouse.press.mode === 'look-or-tap') mouse.press.lookStart = {x: e.clientX, y: e.clientY, yaw: desk.lookYaw, pitch: desk.lookPitch, ryaw: desk.readYaw || 0, rpitch: desk.readPitch || 0};
});
el.addEventListener('pointerup', (e) => {
  if (pan) { pan = null; return; }
  if (e.button !== 0) return;
  updateMouseRay();
  if (mouse.press?.mode === 'look') { mouse.press = null; el.style.cursor = 'grab'; return; }
  pressEnd(mouse);
});
el.addEventListener('contextmenu', (e) => e.preventDefault());
// Wheel: over the reading panel it scrolls the stream; anywhere else it changes altitude (zoom). A horizontal
// trackpad swipe is one session. A swipe ends after 420 ms without wheel events (in frame time).
const swipe = {acc: 0, locked: false, quiet: 1e9};
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (swipe.quiet > 420) { swipe.acc = 0; swipe.locked = false; }
  swipe.quiet = 0;
  const dx = e.deltaX, dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(dx) > Math.abs(dy)) {
    swipe.acc += dx;
    if (!swipe.locked && Math.abs(swipe.acc) > 60) { swipe.locked = true; switchBy(Math.sign(swipe.acc)); logInput('trackpad:swipe'); }
    return;
  }
  const over = intersect(mouse);
  if (S.reading && A.r3?.wheel(over, dy)) return; // round 3: a tile's tail, or the 3D model's size
  if (S.reading && (over?.panel?.isTurn || over?.reader || over?.panel?.reader)) {
    const r = A.active;
    r.anim = null;
    if (Math.abs(dy) >= 50) r.vel = clamp(r.vel + dy * 9, -9000, 9000);
    else { r.vel = 0; r.scroll = clamp(r.scroll + dy, 0, r.maxScroll); }
    return;
  }
  N.fly(head.yaw, 0, 0, clamp(dy / 100, -3, 3), 0.12, head.local); logInput('wheel:altitude');
}, {passive: false});
window.addEventListener('keyup', (e) => desk.keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => desk.keys.clear());
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const c = S.composer;
  if (c.focused) {
    if (e.key === 'Escape') { c.focused = false; composer.invalidate(); return; }
    if (e.key === 'Enter') { e.preventDefault(); UI.send(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); c.text = c.text.slice(0, -1); composer.invalidate(); return; }
    if (e.key.length === 1) { e.preventDefault(); c.text += e.key; composer.invalidate(); return; }
    return;
  }
  const k = e.key, lk = k.toLowerCase();
  if ('wasdqe'.includes(lk) && lk.length === 1) { desk.keys.add(lk); e.preventDefault(); if (!e.repeat) logInput(`key:${lk}`); return; }
  const r = A.active;
  const rd = (fn) => () => { if (S.reading) fn(); };
  const act = {
    ArrowRight: () => switchBy(1), ArrowLeft: () => switchBy(-1),
    ArrowDown: rd(() => r.stepTurn(1)), ArrowUp: rd(() => r.stepTurn(-1)), j: rd(() => r.stepTurn(1)), k: rd(() => r.stepTurn(-1)),
    Home: rd(() => r.to(0)), End: rd(() => UI.toLatest()), PageDown: rd(() => r.to(r.dest + VIEW_PX * 0.85)), PageUp: rd(() => r.to(r.dest - VIEW_PX * 0.85)),
    Enter: () => { if (!S.reading) openReader(S.currentId); },
    Escape: () => closeReader(), Backspace: () => closeReader(), t: () => setTable(!isTable()),
    n: () => UI.needsYou(), N: () => UI.needsYou(), ' ': () => UI.needsYou(),
    h: () => goHome(), H: () => goHome(), f: () => UI.flyCurrent(), F: () => UI.flyCurrent(),
    m: () => UI.setReduceMotion(!S.reduceMotion), v: () => { S.vignette = S.vignette === false; },
    // Round 3: layouts (L cycles; 1-4 pick one), and B opens the next pinned session beside the focused one.
    l: () => A.r3?.cycle(), L: () => A.r3?.cycle(), 1: () => A.r3?.setMode('focus'), 2: () => A.r3?.setMode('pair'), 3: () => A.r3?.setMode('triptych'), 4: () => A.r3?.setMode('wall'),
    b: () => A.r3?.besideNext(), B: () => A.r3?.besideNext(),
  }[k];
  if (act) { e.preventDefault(); act(); logInput(`key:${k}`); }
});
