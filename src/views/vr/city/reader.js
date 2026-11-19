// The reading panel (borrowed from vr-breeze and adapted): a header, a stream of turns (drawn in tiles, so
// scrolling never re-rasterises text), the turn strip, fades, and the "new output" pill.
import * as THREE from 'three';
import {Panel, panels} from './panel.js';
import {S, get, turnsOf} from './state.js';
import * as V from './views.js';
import {PPM, TURN_W, layoutTurn, layoutTurnSteps, drawTurn} from './turns.js';
import {world, renderer, frameMesh, frameRingGeo, setFrameSize, nowMs, animMs, clamp, easeOut, R, RW, RH, TOP, STREAM_TOP, STREAM_BOT} from './core.js';

export const VIEW_PX = Math.round(R.streamH * PPM);
export const TURN_GAP = 22, SNAP_MARGIN = 14;
export const TURN_X = -RW / 2 + 0.006;

// ------------------------------------------------------------------ turn sets: turns laid out once, drawn in tiles
// pi-web (usability round 1): a turn used to be ONE canvas capped at 4096 px, which cut long turns (the latest reply)
// and uploaded hundreds of MB per switch on real transcripts. Now every turn is laid out in full (cheap, no pixels),
// and drawn only where you can see it: in TILE.h-tall tiles (one texture each, so scrolling still never re-rasters a
// tile), for the visible window plus one screen above and below. Tiles off that window are released. Rastering is
// budgeted per frame (TILE.budget bytes, at least one tile, leaving room for the other panels' uploads), and the resident tile textures are capped (TILE.cap),
// least recently seen first. Tiles raster at TILE.raster texels per layout px: the text stays well above the
// headset's rendered pixel density (see the PR's legibility note).
export const TILE = {h: 1024, raster: 0.72, budget: 2.5e6, cap: 120e6, margin: 1, layMs: 2.5, urgentLayMs: 3.5, urgentMs: 3, frameMs: 5.5};
// pi-web (usability round 2): a panel that appears (a cold open) stays invisible until the text in view is drawn, and a
// far jump (the strip, the outline, a turn flick) waits at the old place until the new one is drawn, then cuts: for
// at most HOLD.ms, and at least HOLD.frames frames (which only matters where frames are slow, as in an emulator). The
// text in view of a held panel or jump is "urgent": it may use up to TILE.urgentMs of raster time in a frame, beyond the
// byte budget. Anything still undrawn after the hold shows grey placeholder lines, never an empty panel.
export const HOLD = {ms: 150, frames: 4};
let frameNo = 0;
export const frameCount = () => frameNo;
const scratch = document.createElement('canvas').getContext('2d');
export const sets = new Map(); // sid -> TurnSet
export const expandedBySid = new Map();
export const tileStats = {rasters: 0, bytes: 0, resident: 0, dropped: 0, frameBytes: 0, maxStep: 0, maxStepAt: null};
function turnKey(s, t, i, exp, mark) {
  const parts = [i, t.start, t.end, mark != null && mark >= t.start && mark < t.end ? mark : -1];
  for (let j = t.start; j < t.end; j++) { const m = s.messages[j]; parts.push(m.type[0] + (m.status || '') + (m.sum || '') + (m.src != null ? m.src.length : m.html?.length || m.text?.length || 0) + (m.streaming ? 's' : '') + (exp.has(j) ? 'x' : '')); }
  return parts.join('|');
}
const tileBytes = (t) => t.panel ? t.panel.cw * t.panel.ch * 4 * (t.panel.tex.generateMipmaps ? 1.34 : 1) : 0;
// Tile panels are pooled, not disposed: their materials stay alive, so three.js keeps the compiled shader program
// (disposing the last material of a kind released the program, and the next tile recompiled it: 150-250 ms frames on
// every switch). A pooled panel keeps its mesh and material; its texture and canvas memory are released.
const pool = [];
function poolPanel(p) {
  const i = panels.indexOf(p); if (i >= 0) panels.splice(i, 1);
  p.mesh.parent?.remove(p.mesh);
  p.tex.dispose(); p.canvas.width = p.canvas.height = 1;
  p.regions = []; p.hoverIds = new Set(); p.turn = null;
  if (pool.length < 96) pool.push(p); else { p.mesh.geometry.dispose(); p.mat.dispose(); }
}
function unpoolPanel(name, o) {
  const p = pool.pop();
  if (!p) return new Panel(name, o);
  p.name = name; p.w = o.w; p.h = o.h; p.cw = o.canvasW; p.ch = o.canvasH; p.drawFn = o.draw;
  p.canvas.width = p.cw; p.canvas.height = p.ch;
  p.tex.generateMipmaps = o.mipmaps !== false; p.tex.minFilter = p.tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  p.tex.needsUpdate = true;
  p.mesh.geometry.dispose(); p.u0 = 0; p.v0 = 0; p.mesh.geometry = p.geometry();
  p.mesh.visible = true; p.mat.opacity = 1; p.dirty = true;
  panels.push(p);
  return p;
}
/** A turn's height before it is laid out: about 46 characters per 52 px line, plus its chips and headings. */
function estimateTurn(s, t) {
  let h = 120;
  for (let j = t.start; j < t.end; j++) {
    const m = s.messages[j];
    if (m.type === 'tool' || m.type === 'edit' || m.type === 'thinking') { h += 78; continue; }
    const n = (m.type === 'assistant' ? (m.src != null ? m.src.length : (m.html || '').length * 0.8) : (m.text || '').length) || 0;
    h += 40 + Math.ceil(n / (m.type === 'user' ? 38 : 46)) * 52;
  }
  return h;
}
const dist = (tt, y) => (y >= tt.top && y <= tt.top + tt.h ? 0 : Math.min(Math.abs(y - tt.top), Math.abs(y - tt.top - tt.h)));
/** Draw the part of a turn's layout between y0 and y1 (layout px) into a tile canvas. */
function drawTurnRange(c, lay, w, y0, y1) {
  if (y0 === 0) { c.fillStyle = '#1c1c1c'; c.fillRect(48, 2, w - 96, 2); }
  for (const it of lay.items) if (it.y < y1 && it.y + it.h > y0) it.draw(c, it.y);
}
export class TurnSet {
  constructor(sid) {
    this.sid = sid; this.group = new THREE.Group(); this.turns = []; this.height = 0; this.markY = null; this.markF = null; this.lastUse = nowMs(); this.reader = null;
    this.expanded = expandedBySid.get(sid) || new Set(); expandedBySid.set(sid, this.expanded);
    this.build();
  }
  mark() { const s = get(this.sid); return s.id === S.currentId ? s.newMark : s.seenCount < s.messages.length ? s.seenCount : null; }
  /**
   * Keys, positions and the stream height. Turns whose content changed are queued for layout (layStep) and keep an
   * estimated height until then, so opening a long session never lays out everything in one frame.
   */
  build() {
    const s = get(this.sid);
    const ts = turnsOf(s), mark = this.mark();
    const next = [];
    ts.forEach((t, i) => {
      const key = turnKey(s, t, i, this.expanded, mark);
      let tt = this.turns[i];
      if (!tt) tt = {key: null, lay: null, h: estimateTurn(s, t), top: 0, replyY: null, markY: null, tiles: [], i};
      tt.start = t.start; tt.end = t.end;
      if (tt.key !== key) { tt.want = {key, t, mark}; if (!tt.lay) tt.h = estimateTurn(s, t); }
      next.push(tt);
    });
    for (let i = ts.length; i < this.turns.length; i++) this.releaseTurn(this.turns[i]);
    this.turns = next;
    this.place();
    this.stale = false;
  }
  /** Stack the turns (laid out or estimated) and position their tiles. */
  place() {
    let y = 8;
    for (const tt of this.turns) {
      tt.top = y;
      for (const tl of tt.tiles) if (tl.panel) tl.panel.mesh.position.set(0, -(y + tl.y0) / PPM, 0);
      y += tt.h + TURN_GAP;
    }
    this.height = y + 10;
    const mi = this.turns.findIndex((tt) => tt.markY != null);
    this.markY = mi >= 0 ? this.turns[mi].top + this.turns[mi].markY : null;
    this.markF = mi >= 0 ? (mi + this.turns[mi].markY / this.turns[mi].h) / this.turns.length : null;
    this.version = (this.version || 0) + 1;
  }
  /** Lay out these turns now (indices; missing ones are skipped). */
  layTurnsNow(idx) {
    const s = get(this.sid); let moved = false;
    for (const i of idx) { const tt = this.turns[i]; if (!tt?.want) continue; const w = tt.want; tt.want = null; Object.assign(tt, this.relayTurn(s, w.t, tt.i, w.mark, w.key, tt)); moved = true; }
    if (moved) this.place();
  }
  /** The turn holding the "new since you looked" mark, or -1. */
  markTurn() { const m = this.mark(); return m == null ? -1 : this.turns.findIndex((tt) => tt.start <= m && m < tt.end); }
  /** Turns still to lay out. */
  pending() { return this.turns.filter((tt) => tt.want); }
  /**
   * Lay out queued turns for up to `ms` milliseconds: the ones nearest stream position `focusY` first (what you are
   * about to see), at least one. Returns whether anything moved.
   */
  layStep(ms, focusY = Infinity) {
    const todo = this.pending();
    if (!todo.length) return false;
    const s = get(this.sid);
    todo.sort((a, b) => dist(a, focusY) - dist(b, focusY));
    const t0 = performance.now();
    let moved = false;
    for (const tt of todo) {
      // A turn's layout runs as a generator, message by message, and resumes next frame when the budget is spent.
      const w = tt.want;
      if (!tt.gen || tt.genKey !== w.key) { tt.genOpts = {index: tt.i, expanded: this.expanded, newMark: w.mark, width: TURN_W}; tt.gen = layoutTurnSteps(scratch, s, w.t, tt.genOpts); tt.genKey = w.key; }
      let ts = performance.now(), r = tt.gen.next();
      const step = () => { const d = performance.now() - ts; if (d > tileStats.maxStep) { tileStats.maxStep = d; tileStats.maxStepAt = `${this.sid.slice(0, 8)}:${tt.i}`; } ts = performance.now(); };
      step();
      while (!r.done && performance.now() - t0 < ms) { r = tt.gen.next(); step(); }
      if (!r.done) break;
      tt.want = null; tt.gen = null;
      Object.assign(tt, this.relayTurn(s, w.t, tt.i, w.mark, w.key, tt, r.value));
      moved = true;
      if (performance.now() - t0 > ms) break;
    }
    if (moved) this.place();
    return moved;
  }
  /** (Re)lay a turn. Its tiles keep their textures until they are re-rastered (no flash while a reply streams).
   * `lay` may be given (a layout finished over several frames by layStep). */
  relayTurn(s, t, i, mark, key, old, lay = layoutTurn(scratch, s, t, {index: i, expanded: this.expanded, newMark: mark, width: TURN_W})) {
    let live = false; for (let j = t.start; j < t.end; j++) if (s.messages[j].streaming || s.messages[j].status === 'running') live = true;
    const h = lay.h, n = Math.max(1, Math.ceil(h / TILE.h)), tiles = [];
    for (let k = 0; k < n; k++) {
      const y0 = k * TILE.h, th = Math.min(TILE.h, h - y0);
      // Heights round up to 64 px, so a streaming turn's last tile is re-created only every few lines.
      const ch = Math.max(64, Math.ceil(th / 64) * 64);
      const prev = old?.tiles[k];
      if (prev?.panel && prev.ch === ch) { prev.dirty = true; prev.live = live; tiles.push(prev); continue; }
      if (prev) this.releaseTile(prev);
      tiles.push({k, y0, ch, panel: null, dirty: true, live, seen: 0});
    }
    if (old) for (const tl of old.tiles.slice(n)) this.releaseTile(tl);
    return {key, lay, h, top: old?.top || 0, replyY: lay.replyY, markY: lay.markY, tiles, i, want: null};
  }
  releaseTile(tl) { if (tl.panel) { tileStats.resident -= tileBytes(tl); poolPanel(tl.panel); tl.panel = null; tileStats.dropped++; } tl.dirty = true; }
  releaseTurn(tt) { for (const tl of tt.tiles) this.releaseTile(tl); }
  releaseAll() { for (const tt of this.turns) this.releaseTurn(tt); }
  /** Raster (or re-raster) one tile; returns the bytes it uploads. */
  rasterTile(tt, tl) {
    const R_ = TILE.raster, sid = this.sid;
    if (!tl.panel) {
      const lay = () => tt.lay;
      const opts = {w: TURN_W / PPM, h: tl.ch / PPM, ppm: PPM, canvasW: Math.round(TURN_W * R_), canvasH: Math.round(tl.ch * R_), anchorX: 0, anchorY: 1, renderOrder: 3, hoverRedraw: false, mipmaps: !tl.live,
        draw: (ctx, p) => {
          ctx.save(); ctx.setTransform(R_, 0, 0, R_, 0, 0); ctx.translate(0, -tl.y0);
          drawTurnRange(ctx, lay(), TURN_W, tl.y0, tl.y0 + tl.ch);
          ctx.restore();
          for (const r of lay().regions) if (r.y < tl.y0 + tl.ch && r.y + r.h > tl.y0) p.region(`chip:${sid}:${r.msg}`, 0, r.y - tl.y0, TURN_W, r.h, {chip: r.msg, click: () => V.UI.toggleChip(sid, r.msg)});
        }};
      const panel = unpoolPanel(`turn:${sid}:${tt.i}:${tl.k}`, opts);
      panel.toCanvas = (uv) => ({x: uv.x * TURN_W, y: (1 - uv.y) * tl.ch});
      panel.fromCanvas = (x, y) => ({u: x / TURN_W, v: 1 - y / tl.ch});
      panel.isTurn = true; panel.turn = tt; panel.mat.depthWrite = false;
      panel.mesh.position.set(0, -(tt.top + tl.y0) / PPM, 0);
      if (this.reader) { panel.mat.clippingPlanes = this.reader.clip; panel.mat.opacity = this.reader.alpha; }
      this.group.add(panel.mesh);
      tl.panel = panel;
    } else {
      tileStats.resident -= tileBytes(tl);
      const mips = !tl.live; if (tl.panel.tex.generateMipmaps !== mips) { tl.panel.tex.generateMipmaps = mips; tl.panel.tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; }
    }
    tl.panel.dirty = true; tl.panel.update(true); tl.dirty = false;
    renderer.initTexture(tl.panel.tex); // upload now, inside this frame's budget (also for a prefetched set off-screen)
    const b = tileBytes(tl); tileStats.resident += b; tileStats.rasters++; tileStats.bytes += b;
    return b;
  }
  /** Tiles that intersect [y0, y1] (stream px), with whether they also intersect the viewport [v0, v1]. */
  *tilesIn(y0, y1) {
    for (const tt of this.turns) {
      if (!tt.lay || tt.top > y1 || tt.top + tt.h < y0) continue;
      for (const tl of tt.tiles) { const a = tt.top + tl.y0, b = a + tl.ch; if (b >= y0 && a <= y1) yield [tt, tl, a, b]; }
    }
  }
  /** The turn whose layout covers stream position y, and the tile there (for tests: is the text at y drawn?). */
  tileAt(y) { for (const [tt, tl] of this.tilesIn(y, y)) return {turn: tt.i, tile: tl.k, drawn: !!tl.panel && !tl.dirty}; return null; }
  snapPos(i) { return this.turns[i].top - SNAP_MARGIN; }
  dispose() { this.releaseAll(); this.turns = []; this.group.parent?.remove(this.group); sets.delete(this.sid); }
}
export function setFor(sid) {
  let set = sets.get(sid);
  if (!set) { set = new TurnSet(sid); sets.set(sid, set); }
  else if (set.stale) set.build();
  set.lastUse = nowMs();
  // Layouts are cheap to keep, tiles are not: sets beyond the readers' and the prefetched ones keep no tiles (tileStep).
  if (sets.size > 8) {
    const keep = new Set([S.currentId, ...readers.map((r) => r.sid), sid]);
    const old = [...sets.values()].filter((x) => !keep.has(x.sid)).sort((a, b) => a.lastUse - b.lastUse);
    while (sets.size > 8 && old.length) old.shift().dispose();
  }
  return set;
}
/** Stand-ins for the tile materials (with and without a reader's clipping planes), compiled up front and kept, so the
 * first tile of a kind never compiles its shader in the middle of a session switch. */
