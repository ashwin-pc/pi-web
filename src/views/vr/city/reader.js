// The reading panel (borrowed from vr-breeze and adapted): a header, a stream of turns (one texture per turn, so
// scrolling and switching never re-rasterise text), the turn strip, fades, and the "new output" pill.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, turnsOf} from './state.js';
import * as V from './views.js';
import {PPM, TURN_W, layoutTurn, drawTurn} from './turns.js';
import {world, frameMesh, frameRingGeo, setFrameSize, nowMs, animMs, clamp, easeOut, R, RW, RH, TOP, STREAM_TOP, STREAM_BOT} from './core.js';

export const VIEW_PX = Math.round(R.streamH * PPM);
export const TURN_GAP = 22, SNAP_MARGIN = 14;
export const TURN_X = -RW / 2 + 0.006;

// ------------------------------------------------------------------ turn sets: one texture per turn, cached per session
const scratch = document.createElement('canvas').getContext('2d');
export const sets = new Map(); // sid -> TurnSet (LRU by lastUse)
export const expandedBySid = new Map();
function turnKey(s, t, i, exp, mark) {
  const parts = [i, t.start, t.end, mark != null && mark >= t.start && mark < t.end ? mark : -1];
  for (let j = t.start; j < t.end; j++) { const m = s.messages[j]; parts.push(m.type[0] + (m.status || '') + (m.sum || '') + (m.html?.length || 0) + (m.streaming ? 's' : '') + (exp.has(j) ? 'x' : '')); }
  return parts.join('|');
}
export class TurnSet {
  constructor(sid) {
    this.sid = sid; this.group = new THREE.Group(); this.turns = []; this.height = 0; this.markY = null; this.markF = null; this.lastUse = nowMs(); this.reader = null;
    this.expanded = expandedBySid.get(sid) || new Set(); expandedBySid.set(sid, this.expanded);
    this.build();
  }
  mark() { const s = get(this.sid); return s.id === S.currentId ? s.newMark : s.seenCount < s.messages.length ? s.seenCount : null; }
  build() {
    const s = get(this.sid);
    const ts = turnsOf(s), mark = this.mark();
    const next = [];
    let y = 8;
    ts.forEach((t, i) => {
      const key = turnKey(s, t, i, this.expanded, mark);
      let tt = this.turns[i]?.key === key ? this.turns[i] : null;
      if (!tt) { this.turns[i]?.panel.dispose(); tt = this.makeTurn(s, t, i, mark, key); }
      tt.top = y;
      tt.panel.mesh.position.set(0, -y / PPM, 0);
      y += tt.h + TURN_GAP;
      next.push(tt);
    });
    for (let i = ts.length; i < this.turns.length; i++) this.turns[i].panel.dispose();
    this.turns = next;
    this.height = y + 10;
    const mi = next.findIndex((tt) => tt.markY != null);
    this.markY = mi >= 0 ? next[mi].top + next[mi].markY : null;
    this.markF = mi >= 0 ? (mi + next[mi].markY / next[mi].h) / next.length : null;
    this.stale = false;
    if (this.reader) this.reader.attachClip(this);
  }
  makeTurn(s, t, i, mark, key) {
    const lay = layoutTurn(scratch, s, t, {index: i, expanded: this.expanded, newMark: mark});
    const h = Math.min(lay.h, 4096);
    const sid = this.sid;
    // pi-web: a turn that is still streaming is rebuilt on every update; building its mipmaps each time is the costly
    // part (as for the round 3 tiles), so only settled turns get them.
    let live = false; for (let j = t.start; j < t.end; j++) if (s.messages[j].streaming || s.messages[j].status === 'running') live = true;
    const panel = new Panel(`turn:${sid}:${i}`, {w: TURN_W / PPM, h: h / PPM, ppm: PPM, canvasW: TURN_W, canvasH: h, anchorX: 0, anchorY: 1, renderOrder: 3, hoverRedraw: false, mipmaps: !live,
      draw: (ctx, p) => { drawTurn(ctx, lay, TURN_W); for (const r of lay.regions) p.region(`chip:${sid}:${r.msg}`, 0, r.y, TURN_W, r.h, {chip: r.msg, click: () => V.UI.toggleChip(sid, r.msg)}); }});
    panel.isTurn = true;
    panel.mat.depthWrite = false;
    this.group.add(panel.mesh);
    return {panel, key, h, top: 0, replyY: lay.replyY, markY: lay.markY};
  }
  snapPos(i) { return this.turns[i].top - SNAP_MARGIN; }
  dispose() { for (const t of this.turns) t.panel.dispose(); this.turns = []; this.group.parent?.remove(this.group); sets.delete(this.sid); }
}
export function setFor(sid) {
  let set = sets.get(sid);
  if (!set) { set = new TurnSet(sid); sets.set(sid, set); }
  else if (set.stale) set.build();
  set.lastUse = nowMs();
  // LRU: keep the current session, the readers' sessions and the prefetched neighbours; drop the rest.
  if (sets.size > 6) {
    const keep = new Set([S.currentId, ...readers.map((r) => r.sid), sid]);
    const old = [...sets.values()].filter((x) => !keep.has(x.sid)).sort((a, b) => a.lastUse - b.lastUse);
    while (sets.size > 6 && old.length) old.shift().dispose();
  }
  return set;
}

