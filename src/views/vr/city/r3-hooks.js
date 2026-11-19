// Round 3 test hooks (added to window.__vrCity): layouts and tiles, the focus panel's size in degrees, visible turns
// compared with round 2's sizes, per-eye overlap checks between panels and the bar, artifacts, markers, the pedestal.
import * as THREE from 'three';
import {S, get, turnsOf} from './state.js';
import {client} from './client.js';
import {layoutTurn, PPM} from './turns.js';
import {readers, VIEW_PX} from './reader.js';
import {L, settledTiles, visibleCount} from './layouts.js';
import {TILE} from './tiles.js';
import {room, ANG, ctxState, relDir} from './focus.js';
import {artState, railState} from './artifacts.js';
import {pedestal} from './pedestal.js';
import {r3, chip, markers} from './r3.js';
import {bar} from './app.js';
import {head, updateHead} from './input.js';
import {A, renderer, camera, DEG, FOCUS, world} from './core.js';

const scratch = document.createElement('canvas').getContext('2d');
const eyes = () => (renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : [camera]);
const angTo = (p) => { const d = p.clone().sub(head.pos); return {yaw: Math.atan2(d.x, -d.z) / DEG, elev: Math.asin(d.y / d.length()) / DEG}; };
/** Angular extent (degrees, from your eye) of a set of surfaces, measured in a frame looking at `centre` (so that a
 * panel well below the horizon is not stretched by converging meridians): left-right and up-down spans. */
