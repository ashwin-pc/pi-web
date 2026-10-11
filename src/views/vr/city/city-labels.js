// City labels: district names on their towers, avenue and block street signs, and building (file) names close up.
// One atlas texture, one mesh. Every label is sized in degrees from the eye (titles ≥ 0.8°, status lines ≥ 0.7°),
// sits on its referent (never displaced: a label that collides with a higher-priority one hides), and shows only at
// the distance where it carries information: districts from altitude, blocks closer, files close up.
import * as THREE from 'three';
import {SANS, MONO, font, fillRR} from './draw.js';

const SLOT_W = 680, SLOT_H = 84, COLS = 3, ROWS = 24, EM = 34, SUB = 28;
export const LABEL = {EM, SUB, SLOT_H};
const tmp = new THREE.Vector3(), inv = new THREE.Quaternion(), right = new THREE.Vector3(), up = new THREE.Vector3();

export class Labels {
  constructor(scene) {
    this.canvas = document.createElement('canvas'); this.canvas.width = SLOT_W * COLS; this.canvas.height = SLOT_H * ROWS;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter;
    const n = COLS * ROWS;
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(n * 4 * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const idx = []; for (let i = 0; i < n; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', this.pos); g.setAttribute('uv', this.uv); g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: this.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false}));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 22; this.mesh.name = 'labels';
    scene.add(this.mesh);
    this.slots = new Map(); // key -> {i, w, used}
    this.free = Array.from({length: n}, (_, i) => i);
    this.placed = []; this.dirty = false; this.lastView = null;
  }
  slotFor(c) {
    const key = `${c.kind}|${c.text}|${c.sub || ''}|${c.hot ? 1 : 0}`;
    let s = this.slots.get(key);
    if (s) { s.used = this.frame; return s; }
    if (!this.free.length) {
      // Evict the least recently used slot that is not in use this frame.
      let old = null; for (const [k, v] of this.slots) if (v.used < this.frame && (!old || v.used < old[1].used)) old = [k, v];
      if (!old) return null;
      this.slots.delete(old[0]); this.free.push(old[1].i);
    }
    const i = this.free.pop();
    s = {i, w: this.draw(i, c), used: this.frame, key, shown: c.shown};
    this.slots.set(key, s); this.dirty = true;
    return s;
  }
  /** Draws a pi-web-style pill: dark panel, hairline border (gold for districts and hot blocks), title and status. */
  draw(i, c) {
    const x = (i % COLS) * SLOT_W, y = Math.floor(i / COLS) * SLOT_H, ctx = this.ctx;
    ctx.clearRect(x, y, SLOT_W, SLOT_H);
    const mono = c.kind === 'file';
    ctx.font = font(EM, 700, mono ? MONO : SANS);
    // A name too long for the slot keeps its start and its end (the extension), with an ellipsis in the middle.
    if (ctx.measureText(c.text).width > SLOT_W - 40) { let k = c.text.length; while (k > 8 && ctx.measureText(c.text.slice(0, Math.ceil(k / 2)) + '…' + c.text.slice(-Math.floor(k / 2))).width > SLOT_W - 40) k--; c.shown = c.text.slice(0, Math.ceil(k / 2)) + '…' + c.text.slice(-Math.floor(k / 2)); } else c.shown = c.text;
    const tw = ctx.measureText(c.shown).width;
    ctx.font = font(SUB, 600, SANS); const sw = c.sub ? ctx.measureText(c.sub).width : 0;
    const w = Math.min(SLOT_W - 4, Math.ceil(Math.max(tw, sw) + 30));
    const h = c.sub ? SLOT_H - 4 : 52;
    const gold = c.kind === 'district' || c.hot;
    fillRR(ctx, x + 2, y + 2, w, h, 12, 'rgba(10,10,10,0.86)', gold ? 'rgba(226,177,95,0.85)' : 'rgba(64,64,64,0.9)', 2);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = font(EM, 700, mono ? MONO : SANS); ctx.fillStyle = c.kind === 'district' ? '#e2b15f' : '#f2f2f2';
    ctx.fillText(c.shown, x + 17, y + 2 + 26);
    if (c.sub) { ctx.font = font(SUB, 600, SANS); ctx.fillStyle = c.hot ? '#e2b15f' : '#a3a3a3'; ctx.fillText(c.sub, x + 17, y + 2 + 60); }
    return {w: w + 4, h: h + 4};
  }
  /**
   * cands: [{id, kind, text, sub, at: Vector3 world (the referent's top), deg (title em), prio, click}].
   * view: {eye, camQ, bounds: {x0, x1, y0, y1} in tangent space}. Places greedily by priority; hides collisions.
   */
  update(cands, view, obstacles = []) {
    this.frame = (this.frame || 0) + 1;
    inv.copy(view.camQ).invert();
    right.set(1, 0, 0).applyQuaternion(view.camQ); up.set(0, 1, 0).applyQuaternion(view.camQ);
    const boxes = obstacles.map((o) => ({...o})), out = [];
    this.rejected = [];
    cands.sort((a, b) => b.prio - a.prio);
    const B = view.bounds;
    for (const c of cands) {
      tmp.copy(c.at).sub(view.eye).applyQuaternion(inv);
      if (tmp.z > -0.5) continue;
      const D = -tmp.z, tx = tmp.x / D, ty = tmp.y / D;
      const k = Math.tan(c.deg * Math.PI / 180) / EM; // tangent units per atlas pixel
      const s = this.slotFor(c); if (!s) continue;
      const w = s.w.w * k, h = s.w.h * k;
      // The label stands on its referent: its bottom edge just above the anchor, centred.
      const box = {cx: tx, cy: ty + h / 2 + 4 * k, w, h};
      if (box.cx - w / 2 < B.x0 || box.cx + w / 2 > B.x1 || box.cy + h / 2 > B.y1 || box.cy - h / 2 < B.y0) { this.rejected.push({id: c.id, why: 'edge', box: [box.cx, box.cy, box.w, box.h].map((x) => +x.toFixed(3)), B: [B.x0, B.x1, B.y0, B.y1].map((x) => +x.toFixed(3))}); continue; }
      const hit = boxes.find((o) => Math.abs(o.cx - box.cx) < (o.w + box.w) / 2 + 0.002 && Math.abs(o.cy - box.cy) < (o.h + box.h) / 2 + 0.002);
      if (hit) { this.rejected.push({id: c.id, why: hit.id || 'label', by: [hit.cx, hit.cy, hit.w, hit.h].map((x) => +x.toFixed(3)), box: [box.cx, box.cy, box.w, box.h].map((x) => +x.toFixed(3))}); continue; }
      boxes.push(box);
      out.push({c, s, box, D, k}); // D: depth along the view axis (the box is in tangent units of depth)
      if (out.length >= COLS * ROWS - 2) break;
    }
    // Fill the quads (billboards facing the view, in world space).
    const P = this.pos.array, UV = this.uv.array;
    out.forEach((o, n) => {
      const D = o.D, wM = o.box.w * D, hM = o.box.h * D;
      const base = o.c.at.clone().addScaledVector(up, 4 * o.k * D);
      const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      corners.forEach(([cx, cy], j) => {
        const p = base.clone().addScaledVector(right, cx * wM).addScaledVector(up, cy * hM);
        P.set([p.x, p.y, p.z], (n * 4 + j) * 3);
      });
      const sx = (o.s.i % COLS) * SLOT_W, sy = Math.floor(o.s.i / COLS) * SLOT_H, W = this.canvas.width, H = this.canvas.height;
      const u0 = sx / W, u1 = (sx + o.s.w.w) / W, v1 = 1 - sy / H, v0 = 1 - (sy + o.s.w.h) / H;
      UV.set([u0, v0, u1, v0, u1, v1, u0, v1], n * 8);
    });
    this.mesh.geometry.setDrawRange(0, out.length * 6);
    this.pos.needsUpdate = true; this.uv.needsUpdate = true;
    if (this.dirty) { this.tex.needsUpdate = true; this.dirty = false; }
    this.placed = out.map((o) => ({id: o.c.id, kind: o.c.kind, text: o.s.shown || o.c.text, full: o.c.text, sub: o.c.sub || '', click: o.c.click, cx: o.box.cx, cy: o.box.cy, w: o.box.w, h: o.box.h, D: o.D, deg: o.c.deg,
      degW: Math.atan(o.box.w) * 180 / Math.PI, degH: Math.atan(o.box.h) * 180 / Math.PI, anchorGap: 4 * o.k / o.box.h}));
    this.lastView = {eye: view.eye.clone(), inv: inv.clone()};
    this.mesh.visible = out.length > 0;
  }
  /** Where these labels would sit (tangent-space boxes), without placing them: districts reserve their room first. */
  boxesFor(cands, view) {
    const q = view.camQ.clone().invert(), out = [];
    for (const c of cands) {
      tmp.copy(c.at).sub(view.eye).applyQuaternion(q);
      if (tmp.z > -0.5) continue;
      const D = -tmp.z, k = Math.tan(c.deg * Math.PI / 180) / EM, s = this.slotFor(c); if (!s) continue;
      const w = s.w.w * k, h = s.w.h * k;
      out.push({id: c.id, cx: tmp.x / D, cy: tmp.y / D + h / 2 + 4 * k, w, h});
    }
    return out;
  }
  /** The label a ray points at (or within 3° of: the nearest wins), for selecting a block sign. */
  pick(ray) {
    const lv = this.lastView; if (!lv) return null;
    let best = null;
    for (const b of this.placed) {
      if (!b.click) continue;
      const v = ray.at(b.D, new THREE.Vector3()).sub(lv.eye).applyQuaternion(lv.inv);
      if (v.z > -0.05) continue;
      const x = v.x / -v.z, y = v.y / -v.z;
      const dx = Math.max(0, Math.abs(x - b.cx) - b.w / 2), dy = Math.max(0, Math.abs(y - b.cy) - b.h / 2), ang = Math.atan(Math.hypot(dx, dy));
      if (ang > 3 * Math.PI / 180 || (best && ang >= best.angle)) continue;
      best = {label: b, angle: ang, distance: b.D, point: ray.at(b.D, new THREE.Vector3())};
    }
    return best;
  }
}
