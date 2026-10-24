// Round 3, the spatial orchestrator: per frame it places the cockpit (focus.js), the pulled-out artifact and the
// pedestal (artifacts.js, pedestal.js), the layout's tiles (layouts.js), the layout chip, and the artifact markers in
// the city. It tells the bar where the lowest panel ends (the bar stays below every panel), gives the city's labels
// the panels as obstacles, lowers the city a little while you read, and turns a two-grip spread into a layout change.
// Exposed as A.r3 for the app's switching, the input layer and the tests.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, indicator} from './state.js';
const indicatorOf = (id) => indicator(get(id));
import {C, fillRR, icon, text} from './draw.js';
import {room, layoutCockpit, tickRoom, ctxState, context, placeRel, ANG, restPos, faceRoom} from './focus.js';
import {rail, pullOut, closeArtifact, tickArtifacts, syncRail, artState, WIDE} from './artifacts.js';
import {pedestal} from './pedestal.js';
import {Markers} from './artifact-markers.js';
import {L, LAYOUTS, ORDER, setMode, openBeside, pin, isPinned, refocus, switchFocused, highlightNeeds, tickTiles, visibleCount, closeTile} from './layouts.js';
import {eqOf} from './tiles.js';
import {city, bar, composer, nav, openReader, closeReader, choose, focusQuiet} from './app.js';
import {readers} from './reader.js';
import {head} from './input.js';
import {A, world, uiRoot, FOCUS, DEG, clamp, animMs} from './core.js';

const CHIP = {btnDeg: 6.6, hDeg: 6.4, gapDeg: 0.8};
const LABEL = {focus: ['rectangle-horizontal', 'Focus'], pair: ['columns-2', 'Pair'], triptych: ['columns-3', 'Triptych'], wall: ['layout-dashboard', 'Wall']};
export const chip = new Panel('layout-chip', {w: eqOf(4 * CHIP.btnDeg + 3 * CHIP.gapDeg), h: eqOf(CHIP.hDeg), ppm: 1100, renderOrder: 6, draw: (ctx, p) => {
  const W = p.cw, H = p.ch, bw = (W - 3 * (W * CHIP.gapDeg / (4 * CHIP.btnDeg + 3 * CHIP.gapDeg))) / 4, g = (W - 4 * bw) / 3;
  ORDER.forEach((m, i) => {
    const x = i * (bw + g), on = L.mode === m, id = `layout:${m}`, [ic, label] = LABEL[m];
    fillRR(ctx, x + 2, 2, bw - 4, H - 4, 22, on ? '#2a2112' : p.isHover(id) ? '#232323' : '#121212', on ? C.accent : '#2c2c2c', on ? 4 : 2);
    icon(ctx, ic, x + bw / 2, H * 0.38, 44, on ? C.accent : C.text, 2.6);
    text(ctx, label, x + bw / 2, H * 0.76, {size: 28, weight: 700, align: 'center', color: on ? C.accent : C.text});
    p.region(id, x, 0, bw, H, {click: () => setMode(m)});
  });
}});
chip.mesh.scale.setScalar(FOCUS.S); world.add(chip.mesh); chip.mesh.visible = false;
export const markers = new Markers(city);
A.markers = markers;

