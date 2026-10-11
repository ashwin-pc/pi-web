// Per frame: the bar (lazy follow) and its pop-ups, the composer and navigation columns beside the reading panel,
// the city's beams, labels and cards (with the bar and the panel as obstacles), the hover highlight and its thread.
import * as THREE from 'three';
import {S, get} from './state.js';
import * as V from './views.js';
import {A, world, RW, RH, renderer, camera, DEG} from './core.js';
import {city, bar, pops, composer, nav} from './app.js';
import {head} from './input.js';
import * as N from './city-nav.js';

const v = new THREE.Vector3(), camQ = new THREE.Quaternion(), inv = new THREE.Quaternion();
const COMPOSER_DX = RW / 2 + 0.025 + V.COMPOSER.w / 2, COMPOSER_DY = -RH / 2 + V.COMPOSER.h / 2;
const NAV_DX = -(RW / 2 + 0.025 + V.NAV.w / 2), NAV_DY = -RH / 2 + V.NAV.h / 2;
function viewQuat(out) { return renderer.xr.isPresenting ? renderer.xr.getCamera().getWorldQuaternion(out) : camera.getWorldQuaternion(out); }
/** The view's bounds in tangent space (in the headset: the intersection of both eyes), inset by 0.6°. */
export function viewBounds() {
  const m = Math.tan(0.6 * DEG);
  const cams = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : null;
  if (cams && cams.length) {
    const b = {x0: -9, x1: 9, y0: -9, y1: 9};
    for (const c of cams) { const e = c.projectionMatrix.elements; b.x0 = Math.max(b.x0, (e[8] - 1) / e[0]); b.x1 = Math.min(b.x1, (e[8] + 1) / e[0]); b.y0 = Math.max(b.y0, (e[9] - 1) / e[5]); b.y1 = Math.min(b.y1, (e[9] + 1) / e[5]); }
    return {x0: b.x0 + m, x1: b.x1 - m, y0: b.y0 + m, y1: b.y1 - m, eyes: cams.length};
  }
  const ty = Math.tan(camera.fov * DEG / 2), tx = ty * camera.aspect;
  const tb = document.getElementById('topBar')?.getBoundingClientRect(), cv = renderer.domElement.getBoundingClientRect();
  const cover = tb && cv.height ? Math.max(0, Math.min(tb.bottom, cv.bottom) - cv.top) / cv.height : 0;
  return {x0: -tx + m, x1: tx - m, y0: -ty + m, y1: ty - 2 * ty * cover - m, eyes: 0};
}
/** The reading panel with its side columns, as a tangent-space box (cards and labels never cover it). */
function readerObstacle(eye) {
  const r = A.active;
  if (!S.reading || !r.pose || r.alpha < 0.02) return null;
  const sc = r.g.scale.x, hw = (RW / 2 + 0.025 + Math.max(V.NAV.w, V.COMPOSER.w)) * sc, hh = (RH / 2 + 0.01) * sc;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    v.set(sx * hw, sy * hh, 0);
    r.g.parent.localToWorld(v.applyQuaternion(r.g.quaternion).add(r.g.position));
    v.sub(eye).applyQuaternion(inv);
    if (v.z > -0.05) return null;
    x0 = Math.min(x0, v.x / -v.z); x1 = Math.max(x1, v.x / -v.z); y0 = Math.min(y0, v.y / -v.z); y1 = Math.max(y1, v.y / -v.z);
  }
  return {id: 'panel', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0};
}
let hoverSid = null, hoverSince = 0, lowAt = -1e9, contentLow = null;
export function followFrame(dt) {
  viewQuat(camQ); inv.copy(camQ).invert();
  const eye = head.pos;
  // The bar: body-locked with lazy follow (the desktop keeps it along the bottom of the window).
  const deskElev = renderer.xr.isPresenting ? null : {pitch: head.pitch, offset: -camera.fov / 2 + 5.4};
  // In the headset the bar keeps below the city's centre region in view (sampled a few times a second).
  const tNow = performance.now();
  if (!deskElev && tNow - lowAt > 300) { lowAt = tNow; contentLow = S.reading ? null : city.contentLow(renderer.xr.getCamera().cameras); }
  bar.pointed = !!A.barPointed;
  bar.update(head.local, head.yaw, dt, deskElev, head.pitch, deskElev || contentLow == null ? null : head.pitch / DEG + contentLow);
  // Pointing at an avatar for a moment highlights its beam and building, with a thread to it.
  const hv = A.hoverAvatar || null;
  if (hv !== hoverSid) { hoverSid = hv; hoverSince = performance.now(); }
  const lit = hoverSid && performance.now() - hoverSince > 250 ? hoverSid : null;
  A.highlight = lit;
  pops.update(lit);
  city.hover = lit;
  // Composer and navigation columns ride with the active reading panel.
  const r = A.active, ra = r.pose ? r.alpha : 0;
  composer.mesh.visible = S.reading && ra > 0.02;
  nav.mesh.visible = composer.mesh.visible;
  const headW = world.worldToLocal(head.pos.clone());
  for (const [p, dx, dy] of [[composer, COMPOSER_DX, COMPOSER_DY], [nav, NAV_DX, NAV_DY]]) {
    if (!p.mesh.visible) continue;
    const sc = r.g.scale.x;
    p.mesh.position.copy(r.g.position).add(v.set(dx * sc, dy * sc, 0));
    p.mesh.scale.setScalar(sc);
    p.mesh.lookAt(world.localToWorld(headW.clone()));
    p.mat.opacity = ra;
  }
  const obstacles = [...bar.obstacle(eye, camQ), readerObstacle(eye)].filter(Boolean);
  const from = lit ? bar.cellWorld(lit) : null;
  city.update({dt, eye, camQ, bounds: viewBounds(), reading: S.reading, currentId: S.currentId, obstacles, navScale: N.nav.scale, thread: from && get(lit) ? {sid: lit, from} : null});
}
