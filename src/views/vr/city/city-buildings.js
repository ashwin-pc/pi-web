// Every building in one InstancedMesh, with a level of detail that keeps the frame cheap at any scale: instances are
// re-ordered by how big each building looks from your eye (largest first, landmarks always), and only those larger
// than about 0.13° are drawn (mesh.count). From altitude that is the districts' massing; as you come closer, the
// small buildings appear. Per-building state (heat, flare, scan, highlight) lives in logical arrays and is written to
// the instance slots that changed, as small update ranges (a full upload only after a re-order).
// Far level of detail: each block's own files also have one coarse mass (their footprint, at their footprint-weighted
// mean height), in the same InstancedMesh. When a block's typical footprint looks smaller than MASS_RAD (about 0.46°),
// the block draws its mass instead of its buildings; its towers (taller than TOWER × the mass) still stand on their own,
// and a block with a beam, scan, flare or highlight on one of its files always shows its buildings. Past BUDGET drawn
// instances, more blocks are massed, the smallest-looking first, until the frame fits, but never one whose typical
// footprint looks larger than MASS_MAX (about 1.7°).
import * as THREE from 'three';
import {buildingMaterial} from './city-shade.js';
import {TYPES} from './city-tree.js';

const TYPE_IX = Object.fromEntries(TYPES.map((t, i) => [t, i]));
export const MIN_RAD = 0.0045; // ≈ 0.26°: below this a building is a few pixels; the large ones keep the massing
const QL = new URLSearchParams(location.search);
export const MASS_RAD = QL.get('lod') === '0' ? 0 : +(QL.get('massrad') || 0.008), TOWER = 2;
// Instance budget: beyond it, the blocks that look smallest are massed first until the frame fits (big workspaces).
export const SUB_RAD = QL.get('lod') === '0' ? 0 : +(QL.get('subrad') || 0.12), SUB_FOOT = +(QL.get('subfoot') || 0.012), MASS_EXT = +(QL.get('massext') || 0.2);
export const BUDGET = QL.get('lod') === '0' ? Infinity : +(QL.get('budget') || 1800), MASS_MAX = +(QL.get('massmax') || 0.03);
function boxNoBottom() {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const idx = g.index.array, keep = [];
  for (let f = 0; f < 6; f++) if (f !== 3) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]); // drop the bottom
  g.setIndex(keep);
  return g;
}
export class Buildings {
  constructor(L, marks) {
    this.L = L; this.marks = marks;
    const nB = L.buildings.length, n = nB + marks.length;
    this.n = n; this.nB = nB;
    this.masses = masses(L); this.subs = subtreeMasses(L, this.masses); this.masses.push(...this.subs.map((m) => m.mass)); this.massOf = new Int32Array(nB).fill(-1); this.massSlot = new Int32Array(this.masses.length).fill(-1);
    this.masses.forEach((m, j) => { if (!m.sub) for (const i of m.members) this.massOf[i] = j; });
    this.subOf = new Int32Array(nB).fill(-1); for (const sub of this.subs) for (const i of sub.mass.members) this.subOf[i] = sub.j;
    const nAll = n + this.masses.length;
    this.mesh = new THREE.InstancedMesh(boxNoBottom(), buildingMaterial(), nAll);
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(nAll * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(nAll * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aInfo', this.info); this.mesh.geometry.setAttribute('aFx', this.fx);
    this.mesh.name = 'buildings'; this.mesh.renderOrder = -5; this.mesh.frustumCulled = false;
    this.mesh.userData.fileCount = nB; this.mesh.userData.landmarks = marks;
    // Logical state per building (stable index g.idx).
    this.heat = new Float32Array(nB); this.flare = new Float32Array(nB); this.scan = new Float32Array(nB).fill(-1); this.hi = new Float32Array(nB); this.cur = new Float32Array(nB);
    this.slotOf = new Int32Array(nB); this.order = [];
    this.m = new THREE.Matrix4(); this.lastEye = null; this.lastT = 0; this.reorders = 0;
  }
  writeSlot(slot, item) {
    const m = this.m, I = this.info.array, F = this.fx.array;
    if (item.mass) { const k = item.mass, j = item.j; m.makeScale(k.w, k.h, k.d).setPosition(k.x, k.base, k.z); I.set([k.type, k.seed, this.massHeat(j) * 0.5, 0], slot * 4); F.set([-1, 0, 0, 0], slot * 4); this.massSlot[j] = slot; }
    else if (item.mark) { const k = item.mark; m.makeScale(k.w, k.h, k.d).setPosition(k.x, k.y, k.z); I.set([k.type, item.j * 0.37, 0, 0], slot * 4); F.set([-1, 0, 0, 0], slot * 4); }
    else { const g = item.g, i = g.idx; m.makeScale(g.w, g.h, g.d).setPosition(g.x, g.base, g.z); I.set([TYPE_IX[g.type] ?? 6, (i * 0.61803) % 1, this.heat[i], this.flare[i]], slot * 4); F.set([this.scan[i], this.hi[i], this.cur[i], 0], slot * 4); this.slotOf[i] = slot; }
    this.mesh.setMatrixAt(slot, m);
  }
  massHeat(j) { let h = 0; for (const i of this.masses[j].members) h = Math.max(h, this.heat[i]); return h; }
  active(i) { return this.flare[i] > 0 || this.scan[i] >= 0 || this.hi[i] > 0 || this.cur[i] > 0; }
  /** Re-order by apparent size from the eye (city metres). Cheap enough to run every second or after a move. */
  reorder(eye, fwd) {
    const B = this.L.buildings, M = this.masses, nI = B.length + M.length, sz = new Float32Array(nI), ids = new Int32Array(nI);
    const sizeOf = (x, y, z, r) => {
      const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z, d = Math.max(1, Math.hypot(dx, dy, dz));
      // Well outside the view (more than about 75° off your heading, with margin for its size): not drawn until you turn.
      if (fwd && (dx * fwd.x + dz * fwd.z) / Math.max(1, Math.hypot(dx, dz)) < 0.26 - r / d && d > 60) return 0;
      return r / d;
    };
    for (let i = 0; i < B.length; i++) { const g = B[i]; sz[i] = sizeOf(g.x, g.base + g.h * 0.5, g.z, Math.max(g.w, g.d, g.h)); ids[i] = i; }
    // A far block: its mass stands in for its small buildings (index B.length + j in sz / ids).
    this.massed = 0; this.massedBuildings = 0;
    let drawn = this.marks.length; for (let i = 0; i < B.length; i++) if (sz[i] > MIN_RAD) drawn++;
    const cand = [];
    M.forEach((m, j) => {
      const k = B.length + j; ids[k] = k; sz[k] = 0;
      const ext = sizeOf(m.x, m.base + m.h * 0.5, m.z, Math.max(m.w, m.d, m.h)), ms = ext * m.typical / Math.max(m.w, m.d, m.h);
      // Never a mass that would span more than MASS_EXT of your view (a big folder close by keeps its buildings).
      if (ms > 0 && (ext < MASS_EXT || ms < MASS_RAD) && !m.members.some((i) => this.active(i))) cand.push({j, k, m, ms});
    });
    // First the coarsest level: a whole top-level folder that looks smaller than SUB_RAD is one mass.
    const covered = new Set();
    const usedSub = [];
    for (const sub of this.subs) {
      if (usedSub.some((p) => sub.id.startsWith(p))) continue; // inside a coarser folder mass already drawn
      const m = sub.mass, k = B.length + sub.j;
      const ms = sizeOf(m.x, m.base + m.h * 0.5, m.z, Math.max(m.w, m.d, m.h)), foot = ms * m.typical / Math.max(m.w, m.d, m.h);
      if (!(ms > 0 && ms < SUB_RAD && foot < SUB_FOOT) || m.members.some((i) => this.active(i))) continue;
      sz[k] = 1; this.massed++; drawn++;
      for (const i of m.members) { if (sz[i] > MIN_RAD) drawn--; sz[i] = 0; this.massedBuildings++; }
      for (const j of sub.blockMasses) covered.add(j);
      usedSub.push(sub.id + '/');
    }
    cand.sort((a, b) => a.ms - b.ms);
    for (const {j, k, m, ms} of cand) {
      if (m.sub || covered.has(j)) continue;
      if (ms >= MASS_RAD && (drawn <= BUDGET || ms >= MASS_MAX)) break;
      sz[k] = 1; this.massed++; drawn++;
      for (const i of m.members) if (B[i].h < m.h * TOWER) { if (sz[i] > MIN_RAD) drawn--; sz[i] = 0; this.massedBuildings++; }
    }
    ids.sort((a, b) => sz[b] - sz[a]);
    let slot = 0;
    this.marks.forEach((k, j) => this.writeSlot(slot++, {mark: k, j}));
    let visible = this.marks.length;
    this.massSlot.fill(-1);
    for (const i of ids) { if (i < B.length) this.writeSlot(slot, {g: B[i]}); else this.writeSlot(slot, {mass: M[i - B.length], j: i - B.length}); if (sz[i] > MIN_RAD) visible = slot + 1; slot++; }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true; this.info.needsUpdate = true; this.fx.needsUpdate = true;
    this.info.clearUpdateRanges(); this.fx.clearUpdateRanges();
    this.lastEye = {x: eye.x, y: eye.y, z: eye.z}; this.lastFwd = fwd ? {x: fwd.x, z: fwd.z} : null; this.lastT = performance.now(); this.reorders++;
    this.drawn = visible;
  }
  /** Re-order when you have moved far enough (relative to your altitude) or after 1.5 s of drift. */
  maybeReorder(eye, fwd) {
    const e = this.lastEye;
    if (!e) return this.reorder(eye, fwd);
    const moved = Math.hypot(eye.x - e.x, eye.y - e.y, eye.z - e.z), alt = Math.max(10, eye.y);
    const turned = fwd && this.lastFwd ? fwd.x * this.lastFwd.x + fwd.z * this.lastFwd.z < Math.cos(15 * Math.PI / 180) * Math.hypot(fwd.x, fwd.z) * Math.hypot(this.lastFwd.x, this.lastFwd.z) : false;
    if (moved > Math.max(15, alt * 0.25) || turned || this.lodDirty || (moved > 2 && performance.now() - this.lastT > 1500)) { this.lodDirty = false; this.reorder(eye, fwd); }
  }
  /** Write the given buildings' current state to their slots (small update ranges). */
  touch(list) {
    const I = this.info.array, F = this.fx.array;
    for (const i of list) {
      const s = this.slotOf[i];
      I[s * 4 + 2] = this.heat[i]; I[s * 4 + 3] = this.flare[i];
      F[s * 4] = this.scan[i]; F[s * 4 + 1] = this.hi[i]; F[s * 4 + 2] = this.cur[i];
      this.info.addUpdateRange(s * 4, 4); this.fx.addUpdateRange(s * 4, 4);
      // A building that is drawn as part of its block's mass: keep the mass's heat, and show the buildings again
      // (on the next frame) when one of them becomes active.
      const j = this.massOf[i], ms = j >= 0 ? this.massSlot[j] : -1;
      if (ms >= 0 && ms < this.mesh.count) { I[ms * 4 + 2] = this.massHeat(j) * 0.5; this.info.addUpdateRange(ms * 4, 4); if (this.active(i)) this.lodDirty = true; }
      const q = this.subOf[i], qs = q >= 0 ? this.massSlot[q] : -1;
      if (qs >= 0 && qs < this.mesh.count) { I[qs * 4 + 2] = this.massHeat(q) * 0.5; this.info.addUpdateRange(qs * 4, 4); if (this.active(i)) this.lodDirty = true; }
    }
    if (list.length) { this.info.needsUpdate = true; this.fx.needsUpdate = true; }
  }
}

/** One coarse mass per block's own files (blocks with at least 3): their footprint's bounding box, slightly inset, at
 * their footprint-weighted mean height, in their most common type. typical: the median building footprint (metres). */
function masses(L) {
  const by = new Map();
  L.buildings.forEach((g, i) => { if (!by.has(g.block)) by.set(g.block, []); by.get(g.block).push(i); });
  const out = [];
  for (const [, members] of by) {
    if (members.length < 3) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, a = 0, v = 0; const types = new Map(), sizes = [];
    for (const i of members) { const g = L.buildings[i]; x0 = Math.min(x0, g.x - g.w / 2); x1 = Math.max(x1, g.x + g.w / 2); z0 = Math.min(z0, g.z - g.d / 2); z1 = Math.max(z1, g.z + g.d / 2); a += g.w * g.d; v += g.w * g.d * g.h; types.set(g.type, (types.get(g.type) || 0) + 1); sizes.push(Math.max(g.w, g.d)); }
    sizes.sort((p, q) => p - q);
    const g0 = L.buildings[members[0]], type = [...types].sort((p, q) => q[1] - p[1])[0][0];
    out.push({members, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: (x1 - x0) * 0.94, d: (z1 - z0) * 0.94, h: Math.max(2, v / a), base: g0.base, type: TYPE_IX[type] ?? 6, seed: (members[0] * 0.377) % 1, typical: sizes[Math.floor(sizes.length / 2)]});
  }
  return out;
}

/** The coarser levels: one mass per folder (its whole subtree, at least 12 files) over its block's plinth, at its
 * files' footprint-weighted mean height, coarsest first. A folder that looks smaller than SUB_RAD (about 6.9°) far
 * away, with buildings that look smaller than SUB_FOOT (about 0.7°), is drawn as its one mass, and nothing inside it is; j is its index in the mass list. */
function subtreeMasses(L, blockMasses) {
  const out = [], j0 = blockMasses.length;
  for (const b of L.blocks.filter((x) => x.rel >= 1).sort((p, q) => p.rel - q.rel)) {
    const pre = b.id + '/', members = [];
    L.buildings.forEach((g, i) => { if (g.block === b.id || g.block.startsWith(pre)) members.push(i); });
    if (members.length < 12) continue;
    let a = 0, v = 0; const types = new Map(), feet = [];
    for (const i of members) { const g = L.buildings[i]; a += g.w * g.d; v += g.w * g.d * g.h; types.set(g.type, (types.get(g.type) || 0) + 1); feet.push(Math.max(g.w, g.d)); }
    feet.sort((p, q) => p - q);
    const r = b.rect, type = [...types].sort((p, q) => q[1] - p[1])[0][0];
    out.push({id: b.id, mass: {sub: true, members, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: (r.x1 - r.x0) * 0.9, d: (r.z1 - r.z0) * 0.9, h: Math.max(2, 0.8 * v / a), base: b.y, type: TYPE_IX[type] ?? 6, seed: (members[0] * 0.211) % 1, typical: feet[Math.floor(feet.length / 2)]}, j: j0 + out.length,
      blockMasses: blockMasses.map((m, j) => [m, j]).filter(([m]) => { const blk = L.buildings[m.members[0]].block; return blk === b.id || blk.startsWith(pre); }).map(([, j]) => j)});
  }
  return out;
}