function extent(list, centre = null, upRef = null) {
  updateHead();
  const pts = list.flatMap((s) => r3.corners(s));
  if (!pts.length) return null;
  const c = centre || pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  // Axes: toward the centre, and the given surface's own "up" (a layout is one tilted curved screen), else world up.
  const u0 = upRef ? new THREE.Vector3(0, 1, 0).applyQuaternion(upRef.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Vector3(0, 1, 0);
  const f = c.clone().sub(head.pos).normalize(), rt = new THREE.Vector3().crossVectors(f, u0).normalize(), up = new THREE.Vector3().crossVectors(rt, f);
  let y0 = Infinity, y1 = -Infinity, e0 = Infinity, e1 = -Infinity;
  for (const p of pts) { const d = p.clone().sub(head.pos), z = d.dot(f); const y = Math.atan2(d.dot(rt), z) / DEG, e = Math.atan2(d.dot(up), Math.hypot(z, d.dot(rt))) / DEG; y0 = Math.min(y0, y); y1 = Math.max(y1, y); e0 = Math.min(e0, e); e1 = Math.max(e1, e); }
  const a = angTo(c);
  return {wDeg: +(y1 - y0).toFixed(1), hDeg: +(e1 - e0).toFixed(1), left: +y0.toFixed(1), right: +y1.toFixed(1), centreYaw: +(a.yaw - head.yaw / DEG).toFixed(1), centreElev: +a.elev.toFixed(1)};
}
/** Convex hull (2D) and the separating-axis test, for exact overlap of projected panels. */
function hull(P) {
  const p = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function sat(A, B) {
  for (const poly of [A, B]) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = [a[1] - b[1], b[0] - a[0]];
    const pr = (Q) => Q.map((q) => q[0] * n[0] + q[1] * n[1]);
    const pa = pr(A), pb = pr(B);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
  }
  return true;
}
function barCorners() { bar.g.updateMatrixWorld(true); const out = []; for (let u = 0; u <= 1.001; u += 0.125) for (const w of [0, 1]) out.push(bar.panel.uvToLocal(u, w, new THREE.Vector3()).applyMatrix4(bar.g.matrixWorld)); return out; }
function ndcBox(pts, cam) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = 0;
  for (const p of pts) { const v = p.clone().project(cam); if (v.z > 1) { behind++; continue; } x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
  if (behind === pts.length || x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return null;
  return {x0, x1, y0, y1, partial: behind > 0};
}
const proj = (pts, cam) => { const out = []; for (const p of pts) { const v = p.clone().project(cam); if (v.z < 1) out.push([v.x, v.y]); } return out.length >= 3 ? hull(out) : null; };
/** Turns visible at the bottom of a session for a stream width (px) and viewport height (px), laid out by the same
 * renderer: any turn with a part on screen counts; lines = the viewport in body lines. */
function turnsAt(sid, width, viewPx) {
  const s = get(sid), ts = turnsOf(s); let h = 0, n = 0, chars = 0;
  for (let i = ts.length - 1; i >= 0 && h < viewPx; i--) { const l = layoutTurn(scratch, s, ts[i], {index: i, expanded: new Set(), newMark: null, width}); h += l.h + 22; n++; }
  return {turns: n, contentPx: viewPx, width, totalTurns: ts.length};
}

Object.assign(window.__vrCity, {
  r3() {
    return {mode: L.mode, items: L.items.map((it) => `${it.kind}:${it.id}`), visible: visibleCount(), settled: settledTiles(), shift: +room.shift.toFixed(2), pitch: +room.pitch.toFixed(2), gaze: +room.gaze.toFixed(2),
      tiles: L.tiles.slice(0, visibleCount()).map((t, i) => ({i, n: t.n, item: t.id, focused: t.focused, rasters: t.rasters, uploads: t.uploads, mipped: t.mipped, cur: t.cur && Object.fromEntries(Object.entries(t.cur).map(([k, v]) => [k, +v.toFixed(2)])), canvas: t.panel && [t.panel.cw, t.panel.ch], grab: `tile:grab:${t.n}`, resize: `tile:resize:${t.n}`, body: `tile:body:${t.n}`, close: `tile:close:${t.n}`})),
      artifact: artState.art ? {id: artState.art.id, kind: artState.art.kind, wDeg: artState.wDeg, hDeg: +artState.hDeg.toFixed(1), frames: artState.frames} : null,
      pedestal: pedestal.g.visible ? {id: pedestal.art?.id, yaw: +pedestal.yaw.toFixed(3), tilt: +pedestal.tilt.toFixed(3), scale: +pedestal.scale.toFixed(3), turned: +pedestal.turned.toFixed(3)} : null,
      chip: chip.mesh.visible, railPage: railState.page, file: ctxState.file, lowered: +(r3.lowered || 0).toFixed(3), log: L.log.slice(-10), bar: {elev: +bar.elev.toFixed(2), panelCap: bar.panelCap == null ? null : +bar.panelCap.toFixed(2)}, flash: L.flash};
  },
  setLayout(m) { return r3.setMode(m); }, openBeside(id) { return r3.openBeside(id); }, refocusTile(i) { const it = r3.refocus(i); return it && `${it.kind}:${it.id}`; },
  pullOut(id) { const a = client.artifacts(id.split(':')[0]).find((x) => x.id === id); return a ? r3.pullOut(a) : null; },
  pinArtifact(id) { const a = client.artifacts(id.split(':')[0]).find((x) => x.id === id); return a ? r3.pin(a) : null; },
  artifacts(sid) { return client.artifacts(sid); },
  markers() { return markers.snapshot(); },
  /** The cockpit's (or the layout's) size in degrees from your eye, the conversation alone, and the text size. */
  focusSize() {
    const surf = r3.surfaces(), conv = surf.filter((s) => s.id === 'conversation'), cockpit = surf.filter((s) => ['conversation', 'nav', 'context', 'rail', 'composer'].includes(s.id));
    const centre = conv[0] ? conv[0].mesh.getWorldPosition(new THREE.Vector3()) : null;
    const r = A.active, d = r.g.getWorldPosition(new THREE.Vector3()).distanceTo(head.pos);
    return {cockpit: extent(cockpit, centre, conv[0]?.mesh), conversation: extent(conv, centre, conv[0]?.mesh), distance: +d.toFixed(3), textDeg: +(2 * Math.atan((35 / PPM) * r.g.scale.x / 2 / d) / DEG).toFixed(3), predicted: {w: +ANG.totalW.toFixed(1), conv: [+ANG.readerW.toFixed(1), +ANG.readerH.toFixed(1)]}};
  },
  /** Turns visible at the bottom of a session: round 3's focus panel vs round 2's panel, same renderer. */
  visibleTurns(sid) { return {r3: turnsAt(sid, 1500, VIEW_PX), r2: turnsAt(sid, 1240, Math.round(0.63 * PPM)), viewPx: {r3: VIEW_PX, r2: Math.round(0.63 * PPM)}}; },
  /** Per eye (or the desktop camera): normalised device boxes of every panel and the bar; any overlapping pair. */
  overlaps() {
    const out = [];
    for (const cam of eyes()) {
      cam.updateMatrixWorld();
      const boxes = r3.surfaces().map((s) => ({id: s.id, b: ndcBox(r3.corners(s), cam), poly: [proj(r3.corners(s), cam)]})).filter((x) => x.b && x.poly[0]);
      // The bar is a curved band: eight convex pieces.
      const bc = barCorners(), bpolys = []; for (let k = 0; k < 8; k++) { const q = proj([bc[k * 2], bc[k * 2 + 1], bc[k * 2 + 2], bc[k * 2 + 3]], cam); if (q) bpolys.push(q); }
      const bb = ndcBox(bc, cam); if (bb && bpolys.length) boxes.push({id: 'bar', b: bb, poly: bpolys});
      const pairs = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (!(boxes[i].id.startsWith('pedestal') && boxes[j].id.startsWith('pedestal')) && boxes[i].poly.some((a) => boxes[j].poly.some((b) => sat(a, b)))) pairs.push(`${boxes[i].id} × ${boxes[j].id}`);
      out.push({boxes: boxes.map((x) => ({id: x.id, ...Object.fromEntries(Object.entries(x.b).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))})), pairs});
    }
    return {eyes: out.length, pairs: out.flatMap((e) => e.pairs), perEye: out};
  },
  /** Angular extent of every layout tile from your eye (degrees). */
  tileExtents() { return r3.surfaces().filter((s) => s.id.startsWith('tile:')).map((s) => ({id: s.id, ...extent([s], s.mesh.getWorldPosition(new THREE.Vector3()), s.mesh)})); },
  /** The whole layout's angular span (tiles, cockpit, artifacts) around your gaze at the time it was placed. */
  layoutExtent() { const s = r3.surfaces().filter((x) => x.id !== 'layout-chip'); return extent(s, world.localToWorld(room.E.clone().add(relDir(0, 0))), s[0]?.mesh); },
  readerState() { const r = A.active; return {sid: r.sid, alpha: +r.alpha.toFixed(2), scroll: Math.round(r.scroll), maxScroll: Math.round(r.maxScroll), turnIdx: r.turnIdx, readers: readers.map((x) => ({sid: x.sid, alpha: +x.alpha.toFixed(2)}))}; },
  focus: FOCUS,
  /** Place the bar for the current gaze now (as on entering VR), without the lazy follow's dwell. */
  barSnap() { bar.snap = true; return true; },
  /** Can this browser give panels their own WebXR Layers (crisp quad or cylinder layers composited by the runtime)? */
  layers() { const B = typeof XRWebGLBinding !== 'undefined' ? XRWebGLBinding.prototype : null, sess = renderer.xr.getSession?.(); return {binding: !!B, quad: !!B && 'createQuadLayer' in B, cylinder: !!B && 'createCylinderLayer' in B, sessionLayers: !!sess?.enabledFeatures?.includes?.('layers'), enabledFeatures: sess?.enabledFeatures || null}; },
  /** Tuning knobs for the frame-rate probe (not used by the UI). */
  tileTuning(o) { Object.assign(TILE, o); if (o.mipmaps != null) for (const t of L.tiles) if (t.panel) { t.panel.tex.generateMipmaps = o.mipmaps; t.panel.tex.minFilter = o.mipmaps ? 1008 : 1006; t.panel.tex.needsUpdate = true; } return {...TILE}; },
  /** Screen position (CSS px) of a world point, the 3D model, or an artifact marker (desktop camera). */
  screenOf(w) { const v = new THREE.Vector3(...w).project(camera), r = renderer.domElement.getBoundingClientRect(); return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1}; },
  _pedestalModel() { return pedestal.model; },
  modelScreen() { if (!pedestal.g.visible) return null; const b = new THREE.Box3().setFromObject(pedestal.model), c = b.getCenter(new THREE.Vector3()); return window.__vrCity.screenOf(c.toArray()); },
  markerScreen(id) { const m = markers.snapshot().find((x) => x.id === id); return m ? window.__vrCity.screenOf(m.world) : null; },
  /** The sessions shown in the layout (the live-panel frame-rate probe streams into these through pi-web's mock server). */
  liveLoad() { return L.items.filter((it) => it.kind === 'session').map((it) => it.id); },
  pedestalStatus() { return pedestal.status || null; },
  /** pi-web: thread segments (avatar → beam, file → building) whose midpoint a panel covers from the eye: 0 expected. */
  threadOverPanels() {
    updateHead(); const q = camera.getWorldQuaternion(new THREE.Quaternion()), inv = q.clone().invert(), eye = camera.getWorldPosition(new THREE.Vector3());
    const boxes = r3.obstacles(eye, inv), lines = A.city.lines, pos = lines.pos, a = new THREE.Vector3(), b = new THREE.Vector3();
    let segments = 0, covered = 0;
    for (let i = 0; i + 1 < lines.n; i += 2) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); segments++;
      const m = a.clone().add(b).multiplyScalar(0.5).sub(eye).applyQuaternion(inv); if (m.z > -0.05) continue;
      const tx = m.x / -m.z, ty = m.y / -m.z;
      if (boxes.some((r) => Math.abs(tx - r.cx) <= r.w / 2 && Math.abs(ty - r.cy) <= r.h / 2)) covered++;
    }
    return {segments, covered, panels: boxes.length};
  },
});
window.__r3 = r3;
