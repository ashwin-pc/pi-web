// Live cards over the city: each running session's beam carries a compact pi-web card (dark panel, gold hairline,
// the avatar, the title, and the current streaming line or tool card). Sized in degrees (text ≥ 0.8°), billboarded,
// never moved off its beam: a card that would collide with another (or with the bar or the reading panel) becomes
// a small avatar coin instead, and so does a card that is too far away to be worth reading.
import * as THREE from 'three';
import {SANS, MONO, font, fillRR, icon, ellipsize} from './draw.js';
import {get} from './state.js';
import {drawAvatar} from './avatars.js';
import {liveLine, wrapNewest} from './city-text.js';

const CW = 400, CH = 150, CCOLS = 5, CROWS = 6, COIN = 96, KCOLS = 21, KROWS = 2;
const AW = 2048, AH = CROWS * CH + KROWS * COIN;
export const CARD = {W: CW, H: CH, TEXT_PX: 24, TITLE_PX: 26, TEXT_DEG: 0.84, COIN_DEG: 2.6, FAR: 640};
const tmp = new THREE.Vector3(), inv = new THREE.Quaternion(), right = new THREE.Vector3(), up = new THREE.Vector3();

export class Cards {
  constructor(scene) {
    this.canvas = document.createElement('canvas'); this.canvas.width = AW; this.canvas.height = AH;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter;
    const n = CCOLS * CROWS + KCOLS * KROWS;
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(n * 8), 2).setUsage(THREE.DynamicDrawUsage);
    const idx = []; for (let i = 0; i < n; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', this.pos); g.setAttribute('uv', this.uv); g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: this.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false}));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 23; this.mesh.name = 'cards';
    scene.add(this.mesh);
    this.cardSlot = new Map(); this.coinSlot = new Map(); this.sig = new Map(); this.drawnAt = new Map();
    this.placed = []; this.lastView = null; this.dirty = false;
  }
  slot(map, sid, max) { if (map.has(sid)) return map.get(sid); const used = new Set(map.values()); for (let i = 0; i < max; i++) if (!used.has(i)) { map.set(sid, i); return i; } return -1; }
  drawCard(i, sid) {
    const s = get(sid), ctx = this.ctx, x = (i % CCOLS) * CW, y = Math.floor(i / CCOLS) * CH;
    ctx.clearRect(x, y, CW, CH);
    fillRR(ctx, x + 2, y + 2, CW - 4, CH - 4, 14, 'rgba(10,10,10,0.93)', 'rgba(226,177,95,0.75)', 2);
    drawAvatar(ctx, sid, x + 34, y + 34, 21);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = font(CARD.TITLE_PX, 700, SANS); ctx.fillStyle = '#f2f2f2';
    const title = s.short && ctx.measureText(s.title).width > CW - 84 ? s.short : s.title;
    ctx.fillText(ellipsize(ctx, title, CW - 84), x + 64, y + 30);
    const L = liveLine(s), info = {sid, title, tool: L.tool};
    if (L.tool) {
      // A collapsed pi-web tool card: the running fill, a top border, a spinner, the tool name and its summary.
      // The summary wraps to a second line by whole words; if it still does not fit, its oldest words are dropped.
      fillRR(ctx, x + 14, y + 60, CW - 28, 78, 6, L.running ? '#14191f' : '#171b25', '#242424', 1.5);
      ctx.strokeStyle = '#2a2a2a'; ctx.beginPath(); ctx.moveTo(x + 14, y + 60); ctx.lineTo(x + CW - 14, y + 60); ctx.stroke();
      icon(ctx, L.running ? 'loader-circle' : 'brain', x + 38, y + 84, 24, '#e2b15f', 2.6);
      ctx.font = font(CARD.TEXT_PX, 700, MONO); ctx.fillStyle = '#f2f2f2'; const nw = ctx.measureText(L.name).width;
      ctx.fillText(L.name, x + 58, y + 84);
      ctx.font = font(CARD.TEXT_PX, 500, SANS); ctx.fillStyle = '#b5b5b5';
      const sw = wrapNewest(ctx, L.sum || '', [CW - 28 - 58 - nw - 24, CW - 28 - 58 - 12]);
      sw.lines.forEach((ln, k) => ctx.fillText(ln, x + 58 + (k ? 0 : nw + 12), y + 84 + k * 30));
      info.text = `${L.name} ${sw.lines.join(' ')}`; info.chars = L.name.length + 1 + sw.shown; info.total = L.name.length + 1 + sw.total; info.lines = sw.lines.length;
    } else {
      ctx.font = font(CARD.TEXT_PX, 400, SANS);
      const w = wrapNewest(ctx, L.text, [CW - 40, CW - 40]);
      ctx.fillStyle = '#e8e8e8';
      w.lines.forEach((ln, k) => ctx.fillText(ln, x + 18, y + 82 + k * 34));
      if (L.streaming && w.lines.length) { const lw = ctx.measureText(w.lines[w.lines.length - 1]).width; ctx.fillStyle = '#e2b15f'; ctx.fillRect(x + 22 + lw, y + 82 + (w.lines.length - 1) * 34 - 12, 4, 24); }
      info.text = w.lines.join(' '); info.chars = w.shown; info.total = w.total; info.lines = w.lines.length; info.cutMidWord = false;
    }
    this.dirty = true;
    return info;
  }
  drawCoin(i, sid) {
    const ctx = this.ctx, x = (i % KCOLS) * COIN, y = CROWS * CH + Math.floor(i / KCOLS) * COIN;
    ctx.clearRect(x, y, COIN, COIN);
    ctx.beginPath(); ctx.arc(x + 48, y + 48, 44, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10,10,10,0.9)'; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = '#e2b15f'; ctx.stroke();
    drawAvatar(ctx, sid, x + 48, y + 48, 36);
    this.dirty = true;
  }
  /** list: [{sid, at: Vector3 world, prio, distCity}]; obstacles: tangent-space boxes the cards must not cover. */
  update(list, view, obstacles = []) {
    inv.copy(view.camQ).invert();
    right.set(1, 0, 0).applyQuaternion(view.camQ); up.set(0, 1, 0).applyQuaternion(view.camQ);
    const B = view.bounds, boxes = obstacles.map((o) => ({...o})), out = [];
    const kT = Math.tan(CARD.TEXT_DEG * Math.PI / 180) / CARD.TEXT_PX;
    for (const c of [...list].sort((a, b) => b.prio - a.prio)) {
      // A card rides on its own beam: it may sit at any of a few heights up the beam's column (it never leaves the
      // beam); if none is free it becomes a coin at the beam's foot, and if even that is covered it hides.
      const far = c.distCity > CARD.FAR || c.coinOnly;
      const tries = far ? [] : (c.ats || [c.at]).map((a) => ['card', a]);
      for (const a of c.coinAts || [c.at]) tries.push(['coin', a]);
      let kind = null, box = null;
      for (const [k, a] of tries) {
        tmp.copy(a).sub(view.eye).applyQuaternion(inv);
        if (tmp.z > -0.5) continue;
        const D = -tmp.z;
        box = tryBox(k, tmp.x / D, tmp.y / D);
        if (box) { kind = k; c.at = a; c.depth = D; break; }
      }
      if (!box) continue;
      boxes.push(box);
      out.push({c, kind, box, D: c.depth});
    }
    function tryBox(k, tx, ty) {
        const w = k === 'card' ? CW * kT : Math.tan(CARD.COIN_DEG * Math.PI / 180), h = k === 'card' ? CH * kT : w;
        const box = {cx: tx, cy: ty + h / 2, w, h};
        if (box.cx - w / 2 < B.x0 || box.cx + w / 2 > B.x1 || box.cy + h / 2 > B.y1 || box.cy - h / 2 < B.y0) return null;
        if (boxes.some((o) => Math.abs(o.cx - box.cx) < (o.w + box.w) / 2 && Math.abs(o.cy - box.cy) < (o.h + box.h) / 2)) return null;
        return box;
    }
    const P = this.pos.array, UV = this.uv.array, now = performance.now();
    this.placed = [];
    out.forEach((o, n) => {
      let sx, sy, sw, sh, info = null;
      if (o.kind === 'card') {
        const i = this.slot(this.cardSlot, o.c.sid, CCOLS * CROWS); if (i < 0) return;
        const sig = o.c.sig;
        if (this.sig.get(o.c.sid) !== sig && (now - (this.drawnAt.get(o.c.sid) || 0) > 140 || !this.sig.has(o.c.sid))) { this.sig.set(o.c.sid, sig); this.drawnAt.set(o.c.sid, now); this.info = this.info || new Map(); this.info.set(o.c.sid, this.drawCard(i, o.c.sid)); }
        info = this.info?.get(o.c.sid) || null;
        sx = (i % CCOLS) * CW; sy = Math.floor(i / CCOLS) * CH; sw = CW; sh = CH;
      } else {
        const i = this.slot(this.coinSlot, o.c.sid, KCOLS * KROWS); if (i < 0) return;
        if (!this.coinDrawn?.has(o.c.sid)) { (this.coinDrawn ||= new Set()).add(o.c.sid); this.drawCoin(i, o.c.sid); }
        sx = (i % KCOLS) * COIN; sy = CROWS * CH + Math.floor(i / KCOLS) * COIN; sw = COIN; sh = COIN;
      }
      const wM = o.box.w * o.D, hM = o.box.h * o.D, base = o.c.at;
      [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]].forEach(([cx, cy], j) => { const p = base.clone().addScaledVector(right, cx * wM).addScaledVector(up, cy * hM); P.set([p.x, p.y, p.z], (n * 4 + j) * 3); });
      const u0 = sx / AW, u1 = (sx + sw) / AW, v1 = 1 - sy / AH, v0 = 1 - (sy + sh) / AH;
      UV.set([u0, v0, u1, v0, u1, v1, u0, v1], n * 8);
      this.placed.push({sid: o.c.sid, kind: o.kind, cx: o.box.cx, cy: o.box.cy, w: o.box.w, h: o.box.h, D: o.D, info,
        textDeg: o.kind === 'card' ? Math.atan(CARD.TEXT_PX * kT) * 180 / Math.PI : null, degW: Math.atan(o.box.w) * 180 / Math.PI, degH: Math.atan(o.box.h) * 180 / Math.PI});
    });
    this.mesh.geometry.setDrawRange(0, this.placed.length * 6);
    this.pos.needsUpdate = true; this.uv.needsUpdate = true;
    if (this.dirty) { this.tex.needsUpdate = true; this.dirty = false; }
    this.lastView = {eye: view.eye.clone(), inv: inv.clone()};
    this.mesh.visible = this.placed.length > 0;
  }
  /** The card or coin a ray points into (coins: within 2° of their disc), to open that session. */
  pick(ray) {
    const lv = this.lastView; if (!lv) return null;
    let best = null;
    for (const b of this.placed) {
      const v = ray.at(b.D, new THREE.Vector3()).sub(lv.eye).applyQuaternion(lv.inv);
      if (v.z > -0.05) continue;
      const x = v.x / -v.z, y = v.y / -v.z, slack = b.kind === 'coin' ? Math.tan(2 * Math.PI / 180) : 0;
      const dx = Math.max(0, Math.abs(x - b.cx) - b.w / 2 - slack), dy = Math.max(0, Math.abs(y - b.cy) - b.h / 2 - slack);
      if (dx || dy) continue;
      if (!best || b.D < best.distance) best = {sid: b.sid, distance: b.D, kind: b.kind};
    }
    return best;
  }
}
