// City-specific measurement hooks (merged into window.__vrCity by hooks.js).
import * as THREE from 'three';
import {S, get, indicator} from './state.js';
import {A, renderer, camera, DEG} from './core.js';
import {city, bar, pops} from './app.js';
import {head, updateHead} from './input.js';
import {checkLayout, heightOf} from './city-layout.js';
import {BAR, PAGE, cellOf} from './bar.js';
import * as N from './city-nav.js';
import {liveLine, previewText} from './city-text.js';

const tan = (v) => Math.atan(v) / DEG;
/** The eyes to test against: both XR eye cameras, or the desktop camera. */
function eyes() { return renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : [camera]; }
export const cityHooks = {
  layoutCheck() {
    const c = checkLayout(city.L, city.land), mesh = city.buildings;
    return {...c, uncovered: c.uncovered.length, instances: city.B.n, drawnNow: mesh.count, fileInstances: mesh.userData.fileCount, landmarks: mesh.userData.landmarks.length, districts: city.L.districts.map((d) => d.name), big: city.big};
  },
  heights() { const s = [1, 10, 50, 200, 1000, 5000]; return s.map((l) => ({lines: l, h: +heightOf(l).toFixed(2)})); },
  /** Each beam: its session's current tool path, and how far the beam's foot is from that building's roof. */
  beams() {
    const out = [];
    for (const [id, b] of city.beams) {
      const p = city.beamPos(id, new THREE.Vector3()), tg = b.to, g = tg.building >= 0 ? city.L.buildings[tg.building] : null;
      out.push({id, kind: tg.kind, path: tg.path, building: g ? g.path : null, waiting: !!tg.waiting, block: tg.block, foot: {x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2)},
        offRoof: g ? +Math.hypot(p.x - g.x, p.y - (g.base + g.h), p.z - g.z).toFixed(3) : null, sliding: performance.now() - b.t0 < 250});
    }
    return out;
  },
  heat() { const hot = [...(city.edits || new Map())].map(([p, t]) => ({p: p.split('/').slice(-2).join('/'), min: Math.round((Date.now() - t) / 6e4)})); return {hot: hot.length, files: hot, blocks: [...(city.blockHeat || new Map())].filter(([, v]) => v > 0.05).length}; },
  /** The bar: every visible avatar cell, its angular size and where it sits (azimuth / elevation from the eye), and
   * whether the whole bar is inside every eye's view. */
  barCheck() {
    updateHead();
    bar.g.updateMatrixWorld(true);
    const p = bar.panel, inv = new THREE.Matrix4();
    const cells = [];
    for (const id of S.pinned.slice(bar.page * PAGE, bar.page * PAGE + PAGE)) {
      const c = cellOf(id, bar.page); const L = bar.cellLocal(c.col, c.row);
      const w = L.p.clone().applyMatrix4(bar.g.matrixWorld), d = w.clone().sub(head.pos);
      cells.push({id, col: c.col, row: c.row, x: +w.x.toFixed(4), y: +w.y.toFixed(4), z: +w.z.toFixed(4), el: +(Math.asin(d.y / d.length()) / DEG).toFixed(2), az: +(Math.atan2(-d.x, -d.z) / DEG).toFixed(2), status: indicator(get(id))});
    }
    // Corners of the bar in every eye: normalised device coordinates within [-1, 1].
    const pts = [];
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) pts.push(p.uvToLocal(u, v, new THREE.Vector3()).applyMatrix4(bar.g.matrixWorld));
    let worst = 0;
    for (const cam of eyes()) { cam.updateMatrixWorld(); for (const q of pts) { const n = q.clone().project(cam); worst = Math.max(worst, Math.abs(n.x), Math.abs(n.y)); if (n.z > 1) worst = 9; } }
    const centre = p.uvToLocal(0.5, 0.5, new THREE.Vector3()).applyMatrix4(bar.g.matrixWorld).sub(head.pos);
    const cellDeg = BAR.CELL, rowDeg = BAR.ROW;
    return {cells, centreEl: +(Math.asin(centre.y / centre.length()) / DEG).toFixed(2), centreAz: +(Math.atan2(-centre.x, -centre.z) / DEG).toFixed(2), widthDeg: +(p.w / BAR.D / DEG).toFixed(1), heightDeg: +(p.h / BAR.D / DEG).toFixed(1),
      cellDeg, rowDeg, worstNdc: +worst.toFixed(3), insideAllEyes: worst <= 1, eyes: eyes().length, distance: BAR.D, drawn: bar.drawn, yaw: +(bar.yaw / DEG).toFixed(2)};
  },
  /** Elevation (degrees from the eye) of the city's near and far edges and of every building top in view. */
  elevationSpan() {
    updateHead();
    const eye = city.root.worldToLocal(head.pos.clone()), vals = [];
    const el = (x, y, z) => { const d = Math.hypot(x - eye.x, z - eye.z); return Math.atan2(y - eye.y, d) / DEG; };
    const b = city.L.bounds;
    for (const g of city.L.buildings) vals.push(el(g.x, g.base, g.z));
    vals.sort((a, c) => a - c);
    const near = el((b.x0 + b.x1) / 2, 0, b.z1), far = el(city.L.centroid.x, 0, b.z0);
    return {eyeAltitude: +eye.y.toFixed(1), nearEdge: +near.toFixed(1), farEdge: +far.toFixed(1), buildingsLowest: +vals[0].toFixed(1), buildingsHighest: +vals[vals.length - 1].toFixed(1), p05: +vals[Math.floor(vals.length * 0.05)].toFixed(1), p95: +vals[Math.floor(vals.length * 0.95)].toFixed(1),
      span: +(vals[Math.floor(vals.length * 0.98)] - vals[Math.floor(vals.length * 0.02)]).toFixed(1), headPitch: +(head.pitch / DEG).toFixed(1)};
  },
  labels() { return city.labels.placed.map((l) => ({id: l.id, kind: l.kind, text: l.text, sub: l.sub, deg: +l.deg.toFixed(2), subDeg: +(l.deg * 28 / 34).toFixed(2), degW: +l.degW.toFixed(2), degH: +l.degH.toFixed(2), chars: l.text.length + (l.sub ? l.sub.length : 0), anchorGap: +l.anchorGap.toFixed(3), D: +l.D.toFixed(1)})); },
  cards() { return city.cards.placed.map((c) => ({sid: c.sid, kind: c.kind, textDeg: c.textDeg && +c.textDeg.toFixed(3), degW: +c.degW.toFixed(2), degH: +c.degH.toFixed(2), D: +c.D.toFixed(1), text: c.info?.text, chars: c.info?.chars, total: c.info?.total, lines: c.info?.lines, tool: c.info?.tool})); },
  preview() { const p = pops.preview; return p.mesh.visible ? {...p.drawn, visible: true} : {visible: false}; },
  hover(id) { A.hoverOverride = id; },
  /** Point the desktop mouse ray at an avatar cell (for hover tests without the page mouse). */
  avatarScreen(id) { const w = bar.cellWorld(id); if (!w) return null; const v = w.clone().project(camera), r = renderer.domElement.getBoundingClientRect(); return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height}; },
  nav() { return {...N.snapshot(), pos: N.nav.pos.toArray().map((v) => +v.toFixed(3)), altitude: +N.altitude(head.local).toFixed(2), anim: N.nav.anim ? N.nav.anim.key : null, moving: +N.nav.moving.toFixed(3)}; },
  setNav(o) { if (o.pos) N.nav.pos.fromArray(o.pos); if (o.yaw != null) N.nav.yaw = o.yaw; if (o.scale) N.nav.scale = o.scale; N.apply(city.root); },
  homeNav() { const h = N.homeView(); return {pos: h.pos.toArray(), yaw: h.yaw, scale: h.scale}; },
  /** Fly the rig directly (as the left stick would) for n seconds at full deflection. */
  flyFor(fwd, strafe, climb, secs) { const steps = Math.round(secs / 0.02); for (let i = 0; i < steps; i++) N.fly(head.yaw, fwd, strafe, climb, 0.02, head.local); N.apply(city.root); return N.nav.pos.toArray(); },
  /** Where a city point is, seen from the eye (azimuth / elevation, degrees, and distance). */
  seen(x, y, z) { updateHead(); const w = city.root.localToWorld(new THREE.Vector3(x, y, z)), d = w.sub(head.pos); return {el: +(Math.asin(d.y / d.length()) / DEG).toFixed(2), az: +(Math.atan2(-d.x, -d.z) / DEG).toFixed(2), dist: +d.length().toFixed(2)}; },
  placeOf(id) { return city.placeOf(id); },
  lines() { return city.lines.n; },
  buildingFx(path) { const g = city.L.byFile.get(path); if (!g) return null; const B = city.B, i = g.idx, sl = B.slotOf[i], F = B.fx.array, I = B.info.array; return {scan: F[sl * 4], hi: F[sl * 4 + 1], cur: F[sl * 4 + 2], heat: +I[sl * 4 + 2].toFixed(3), flare: +I[sl * 4 + 3].toFixed(3), drawn: sl < B.mesh.count}; },
  lod() { return {drawn: city.B.mesh.count, total: city.B.n, reorders: city.B.reorders}; },
  cardSource(sid) { return liveLine(get(sid)); },
  previewSource(sid) { return previewText(get(sid)); },
  /** A pi-web live card's source words are whole: every word on the card appears whole in the source text. */
  wholeWords(sid) { const c = city.cards.placed.find((x) => x.sid === sid); if (!c?.info?.text) return null; const L = liveLine(get(sid)), src = L.tool ? `${L.name} ${L.sum}` : L.text; const words = c.info.text.replace(/…/g, ' ').split(/\s+/).filter(Boolean); const srcWords = new Set(src.split(/\s+/)); return {ok: words.every((w) => srcWords.has(w)), words: words.length, bad: words.filter((w) => !srcWords.has(w))}; },
  /** Desktop only: point the camera (degrees). */
  look(yawDeg, pitchDeg) { window.__desk.lookYaw = yawDeg * DEG; window.__desk.lookPitch = pitchDeg * DEG; },
  tan,
};
