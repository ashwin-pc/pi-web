// The City: the file system as a night city seen from above. Builds the layout and meshes, and every frame draws
// where work is happening (beams, flares, scans, rings, searchlights, lineage arcs, heat), the labels and the live
// cards. The city lives under `root`, which the flight model (city-nav.js) transforms; nothing here moves you.
import * as THREE from 'three';
import {buildLand, walk} from './city-tree.js';
import {layoutCity} from './city-layout.js';
import {buildBuildings, buildGround, buildFarGround, buildEmbers, U} from './city-mesh.js';
import {Beams, Lines} from './city-fx.js';
import {Labels} from './city-labels.js';
import {Cards} from './city-cards.js';
import {S, get, indicator} from './state.js';
import {ensureTouched, beamTarget, editTimes, heatOf, workersOf} from './city-targets.js';
import {liveLine} from './city-text.js';
import {cityLabelCands} from './city-lod.js';

const SLIDE_MS = 250;
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
export class City {
  constructor({scene, parent}) {
    this.scene = scene;
    this.root = new THREE.Group(); this.root.name = 'city'; parent.add(this.root);
    this.labels = new Labels(scene); this.cards = new Cards(scene); this.lines = new Lines(scene);
    this.beamFx = new Beams(this.root);
    this.beams = new Map(); // sid -> {cur: {x,y,z}, from, to, t0, target, fade}
    this.big = false; this.dim = 0; this.hover = null; this.frame = 0;
    this.build(false);
  }
  build(big) {
    this.big = big;
    this.land = buildLand(); // from client.files.tree (the big workspace is the client's)
    ensureTouched(this.land, [...S.sessions.values()]);
    this.L = layoutCity(this.land);
    for (const m of [this.buildings, this.ground, this.far, this.embers]) if (m) { this.root.remove(m); m.geometry.dispose(); }
    this.B = buildBuildings(this.L); this.buildings = this.B.mesh; this.ground = buildGround(this.L); this.far = buildFarGround(); this.embers = buildEmbers(this.L, big ? 900 : 520);
    this.root.add(this.far, this.ground, this.buildings, this.embers);
    this.info = this.B.info; this.fx = this.B.fx; this.touchedFx = [];
    this.heatTex = this.ground.userData.heatTex;
    // A coarse grid of buildings for the close-up file labels.
    this.grid = new Map();
    for (const g of this.L.buildings) { const k = `${Math.floor(g.x / 60)},${Math.floor(g.z / 60)}`; if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(g); }
    this.beams.clear(); this.names = null;
    this.retarget(true);
  }