/** Top of the current layout (degrees above room.pitch), for the chip. */
function layoutTop() { if (L.mode === 'focus') return ANG.readerH / 2; return Math.max(...LAYOUTS[L.mode].slots.map((s) => s.elev + s.h / 2)); }
let lowered = 0;
export const r3 = {
  multi: () => S.reading && L.mode !== 'focus',
  mode: () => L.mode,
  setMode, openBeside, pin, isPinned, refocus, closeTile,
  pullOut(a) { if (!S.reading) { openReader(a.sessionId); } if (L.mode !== 'focus') setMode('focus'); return pullOut(a); },
  /** From the city (a marker) or anywhere: open the artifact's session and pull the artifact out. */
  openArtifact(a) { if (!S.reading || S.currentId !== a.sessionId) { if (S.reading && L.mode === 'focus') choose(a.sessionId); else openReader(a.sessionId); } return r3.pullOut(a); },
  railChanged() { rail.invalidate(); },
  invalidateChip() { chip.invalidate(); rail.invalidate(); },
  closeArtifactViews() { closeArtifact(); pedestal.hide(); },
  closeTiles() { for (const t of L.tiles) t.g.visible = false; },
  /** Closing the reader closes every panel: back to one focus panel next time. */
  closeAll() { r3.closeArtifactViews(); L.mode = 'focus'; L.items = []; r3.closeTiles(); room.shiftTo = 0; chip.invalidate(); },
  switchBy(dir) { const id = switchFocused(dir); return id; },
  cycle() { return setMode(ORDER[(ORDER.indexOf(L.mode) + 1) % ORDER.length]); },
  besideNext() { const shown = new Set(L.items.map((it) => it.id).concat(S.currentId)); const id = S.pinned.find((x) => !shown.has(x) && ['running', 'unread', 'asking'].includes(indicatorOf(x))) || S.pinned.find((x) => !shown.has(x)); return id ? openBeside(id) : null; },
  /** The desktop preview looks at the layout's middle (room frame, degrees) with a view wide enough for it. */
  viewCentre() {
    if (L.mode !== 'focus') return {yaw: 0, elev: 0};
    const side = artState.art ? WIDE[artState.art.kind] || 40 : pedestal.art ? WIDE.model : 0;
    return {yaw: side ? (1.5 + side) / 2 - room.shift : 0, elev: 0};
  },
  viewHfov() { return L.mode === 'pair' ? 106 : L.mode === 'triptych' || L.mode === 'wall' ? 112 : artState.art || pedestal.art ? 110 : 100; }, // drag to look further
  indexOf(id) { const i = L.items.findIndex((it) => it.kind === 'session' && it.id === id); return i < visibleCount() ? i : -1; },
  showInFocused(id) { L.items = [{kind: 'session', id}, ...L.items.slice(1).filter((it) => !(it.kind === 'session' && it.id === id))]; focusQuiet(id); return id; },
  needsYou: () => highlightNeeds(),
  /** Desktop wheel over a tile scrolls its tail; over the model it scales it. Returns true if handled. */
  wheel(hit, dy) {
    if (hit?.region?.id === 'model') { pedestal.zoom(dy > 0 ? 1 / 1.1 : 1.1); return true; }
    const t = hit?.panel?.tile; if (!t) return false;
    t.scrollPx = clamp((t.scrollPx || 0) - dy, 0, t.maxScroll || 0); return true;
  },
  fileThread() {
    if (!ctxState.file || !context.mesh.visible) return null;
    const from = context.regionWorld(`ctx:file:${ctxState.file}`);
    return from ? {path: ctxState.file, from} : null;
  },
  /** Every visible spatial surface (meshes), for the overlap tests, the bar and the city's labels. */
  surfaces() {
    const out = [];
    if (!S.reading) return out;
    if (L.mode === 'focus') {
      const r = A.active;
      if (r.alpha > 0.5) out.push({id: 'conversation', mesh: r.occ, w: r.occ.geometry.parameters.width, h: r.occ.geometry.parameters.height});
      for (const p of [nav, context, rail, composer]) if (p.mesh.visible) out.push({id: p.name, mesh: p.mesh, panel: p});
      if (artState.panel?.mesh.visible) out.push({id: 'artifact', mesh: artState.panel.mesh, panel: artState.panel});
      if (pedestal.g.visible) for (const m of pedestal.meshes()) out.push({id: `pedestal:${m.name || 'part'}`, mesh: m, box3: true});
    } else L.tiles.slice(0, visibleCount()).forEach((t, i) => out.push({id: `tile:${i}`, mesh: t.panel.mesh, panel: t.panel}));
    if (chip.mesh.visible) out.push({id: 'layout-chip', mesh: chip.mesh, panel: chip});
    return out;
  },
  /** World-space corners of a surface. */
  corners(s) {
    const v = [];
    if (s.panel) { const p = s.panel; for (const [u, w] of [[p.u0, p.v0], [1, p.v0], [1, 1], [p.u0, 1], [0.5, p.v0], [0.5, 1], [p.u0, 0.5], [1, 0.5]]) v.push(p.uvToLocal(u, w, new THREE.Vector3())); }
    else if (s.box3) { s.mesh.geometry.computeBoundingBox(); const b = s.mesh.geometry.boundingBox; for (let i = 0; i < 8; i++) v.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)); }
    else for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) v.push(new THREE.Vector3(x * s.w / 2, y * s.h / 2, 0));
    s.mesh.updateWorldMatrix(true, false);
    return v.map((q) => q.applyMatrix4(s.mesh.matrixWorld));
  },
  /** The lowest elevation (degrees above your horizon, from your eye) any panel reaches: the bar keeps below it. */
  panelLow() {
    let low = null;
    for (const s of r3.surfaces()) for (const c of r3.corners(s)) { const d = c.clone().sub(head.pos), e = Math.asin(clamp(d.y / d.length(), -1, 1)) / DEG; low = low == null ? e : Math.min(low, e); }
    return low;
  },
  /** The highest the bar's centre may sit (degrees) so that no part of it reaches a panel: while panels are open the
   * bar is a level band, so each panel point within its span (yaw ± halfW) limits it to that point − top − 1°.
   * head/yaw in uiRoot coordinates (yaw: three's convention). */
  barCap(yawRad, halfWDeg, topDeg) {
    let cap = null; const u = uiRoot, hl = u.worldToLocal(head.pos.clone());
    for (const s of r3.surfaces()) for (const c of r3.corners(s)) {
      const d = u.worldToLocal(c.clone()).sub(hl), az = Math.atan2(-d.x, -d.z), el = Math.asin(clamp(d.y / d.length(), -1, 1)) / DEG;
      const phi = Math.atan2(Math.sin(az - yawRad), Math.cos(az - yawRad)) / DEG;
      if (Math.abs(phi) > halfWDeg + 2) continue;
      const e = el - topDeg - 1; // the bar is a level band (a cone) while panels are open
      cap = cap == null ? e : Math.min(cap, e);
    }
    return cap;
  },
  /** Tangent-space boxes of the panels, as obstacles for the city's labels and cards. */
  obstacles(eye, inv) {
    const out = [];
    for (const s of r3.surfaces()) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ok = true;
      for (const c of r3.corners(s)) { const v = c.sub(eye).applyQuaternion(inv); if (v.z > -0.05) { ok = false; break; } x0 = Math.min(x0, v.x / -v.z); x1 = Math.max(x1, v.x / -v.z); y0 = Math.min(y0, v.y / -v.z); y1 = Math.max(y1, v.y / -v.z); }
      if (ok) out.push({id: s.id, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0});
    }
    return out;
  },
  /** Two grips while panels are open: spreading the hands apart (15 cm) moves to the next layout, closing them to the
   * previous one. The city is not grabbed meanwhile. */
  filterGrabs(grabs) {
    if (!S.reading || grabs.length < 2) { r3.spread = null; return grabs; }
    const d = grabs[0].p.distanceTo(grabs[1].p);
    if (!r3.spread) r3.spread = {d0: d, done: false};
    if (!r3.spread.done && Math.abs(d - r3.spread.d0) > 0.15) { const i = ORDER.indexOf(L.mode) + (d > r3.spread.d0 ? 1 : -1); r3.spread.done = true; setMode(ORDER[clamp(i, 0, ORDER.length - 1)]); }
    return [];
  },
  /** After the nav is applied: the city sinks a little (6% of your altitude) while panels are open. */
  afterNav(dt) {
    lowered += ((S.reading ? 1 : 0) - lowered) * (S.reduceMotion ? 1 : Math.min(1, dt / 0.25));
    if (lowered > 0.001) { const alt = Math.max(10, city.root.worldToLocal(head.pos.clone()).y); city.root.position.y -= lowered * 0.06 * alt * city.root.scale.x; city.root.updateMatrixWorld(true); }
    r3.lowered = lowered;
  },
  frame(dt) {
    tickRoom(dt);
    const focus = S.reading && L.mode === 'focus', r = A.active;
    // At rest, the conversation follows the room (it steps aside, 250 ms, when an artifact is pulled out beside it).
    if (focus && r.pose && animMs() - r.pose.t0 >= r.pose.dur && r.pose.to.alpha === 1) { r.pose.to.pos.copy(restPos()); r.g.position.copy(r.pose.to.pos); faceRoom(r.g); }
    layoutCockpit(r, {nav, composer, rail}, focus);
    syncRail();
    tickArtifacts(focus && r.alpha > 0.5, r.alpha);
    pedestal.tick(focus && r.alpha > 0.5);
    tickTiles();
    chip.mesh.visible = S.reading && (L.mode !== 'focus' || r.alpha > 0.5);
    if (chip.mesh.visible) placeRel(chip.mesh, L.mode === 'focus' ? -room.shift : 0, layoutTop() + CHIP.hDeg / 2 + 2.5, FOCUS.D);
    markers.tick(head.pos, true);
  },
};
A.r3 = r3; A.readers = readers; A.choose = choose; A.openReader = openReader; A.closeReader = closeReader; A.focusQuiet = focusQuiet;
A.extraTargets = () => (pedestal.g.visible ? [pedestal.model] : []);
export {WIDE, get};