// ------------------------------------------------------------------ the reader: header, stream of turns, turn strip
// Top and bottom fades over the stream: one mesh (one draw call) whose per-vertex alpha ramps away from each edge.
const fadeMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false,
  vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform float uOpacity; uniform vec3 uCol; varying float vA; void main(){ gl_FragColor = vec4(uCol, vA * vA * uOpacity);
    #include <colorspace_fragment>
  }`,
  uniforms: {uOpacity: {value: 1}, uCol: {value: new THREE.Color(0x050505)}},
});
function fadeGeo(w, h, yTop, yBot) {
  const pos = [], a = [], idx = [];
  for (const [y0, top] of [[yTop - h, true], [yBot, false]]) {
    const b = pos.length / 3;
    pos.push(0, y0, 0, w, y0, 0, w, y0 + h, 0, 0, y0 + h, 0);
    a.push(...(top ? [0, 0, 1, 1] : [1, 1, 0, 0]));
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aA', new THREE.Float32BufferAttribute(a, 1)); g.setIndex(idx);
  return g;
}
export class Reader {
  constructor(name) {
    this.name = name;
    this.g = new THREE.Group();
    world.add(this.g);
    this.frame = frameMesh(RW + 0.012, RH + 0.012, {fill: 0x050505, border: 0x242424, renderOrder: 2, r: 0.03});
    this.frame.position.z = -0.002;
    // An opaque card just behind the (transparent) frame, inset clear of its rounded corners: drawn in the opaque pass,
    // it lets the depth test reject the town pixels behind the panel instead of shading them (shown only when settled).
    this.occ = new THREE.Mesh(new THREE.PlaneGeometry(RW + 0.012 - 0.018, RH + 0.012 - 0.018), new THREE.MeshBasicMaterial({color: 0x050505, toneMapped: false}));
    this.occ.position.z = -0.003; this.occ.name = 'reader-occluder'; this.occ.renderOrder = -10; // before the town in the opaque pass
    this.header = new Panel(`${name}:header`, {w: RW, h: R.headerH, ppm: R.ppm, anchorY: 1, draw: V.drawHeader, renderOrder: 5});
    this.header.reader = this;
    this.header.mesh.position.set(0, TOP, 0.001);
    this.view = new THREE.Group();
    this.view.position.set(TURN_X, STREAM_TOP, 0.001);
    this.strip = new Panel(`${name}:strip`, {w: R.gutter, h: R.streamH, ppm: V.STRIP.ppm, anchorY: 1, draw: V.drawStrip, renderOrder: 5});
    this.strip.reader = this;
    this.strip.mesh.position.set(RW / 2 - R.gutter / 2, STREAM_TOP, 0.003);
    this.ind = frameMesh(0.03, 0.05, {fill: 0xffffff, fillA: 0.16, border: 0xe5e5e5, borderA: 0.75, bw: 0.002, r: 0.012, glowW: 0.01, renderOrder: 6});
    this.ind.position.z = 0.004;
    const fade = new THREE.Mesh(fadeGeo(RW - R.gutter, 0.045, STREAM_TOP, STREAM_BOT), fadeMat()); fade.renderOrder = 4; fade.position.set(TURN_X, 0, 0.0025);
    this.fades = [fade];
    this.pill = new Panel(`${name}:pill`, {w: V.PILL.w, h: V.PILL.h, ppm: V.PILL.ppm, draw: V.drawPill, renderOrder: 7});
    this.pill.reader = this;
    this.pill.mesh.position.set(TURN_X + (RW - R.gutter) / 2, STREAM_BOT + 0.09, 0.006);
    this.pill.mesh.visible = false;
    this.frameGeo = {full: this.frame.geometry, ring: frameRingGeo(this.frame, 0.014, 0.07), thin: frameRingGeo(this.frame, 0.014, 0.004)};
    // Hit-testing always uses the whole quad (a ray into the panel's middle must still land on the panel).
    this.frame.raycast = (rc, out) => { const g = this.frame.geometry; this.frame.geometry = this.frameGeo.full; THREE.Mesh.prototype.raycast.call(this.frame, rc, out); this.frame.geometry = g; };
    this.g.add(this.occ, this.frame, this.header.mesh, this.view, this.strip.mesh, this.ind, ...this.fades, this.pill.mesh);
    this.clip = [new THREE.Plane(), new THREE.Plane()];
    this.sid = null; this.set = null;
    this.scroll = 0; this.vel = 0; this.anim = null; this.drag = false; this.scrubbing = false;
    this.turnIdx = 0; this.newOutput = false; this.alpha = 1;
  }
  get maxScroll() { return Math.max(0, (this.set?.height || 0) - VIEW_PX); }
  get dest() { return this.anim ? this.anim.to : this.scroll; }
  attachClip(set) { for (const t of set.turns) t.panel.mat.clippingPlanes = this.clip; }
  setSession(sid) {
    if (this.set && this.set.reader === this) { this.set.reader = null; this.view.remove(this.set.group); }
    this.sid = sid;
    this.set = setFor(sid);
    if (this.set.reader && this.set.reader !== this) { this.set.reader.view.remove(this.set.group); this.set.reader.set = null; this.set.reader.sid = null; }
    this.set.reader = this;
    this.view.add(this.set.group);
    this.attachClip(this.set);
    for (const t of this.set.turns) t.panel.update(true);
    this.anim = null; this.vel = 0; this.newOutput = false;
    this.scroll = this.landing();
    this.header.invalidate(); this.strip.invalidate();
  }
  landing() {
    const s = get(this.sid), set = this.set;
    if (set.markY != null) return clamp(set.markY - 24, 0, this.maxScroll);
    if (s.savedScroll != null) return clamp(s.savedScroll, 0, this.maxScroll);
    return set.turns.length ? clamp(set.snapPos(set.turns.length - 1), 0, this.maxScroll) : 0;
  }
  to(y, ms = 260) {
    y = clamp(y, 0, this.maxScroll);
    this.vel = 0;
    if (S.reduceMotion || ms === 0) { this.anim = null; this.scroll = y; return; }
    this.anim = {from: this.scroll, to: y, t0: animMs(), dur: ms};
  }
  stepTurn(dir) {
    const set = this.set;
    if (!set?.turns.length) return;
    const cur = this.dest;
    if (dir > 0) {
      const i = set.turns.findIndex((t, k) => set.snapPos(k) > cur + 4);
      if (i >= 0 && set.snapPos(i) <= this.maxScroll) this.to(set.snapPos(i)); else this.to(this.maxScroll);
    } else {
      let i = -1;
      for (let k = set.turns.length - 1; k >= 0; k--) if (set.snapPos(k) < cur - 4) { i = k; break; }
      this.to(i >= 0 ? set.snapPos(i) : 0);
    }
  }
  /** Strip fraction f (0..1, top to bottom) <-> content position. Turns are evenly spaced on the strip. */
  posAtF(f, snap) {
    const set = this.set, n = set.turns.length;
    const x = clamp(f, 0, 0.99999) * n, i = Math.floor(x), g = x - i;
    if (snap) return set.snapPos(i);
    return set.turns[i].top + g * set.turns[i].h - SNAP_MARGIN;
  }
  fAtPos(y) {
    const set = this.set, n = set.turns.length;
    if (!n) return 0;
    y += SNAP_MARGIN;
    let i = 0;
    while (i < n - 1 && set.turns[i + 1].top <= y) i++;
    const t = set.turns[i];
    return (i + clamp((y - t.top) / Math.max(1, t.h + TURN_GAP), 0, 1)) / n;
  }
  relayout() {
    const atBottom = this.dest >= this.maxScroll - 30 || this.follow;
    this.set.build();
    for (const t of this.set.turns) t.panel.update(true);
    if (atBottom) { this.to(this.maxScroll, 300); this.follow = false; } else if (this.maxScroll > this.dest + 30) this.newOutput = true;
    this.strip.invalidate(); this.header.invalidate();
  }
  tick(dt) {
    if (!this.set) return;
    const max = this.maxScroll;
    if (this.anim) {
      const u = clamp((animMs() - this.anim.t0) / this.anim.dur, 0, 1);
      this.scroll = this.anim.from + (this.anim.to - this.anim.from) * easeOut(u);
      if (u >= 1) { this.scroll = this.anim.to; this.anim = null; }
    } else if (!this.drag && Math.abs(this.vel) > 0) {
      this.scroll += this.vel * dt;
      this.vel *= Math.exp(-dt / 0.33);
      if (this.scroll < 0 || this.scroll > max) { this.scroll = clamp(this.scroll, 0, max); this.vel = 0; }
      if (Math.abs(this.vel) < 6) this.vel = 0;
    }
    this.scroll = clamp(this.scroll, 0, max);
    if (this.scroll >= max - 8) this.newOutput = false;
    this.view.position.y = STREAM_TOP + this.scroll / PPM;
    // Cull turns outside the viewport (no redraw: visibility only).
    for (const t of this.set.turns) {
      const vis = t.top + t.h > this.scroll - 40 && t.top < this.scroll + VIEW_PX + 40;
      t.panel.mesh.visible = vis;
    }
    // Current turn index for the header.
    let ti = 0;
    const probe = this.scroll >= max - 4 && max > 0 ? this.scroll + VIEW_PX * 0.45 : this.scroll + 60;
    for (let i = 0; i < this.set.turns.length; i++) if (this.set.turns[i].top - SNAP_MARGIN <= probe) ti = i;
    if (ti !== this.turnIdx) { this.turnIdx = ti; this.header.invalidate(); }
    // Strip position bar.
    const f0 = this.fAtPos(this.scroll), f1 = this.fAtPos(this.scroll + VIEW_PX - SNAP_MARGIN);
    const yOf = (f) => STREAM_TOP - (14 + f * (V.STRIP.ppm * R.streamH - 28)) / V.STRIP.ppm;
    const ya = yOf(f0), yb = yOf(Math.max(f1, f0 + 0.02));
    setFrameSize(this.ind, 0.03, Math.max(0.02, ya - yb));
    this.ind.position.set(RW / 2 - R.gutter + (V.STRIP.ppm * R.gutter / 2 + 18) / V.STRIP.ppm, (ya + yb) / 2, 0.004);
    this.pill.mesh.visible = this.newOutput && this.alpha > 0.5;
  }
  updateClip() {
    this.g.updateMatrixWorld(true);
    this.clip[0].set(new THREE.Vector3(0, -1, 0), STREAM_TOP).applyMatrix4(this.g.matrixWorld);
    this.clip[1].set(new THREE.Vector3(0, 1, 0), -STREAM_BOT).applyMatrix4(this.g.matrixWorld);
  }
  /** Settled in front of its card: draw only the frame's border band (plus the glow margin while it glows). */
  syncFrameGeo() {
    const g = !this.occ.visible ? this.frameGeo.full : this.frame.material.uniforms.uGlowA.value > 0.001 ? this.frameGeo.ring : this.frameGeo.thin;
    if (this.frame.geometry !== g) this.frame.geometry = g;
  }
  setAlpha(a) {
    this.alpha = a;
    this.g.visible = a > 0.01;
    this.occ.visible = a > 0.985;
    this.syncFrameGeo();
    const op = a;
    this.frame.material.uniforms.uOpacity.value = op;
    this.ind.material.uniforms.uOpacity.value = op;
    for (const f of this.fades) f.material.uniforms.uOpacity.value = op;
    for (const p of [this.header, this.strip, this.pill]) p.mat.opacity = op;
    if (this.set?.reader === this) for (const t of this.set.turns) t.panel.mat.opacity = op;
  }
}
export const readers = [new Reader('rA'), new Reader('rB')];