  /** pi-web: a thread (avatar → beam, file → building) that never crosses a panel. The lines draw on top of
   * everything, so the pieces whose midpoint a panel covers (in the eye's tangent space) are left out. */
  threadSeg(a, b, alpha, o) {
    const blockers = o.threadBlockers || [];
    if (!blockers.length) { this.lines.seg(a, b, alpha); return; }
    const inv = o.camQ.clone().invert(), n = 32, p = new THREE.Vector3(), q = new THREE.Vector3(), m = new THREE.Vector3();
    const covered = (v) => { m.copy(v).sub(o.eye).applyQuaternion(inv); if (m.z > -0.05) return false; const tx = m.x / -m.z, ty = m.y / -m.z; return blockers.some((r) => Math.abs(tx - r.cx) <= r.w / 2 && Math.abs(ty - r.cy) <= r.h / 2); };
    for (let i = 0; i < n; i++) {
      p.lerpVectors(a, b, i / n); q.lerpVectors(a, b, (i + 1) / n);
      if (!covered(p.clone().add(q).multiplyScalar(0.5))) this.lines.seg(p, q, alpha);
    }
  }
  /** Re-read the sessions: beam targets (sliding 250 ms along the streets to a new file), heat, flares. */
  retarget(instant = false) {
    const now = Date.now(), t = performance.now();
    for (const id of S.pinned) {
      const s = get(id); if (!s) continue;
      const tg = beamTarget(this, s);
      const b = this.beams.get(id);
      if (!tg) { if (b) this.beams.delete(id); continue; }
      if (!b) { this.beams.set(id, {cur: {x: tg.x, y: tg.y, z: tg.z}, from: null, to: tg, t0: t - (instant ? 1e4 : 0), target: tg, born: instant ? t - 1e4 : t}); continue; }
      if (b.target.path !== tg.path || b.target.kind !== tg.kind || b.target.waiting !== tg.waiting) {
        b.from = {...b.cur}; b.to = tg; b.t0 = instant || S.reduceMotion ? t - 1e4 : t; b.target = tg;
        if (tg.kind === 'edit' && tg.building >= 0) (this.flares ||= new Map()).set(tg.building, t);
      }
    }
    for (const id of [...this.beams.keys()]) if (!S.pinned.includes(id)) this.beams.delete(id);
    // Heat: today's edits, fading over the hour; each block's ground shows the sum of its buildings.
    this.edits = editTimes(this, [...S.sessions.values()], now);
    const B = this.B, prevHot = this.hotIdx || [], hot = [];
    for (const i of prevHot) B.heat[i] = 0;
    const blockHeat = new Map();
    for (const [p, at] of this.edits) {
      const g = this.L.byFile.get(p), h = heatOf(at, now);
      B.heat[g.idx] = h; hot.push(g.idx);
      let d = this.land.files.get(p)?.dir;
      while (d) { if (this.L.byPath.has(d.path)) blockHeat.set(d.path, (blockHeat.get(d.path) || 0) + h); d = d.parent; }
    }
    const H = this.heatTex.image.data;
    H.fill(0);
    this.L.blocks.forEach((b, i) => { const v = blockHeat.get(b.id) || 0; H[i * 4] = Math.round(255 * (1 - Math.exp(-v * (b.rel <= 0 ? 0.35 : 0.9)))); H[i * 4 + 3] = 255; });
    this.heatTex.needsUpdate = true;
    if (B.lastEye) B.touch([...new Set([...prevHot, ...hot])]);
    this.hotIdx = hot;
    this.blockHeat = blockHeat;
  }
  /** Where a beam currently is (city metres), following its slide. */
  beamPos(id, out = new THREE.Vector3()) {
    const b = this.beams.get(id); if (!b) return null;
    const u = Math.min(1, (performance.now() - b.t0) / SLIDE_MS);
    if (!b.from || u >= 1) { b.cur = {x: b.to.x, y: b.to.y, z: b.to.z}; return out.set(b.cur.x, b.cur.y, b.cur.z); }
    const e = u * u * (3 - 2 * u), dx = b.to.x - b.from.x, dz = b.to.z - b.from.z, Lx = Math.abs(dx), Lz = Math.abs(dz), Ltot = Lx + Lz || 1;
    // Along the streets: first east-west, then north-south (a Manhattan path), in proportion to the distance.
    const d = e * Ltot, ex = Math.min(1, d / (Lx || 1e-6)), ez = Lx >= d ? 0 : (d - Lx) / (Lz || 1e-6);
    b.cur = {x: b.from.x + dx * (Lx ? ex : 1), y: b.from.y + (b.to.y - b.from.y) * e, z: b.from.z + dz * Math.min(1, ez)};
    return out.set(b.cur.x, b.cur.y, b.cur.z);
  }
  beamWorld(id, lift = 0, out = new THREE.Vector3()) { const p = this.beamPos(id, out); if (!p) return null; p.y += lift; return this.root.localToWorld(p); }
  /** Where a session's place in the city is (for "fly to"): its beam, or else its working folder's block. */
  placeOf(id) {
    const p = this.beamPos(id, new THREE.Vector3()); if (p) return {x: p.x, y: p.y, z: p.z, size: 60, top: this.topNear(p.x, p.z, 45)};
    const s = get(id); const b = this.L.byPath.get(s.cwd) || this.L.byPath.get(this.land.root.path);
    return this.placeOfBlock(b);
  }
  placeOfBlock(b) { const r = b.rect, x = (r.x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2; return {x, y: b.y, z, size: Math.max(r.x1 - r.x0, r.z1 - r.z0), top: this.topNear(x, z, Math.max(r.x1 - r.x0, r.z1 - r.z0) * 0.7)}; }
  /** The tallest roof within r metres of a point (so an overlook is always above the rooftops). */
  topNear(x, z, r) { let t = 0; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const g of this.grid.get(`${Math.floor(x / 60) + i},${Math.floor(z / 60) + j}`) || []) if (Math.hypot(g.x - x, g.z - z) < r) t = Math.max(t, g.base + g.h); return t; }