const warm = [];
export function shaderWarmup() {
  if (!warm.length) {
    for (const clip of [readers[0].clip, null]) for (const mipmaps of [true, false]) {
      const p = new Panel('turn-warmup', {w: 0.001, h: 0.001, ppm: PPM, canvasW: 4, canvasH: 4, renderOrder: 3, hoverRedraw: false, mipmaps, interactive: false, draw: () => {}});
      p.mat.depthWrite = false; if (clip) p.mat.clippingPlanes = clip;
      const i = panels.indexOf(p); if (i >= 0) panels.splice(i, 1);
      p.mesh.frustumCulled = false; warm.push(p.mesh);
    }
  }
  return warm;
}
/** Sessions whose landing screen should be ready before you flick to them (set by app.js). */
export const prefetch = {sids: []};
/**
 * Each frame: which tiles are wanted (the readers' visible windows first, then a screen above and below, then the
 * prefetched neighbours' landing screens), raster the most important within the per-frame budget, and release the rest.
 */
export function tileStep() {
  frameNo++;
  const t = nowMs(), wanted = [], keep = new Set();
  const want = (set, y0, y1, v0, v1, prio) => {
    for (const [tt, tl, a, b] of set.tilesIn(y0, y1)) {
      const vis = b >= v0 && a <= v1, pr = vis ? prio : prio + 1;
      keep.add(tl); tl.seen = t;
      if (!tl.panel || tl.dirty) wanted.push({set, tt, tl, pr, d: Math.abs(a - v0)});
    }
  };
  // Layout first, time-sliced: the readers' sets around what they show, then the prefetched ones.
  let layMs = TILE.layMs; const tl0 = performance.now();
  for (const r of readers) {
    if (!r.set || r.set.reader !== r || !r.set.pending().length) continue;
    const urgent = r.held() || !!r.jump;
    const t1 = performance.now(); r.layout(urgent ? Math.max(layMs, TILE.urgentLayMs) : layMs); layMs -= performance.now() - t1;
  }
  for (const sid of prefetch.sids) { const set = sets.get(sid); if (!set || set.reader || layMs <= 0) continue; const t1 = performance.now(); set.layStep(layMs, landingOf(set)); layMs -= performance.now() - t1; }
  for (const r of readers) {
    if (!r.set || r.set.reader !== r || (r.alpha < 0.01 && !(r.pose && r.pose.to.alpha > 0.5))) continue; // opening: its tiles count
    const v0 = r.scroll, v1 = r.scroll + VIEW_PX, m = VIEW_PX * TILE.margin;
    if (r.jump) { const j = r.jumpY(); want(r.set, j, j + VIEW_PX, j, j + VIEW_PX, -1); }
    want(r.set, v0 - m, v1 + m, v0, v1, r.held() ? -1 : 0);
  }
  for (const sid of prefetch.sids) {
    const set = sets.get(sid); if (!set || set.reader) continue;
    const y = landingOf(set);
    want(set, y, y + VIEW_PX, y, y + VIEW_PX, 2);
  }
  tileStats.layMs = +(performance.now() - tl0).toFixed(1);
  wanted.sort((a, b) => a.pr - b.pr || a.d - b.d);
  let used = 0, nr = 0;
  const tr0 = performance.now();
  for (const w of wanted) {
    // Within the byte budget and (pi-web, round 2) the frame's tile time (TILE.frameMs, layout included); the text in
    // view always gets at least one tile, and urgent text up to TILE.urgentMs of rastering.
    const over = used > 0 && (used + w.tl.ch * TURN_W * TILE.raster * TILE.raster * 4 * 1.34 > TILE.budget || performance.now() - tl0 > TILE.frameMs);
    // Urgent text may pass the byte budget, but (round 3) never the frame's tile time plus 2 ms: one cold open's frame
    // rastered two tiles after a long layout step (a 19-22 ms frame).
    if (over && !(w.pr < 0 && performance.now() - tr0 < TILE.urgentMs && performance.now() - tl0 < TILE.frameMs + 2)) break;
    if (!used && w.pr > 0 && performance.now() - tl0 > TILE.frameMs) break; // nothing in view is missing: wait
    used += w.set.rasterTile(w.tt, w.tl); nr++;
  }
  tileStats.frameBytes = used; tileStats.rasterMs = +(performance.now() - tr0).toFixed(1); tileStats.frameRasters = nr;
  for (const r of readers) if (r.jump) r.commitJump();
  // Release: every tile outside its set's window, then (if still over the cap) the least recently seen.
  const all = [];
  for (const set of sets.values()) for (const tt of set.turns) for (const tl of tt.tiles) if (tl.panel) { if (!keep.has(tl)) set.releaseTile(tl); else all.push([set, tl]); }
  if (tileStats.resident > TILE.cap) {
    all.sort((a, b) => a[1].seen - b[1].seen);
    for (const [set, tl] of all) { if (tileStats.resident <= TILE.cap) break; if (tl.seen === t && set.reader) continue; set.releaseTile(tl); }
  }
  // Show only the drawn tiles that intersect each reader's viewport; grey lines where nothing is drawn yet.
  for (const r of readers) {
    if (!r.set || r.set.reader !== r) { r.holes.count = 0; continue; }
    const v0 = r.scroll - 40, v1 = r.scroll + VIEW_PX + 40;
    let n = 0;
    for (const tt of r.set.turns) {
      if (tt.top > v1 || tt.top + tt.h < v0) { for (const tl of tt.tiles) if (tl.panel) tl.panel.mesh.visible = false; continue; }
      if (!tt.lay) { n = r.hole(n, tt.top, tt.h); continue; }
      for (const tl of tt.tiles) { const a = tt.top + tl.y0, vis = a + tl.ch > v0 && a < v1; if (tl.panel) tl.panel.mesh.visible = vis; else if (vis) n = r.hole(n, a, Math.min(tl.ch, tt.h - tl.y0)); }
    }
    r.holes.count = n; r.holes.instanceMatrix.needsUpdate = n > 0; r.holes.visible = n > 0;
  }
}
/** Grey placeholder lines (a procedural shader, so no texture to raster): one instance per undrawn piece of the stream. */
const holeMat = (clip) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false, clipping: true, clippingPlanes: clip,
  uniforms: {uOpacity: {value: 1}, uPPM: {value: PPM}, uW: {value: TURN_W}},
  vertexShader: `#include <clipping_planes_pars_vertex>
    varying vec2 vP; uniform float uPPM;
    void main() { vec4 lp = instanceMatrix * vec4(position, 1.0); vP = vec2(lp.x, -lp.y) * uPPM; vec4 mvPosition = modelViewMatrix * lp; gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`,
  fragmentShader: `#include <clipping_planes_pars_fragment>
    varying vec2 vP; uniform float uOpacity, uW;
    float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    void main() {
      #include <clipping_planes_fragment>
      float line = floor(vP.y / 52.0), f = fract(vP.y / 52.0), len = 0.45 + 0.5 * h(line);
      float on = step(0.32, f) * step(f, 0.68) * step(48.0, vP.x) * step(vP.x, 48.0 + len * (uW - 96.0));
      gl_FragColor = vec4(vec3(0.16), 0.9 * on * uOpacity);
    }`,
});
/** Where a reader would land in a set (the same rule as Reader.landing, without a reader). */
function landingOf(set) {
  const s = get(set.sid), max = Math.max(0, set.height - VIEW_PX);
  if (set.markY != null) return clamp(set.markY - 24, 0, max);
  if (s?.savedScroll != null) return clamp(s.savedScroll, 0, max);
  return set.turns.length ? clamp(set.snapPos(set.turns.length - 1), 0, max) : 0;
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
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0.5, -0.5, 0), holeMat(this.clip), 24);
    this.holes.count = 0; this.holes.renderOrder = 2; this.holes.frustumCulled = false; this.holes.name = `${name}:placeholders`; this.holes.visible = false;
    this.view.add(this.holes);
    this.jump = null;
    this.sid = null; this.set = null;
    this.scroll = 0; this.vel = 0; this.anim = null; this.drag = false; this.scrubbing = false;
    this.turnIdx = 0; this.newOutput = false; this.alpha = 1;
  }
  get maxScroll() { return Math.max(0, (this.set?.height || 0) - VIEW_PX); }
  get dest() { return this.jump ? this.jumpY() : this.anim ? this.anim.to : this.scroll; }
  /** Placeholder piece n at stream y..y+h (px); returns the next index. */
  hole(n, y, h) {
    if (n >= 24) return n;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, -y / PPM, -0.0005), new THREE.Quaternion(), new THREE.Vector3(TURN_W / PPM, Math.max(1, h) / PPM, 1));
    this.holes.setMatrixAt(n, m); return n + 1;
  }
  /** Is everything in the window at y (default: the view) laid out and drawn? */
  viewReady(y = this.scroll) {
    const set = this.set; if (!set) return true;
    const v1 = y + VIEW_PX;
    for (const tt of set.turns) {
      if (tt.top > v1 || tt.top + tt.h < y) continue;
      if (!tt.lay || tt.want) return false;
      for (const tl of tt.tiles) { const a = tt.top + tl.y0; if (a + tl.ch >= y && a <= v1 && (!tl.panel || tl.dirty)) return false; }
    }
    return true;
  }
  /** Appearing (a pose to visible, from invisible) and still held back until its text is drawn. */
  held() { const P = this.pose; return !!P && P.to.alpha > 0.5 && P.from.alpha < 0.05 && !P.go; }
  /** The target of a pending far jump, in stream px (a turn and an offset, so it follows re-layouts above it). */
  jumpY() { const j = this.jump, tt = this.set?.turns[j.turn]; return clamp(tt ? tt.top + j.off : j.y, 0, this.maxScroll); }
  commitJump() {
    const j = this.jump; if (!j) return;
    if (this.viewReady(this.jumpY()) || (animMs() - j.t0 >= HOLD.ms && frameNo - j.f0 >= HOLD.frames)) { this.scroll = this.jumpY(); this.jump = null; this.vel = 0; this.anim = null; }
  }
  attachClip(set) { for (const t of set.turns) for (const tl of t.tiles) if (tl.panel) tl.panel.mat.clippingPlanes = this.clip; }
  setSession(sid) {
    if (this.set && this.set.reader === this) { this.set.reader = null; this.view.remove(this.set.group); }
    this.sid = sid;
    this.set = setFor(sid);
    if (this.set.reader && this.set.reader !== this) { this.set.reader.view.remove(this.set.group); this.set.reader.set = null; this.set.reader.sid = null; }
    this.set.reader = this;
    this.view.add(this.set.group);
    this.attachClip(this.set);
    this.anim = null; this.vel = 0; this.newOutput = false; this.jump = null;
    // pi-web: lay out the turns you land on first (the "new since you looked" one, else the latest), within the
    // frame budget; the rest follow a few milliseconds a frame, with the view anchored to what you are reading.
    this.scroll = this.landing();
    const mt = this.set.markTurn(), lt = mt >= 0 ? mt : this.set.turns.length - 1;
    if (this.set.turns[lt]?.want) { this.layout(TILE.layMs); this.scroll = this.landing(); }
    this.header.invalidate(); this.strip.invalidate();
  }
  /** Time-sliced layout of the rest of the set, keeping the view (or its scroll target) on the same content. */
  layout(ms) {
    const set = this.set; if (!set) return;
    // The view (or its scroll target) stays on the same content; a pending jump keeps the current view anchored and
    // lays out around its destination first.
    const y = this.jump ? this.scroll : this.dest, ai = set.turns.findIndex((tt) => tt.top + tt.h + TURN_GAP > y);
    const anchor = ai >= 0 ? {i: ai, off: y - set.turns[ai].top} : null;
    const wasBottom = !this.jump && this.dest >= this.maxScroll - 2 && this.maxScroll > 0;
    if (!set.layStep(ms, this.dest + VIEW_PX / 2)) return;
    if (wasBottom && ai === set.turns.length - 1) { const d = this.maxScroll - this.dest; this.scroll += d; if (this.anim) { this.anim.from += d; this.anim.to += d; } }
    else if (anchor) { const d = set.turns[anchor.i].top + anchor.off - y; if (d) { this.scroll += d; if (this.anim) { this.anim.from += d; this.anim.to += d; } } }
    // The strip's ticks follow the real heights: redraw it when the layout is done, or at most every 400 ms meanwhile.
    if (!set.pending().length || nowMs() - (this.stripAt || 0) > 400) { this.stripAt = nowMs(); this.strip.invalidate(); }
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
    // A far jump (more than a screen and a half) waits for its destination to be drawn, then cuts to it.
    const set = this.set;
    if (set && ms > 0 && !S.reduceMotion && Math.abs(y - this.scroll) > VIEW_PX * 1.5 && !this.viewReady(y)) {
      let i = set.turns.findIndex((tt) => tt.top + tt.h + TURN_GAP > y); if (i < 0) i = set.turns.length - 1;
      this.anim = null; this.jump = {turn: i, off: y - (set.turns[i]?.top || 0), y, t0: animMs(), f0: frameNo};
      return;
    }
    this.jump = null;
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
      // pi-web (usability round 2): back means the turn before the one you are reading (the header's "Turn n"), so
      // two flicks are two turns back. It used to stop first at the start of the current turn.
      let i = -1;
      for (let k = set.turns.length - 1; k >= 0; k--) if (set.snapPos(k) < cur - 4) { i = k; break; }
      if (i >= 0 && i === this.turnIdx && i > 0) i -= 1;
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
    this.layout(TILE.layMs); // a streaming reply: its turn is laid out at once (it is what you are watching)
    this.attachClip(this.set);
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
    // Tiles: drawn, released and shown by tileStep (main.js), within the per-frame budget.
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
    const tip = this.tipOn();
    if (tip !== this.tipWas) { this.tipWas = tip; this.pill.invalidate(); }
    this.pill.mesh.visible = (this.newOutput || tip) && this.alpha > 0.5;
  }
  /** pi-web (usability round 2): the "jump faster" tip, once per session per visit, after HOLD_SCROLL_MS of stick scrolling
   * in a session longer than LONG_VIEWS screens. */
  noteStickScroll(ms) {
    if (!this.set || this.set.height < VIEW_PX * 8 || ms < 1200 || tipShown.has(this.sid)) return false;
    tipShown.add(this.sid); this.tipUntil = animMs() + 6000; return true;
  }
  tipOn() { return animMs() < (this.tipUntil || 0); }
  hideTip() { this.tipUntil = 0; }
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
    this.holes.material.uniforms.uOpacity.value = op;
    for (const p of [this.header, this.strip, this.pill]) p.mat.opacity = op;
    if (this.set?.reader === this) for (const t of this.set.turns) for (const tl of t.tiles) if (tl.panel) tl.panel.mat.opacity = op;
  }
}
const tipShown = new Set();
export const readers = [new Reader('rA'), new Reader('rB')];

