// Every building in one InstancedMesh, with a level of detail that keeps the frame cheap at any scale: instances are
// re-ordered by how big each building looks from your eye (largest first, landmarks always), and only those larger
// than about 0.13° are drawn (mesh.count). From altitude that is the districts' massing; as you come closer, the
// small buildings appear. Per-building state (heat, flare, scan, highlight) lives in logical arrays and is written to
// the instance slots that changed, as small update ranges (a full upload only after a re-order).
import * as THREE from 'three';
import {buildingMaterial} from './city-shade.js';
import {TYPES} from './city-tree.js';

const TYPE_IX = Object.fromEntries(TYPES.map((t, i) => [t, i]));
export const MIN_RAD = 0.0045; // ≈ 0.26°: below this a building is a few pixels; the large ones keep the massing
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
    this.mesh = new THREE.InstancedMesh(boxNoBottom(), buildingMaterial(), n);
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
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
    if (item.mark) { const k = item.mark; m.makeScale(k.w, k.h, k.d).setPosition(k.x, k.y, k.z); I.set([k.type, item.j * 0.37, 0, 0], slot * 4); F.set([-1, 0, 0, 0], slot * 4); }
    else { const g = item.g, i = g.idx; m.makeScale(g.w, g.h, g.d).setPosition(g.x, g.base, g.z); I.set([TYPE_IX[g.type] ?? 6, (i * 0.61803) % 1, this.heat[i], this.flare[i]], slot * 4); F.set([this.scan[i], this.hi[i], this.cur[i], 0], slot * 4); this.slotOf[i] = slot; }
    this.mesh.setMatrixAt(slot, m);
  }
  /** Re-order by apparent size from the eye (city metres). Cheap enough to run every second or after a move. */
  reorder(eye, fwd) {
    const B = this.L.buildings, sz = new Float32Array(B.length), ids = new Int32Array(B.length);
    for (let i = 0; i < B.length; i++) {
      const g = B[i], dx = g.x - eye.x, dy = g.base + g.h * 0.5 - eye.y, dz = g.z - eye.z, d = Math.max(1, Math.hypot(dx, dy, dz)), r = Math.max(g.w, g.d, g.h);
      sz[i] = r / d;
      // Well outside the view (more than about 75° off your heading, with margin for its size): not drawn until you turn.
      if (fwd && (dx * fwd.x + dz * fwd.z) / Math.max(1, Math.hypot(dx, dz)) < 0.26 - r / d && d > 60) sz[i] = 0;
      ids[i] = i;
    }
    ids.sort((a, b) => sz[b] - sz[a]);
    let slot = 0;
    this.marks.forEach((k, j) => this.writeSlot(slot++, {mark: k, j}));
    let visible = this.marks.length;
    for (const i of ids) { this.writeSlot(slot, {g: B[i]}); if (sz[i] > MIN_RAD) visible = slot + 1; slot++; }
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
    if (moved > Math.max(15, alt * 0.25) || turned || (moved > 2 && performance.now() - this.lastT > 1500)) this.reorder(eye, fwd);
  }
  /** Write the given buildings' current state to their slots (small update ranges). */
  touch(list) {
    const I = this.info.array, F = this.fx.array;
    for (const i of list) {
      const s = this.slotOf[i];
      I[s * 4 + 2] = this.heat[i]; I[s * 4 + 3] = this.flare[i];
      F[s * 4] = this.scan[i]; F[s * 4 + 1] = this.hi[i]; F[s * 4 + 2] = this.cur[i];
      this.info.addUpdateRange(s * 4, 4); this.fx.addUpdateRange(s * 4, 4);
    }
    if (list.length) { this.info.needsUpdate = true; this.fx.needsUpdate = true; }
  }
}