  /** The lower edge of the city's centre region in view, as an angle (degrees, negative = below) from the view axis
   * of the given eye cameras: the 25th percentile of the in-view buildings' projected centres (the lowest eye's).
   * The bar keeps below it. null if hardly any city is in view. */
  contentLow(cams) {
    const B = this.L.buildings, step = Math.max(1, Math.floor(B.length / 600)), v = new THREE.Vector3();
    this.root.updateMatrixWorld();
    let low = null;
    for (const cam of cams) {
      cam.updateMatrixWorld(); const ys = [];
      for (let i = 0; i < B.length; i += step) { const g = B[i]; v.set(g.x, g.base + g.h / 2, g.z); this.root.localToWorld(v).project(cam); if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) ys.push(v.y); }
      if (ys.length < 8) continue;
      ys.sort((a, b) => a - b);
      const y0 = ys[Math.floor((ys.length - 1) * 0.25)], P = cam.projectionMatrix.elements;
      const ang = Math.atan((y0 + P[9]) / P[5]) * 180 / Math.PI;
      low = low == null ? ang : Math.min(low, ang);
    }
    return low;
  }

  /** o: {dt, eye (world), camQ, bounds, reading, currentId, hover (sid), obstacles, navScale} */
  update(o) {
    this.frame++;
    const t = performance.now() / 1000, scale = o.navScale || 1;
    U.uTime.value = t; U.uEye.value.copy(o.eye); U.uScale.value = 1 / scale; U.uFogK.value = (1 / 900) / Math.max(1, scale / 3); // no haze on a tabletop
    this.dim += ((o.reading ? 1 : 0) - this.dim) * (S.reduceMotion ? 1 : Math.min(1, o.dt / 0.12));
    U.uDim.value = this.dim * 0.7;
    const eyeC = this.root.worldToLocal(v1.copy(o.eye)).clone();
    // Beams, impact glows, bash rings, searchlights; flares and scans on the buildings they touch.
    const B = this.B;
    const fwdC = this.root.worldToLocal(new THREE.Vector3(0, 0, -1).applyQuaternion(o.camQ).add(o.eye)).sub(eyeC);
    B.maybeReorder(eyeC, fwdC);
    const beams = [], decals = [];
    for (const k of this.touchedFx) { B.scan[k] = -1; B.hi[k] = 0; B.cur[k] = 0; B.flare[k] = 0; }
    const touched = [];
    for (const [id, b] of this.beams) {
      const p = this.beamPos(id, v2), tg = b.to, s = get(id), hi = this.hover === id ? 1 : 0, cur = id === o.currentId;
      const born = Math.min(1, (performance.now() - b.born) / 400);
      const D = Math.max(20, Math.hypot(p.x - eyeC.x, p.y - eyeC.y, p.z - eyeC.z));
      const r = Math.max(tg.waiting ? 3.2 : 1.3, D * (tg.waiting ? 0.0075 : 0.0032));
      beams.push({x: p.x, y: p.y, z: p.z, r, intensity: (tg.waiting ? 0.8 : 1) * born * (cur ? 1.25 : 1), hi, kind: tg.waiting ? 1 : 0, seed: (id.length * 0.37) % 1});
      decals.push({x: p.x, y: p.y, z: p.z, size: Math.max(14, D * 0.05) * (tg.waiting ? 1.6 : 1), mode: 0, intensity: 0.8 * born});
      if (hi || cur) decals.push({x: p.x, y: p.y, z: p.z, size: Math.max(18, D * 0.07), mode: 3, intensity: hi ? 1 : 0.5});
      const br = tg.blockRect || this.L.byPath.get(tg.block)?.rect, by = this.L.byPath.get(tg.block)?.y ?? p.y;
      if (tg.kind === 'bash' && br) decals.push({x: (br.x0 + br.x1) / 2, y: by, z: (br.z0 + br.z1) / 2, size: Math.min(br.x1 - br.x0, br.z1 - br.z0) * 0.95, mode: 1, seed: b.seed || 0.3, intensity: 1});
      if (tg.kind === 'search' && br) decals.push({x: (br.x0 + br.x1) / 2, y: by, z: (br.z0 + br.z1) / 2, size: Math.max(br.x1 - br.x0, br.z1 - br.z0) * 1.0, mode: 2, seed: 0.2, intensity: 1});
      const k = tg.building;
      if (k >= 0) {
        if (tg.kind === 'read') B.scan[k] = (t / 1.6 + (id.length % 5) * 0.2) % 1;
        if (tg.kind === 'edit') B.flare[k] = 0.55 + 0.25 * Math.sin(t * 4);
        B.hi[k] = hi; B.cur[k] = cur ? 1 : 0; touched.push(k);
      }
      void s;
    }
    // A fresh edit flares the whole building for a moment.
    if (this.flares) for (const [k, t0] of this.flares) { const u = (performance.now() - t0) / 900; if (u > 1) { this.flares.delete(k); continue; } B.flare[k] = Math.max(B.flare[k], 1 - u * 0.5); touched.push(k); }
    // Round 3: a file picked in the focus panel's context column (or an artifact's file) lights up its building.
    const fg = o.fileThread && this.L.byFile.get(o.fileThread.path);
    if (fg) { B.hi[fg.idx] = 1; touched.push(fg.idx); }
    B.touch([...new Set([...this.touchedFx, ...touched])]);
    this.touchedFx = touched;
    this.beamFx.set(beams, decals);
    // Lineage: thin gold arcs from a waiting parent's column to each of its workers' beams. Thread: bar → beam.
    this.lines.begin();
    for (const [id, b] of this.beams) {
      if (!b.to.waiting) continue;
      const a = this.beamWorld(id, 70, new THREE.Vector3());
      for (const w of workersOf(get(id))) { const c = this.beamWorld(w, 45, new THREE.Vector3()); if (c) this.lines.arc(a, c, 40 / scale, 20, 0.75); }
    }
    if (o.thread) { const c = this.beamWorld(o.thread.sid, 0, new THREE.Vector3()) || this.root.localToWorld(new THREE.Vector3(...Object.values(this.placeOf(o.thread.sid)).slice(0, 3))); this.threadSeg(o.thread.from, c, 0.9, o); }
    if (fg) this.threadSeg(o.fileThread.from, this.root.localToWorld(new THREE.Vector3(fg.x, fg.base + fg.h, fg.z)), 0.9, o);
    this.lines.end();
    // Labels and cards: sized in degrees, at their referents, the bar and the reading panel as obstacles.
    if (this.frame % 3 === 1 || !this.cands) {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(o.camQ).add(o.eye); const fC = this.root.worldToLocal(f).sub(eyeC).normalize();
      this.cands = cityLabelCands(this, eyeC, scale, fC);
    }
    for (const c of this.cands) c.at = this.root.localToWorld(c.local.clone());
    const view = {eye: o.eye, camQ: o.camQ, bounds: o.bounds};
    const cards = [];
    for (const [id, b] of this.beams) {
      const s = get(id), p = this.beamWorld(id, b.to.waiting ? 74 : 26, new THREE.Vector3());
      const L = liveLine(s), dC = p.distanceTo(o.eye) * scale;
      const ats = [26, 8, 70, 120, 175, 235].map((h) => this.beamWorld(id, (b.to.waiting ? 48 : 0) + h, new THREE.Vector3()));
      cards.push({sid: id, at: p, ats, coinAts: [8, 45, 90, 140].map((h) => this.beamWorld(id, h, new THREE.Vector3())), prio: (id === o.currentId ? 100 : 0) + (this.hover === id ? 200 : 0) + (b.to.waiting ? 5 : 10) - dC / 100, distCity: dC, sig: `${s.title}|${L.tool ? L.name + L.sum : L.text}|${L.streaming ? 1 : 0}`, coinOnly: o.reading && id !== o.currentId});
    }
    // District names reserve their room first (they are what you read from altitude); then the cards; then the rest.
    const reserved = o.reading ? [] : this.labels.boxesFor(this.cands.filter((c) => c.kind === 'district'), view);
    this.cards.update(cards, view, [...(o.obstacles || []), ...reserved]);
    const cardBoxes = this.cards.placed.map((c) => ({cx: c.cx, cy: c.cy, w: c.w, h: c.h}));
    this.labels.update(o.reading ? [] : this.cands, {...view, obstacles: cardBoxes}, [...(o.obstacles || []), ...cardBoxes]);
  }
  /** What a ray selects in the city: a live card or coin (its session), or a sign (fly to it). */
  pick(ray) {
    const c = this.cards.pick(ray); if (c) return {session: c.sid, distance: c.distance, kind: c.kind};
    const l = this.labels.pick(ray); if (l) return {label: l.label, distance: l.distance, point: l.point, angle: l.angle};
    return null;
  }
  get fileCount() { return this.L.buildings.length; }
  dirCount() { return [...walk(this.land.root)].length; }
}
export {indicator};
