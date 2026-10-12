// Round 3, live tiles: the panels of a multi-session layout (pair, triptych, wall). Each tile shows one session (its
// header, status and what it needs, and the live tail of its conversation in pi-web's style) or one pinned artifact.
// A tile is one canvas texture, re-rastered only when what it shows changes, and at most 4 times a second unless it is
// the focused tile (which also carries the composer, and re-rasters at most about 7 times a second). Sized in degrees at FOCUS.D, with text at the focus panel's
// 1.2°. Its grab bar (the header, the whole width) moves it, its corner handle resizes it, its body refocuses it.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, indicator, statusText, unreadTurns, turnsOf} from './state.js';
import {C, MONO, font, fillRR, icon, text, ellipsize} from './draw.js';
import {drawAvatar} from './avatars.js';
import {layoutTurn, drawTurn, PPM} from './turns.js';
import {drawArtifact, KIND, contentOf} from './artifact-draw.js';
import {client} from './client.js';
import {FOCUS, DEG, nowMs} from './core.js';
import * as V from './views.js';

export const TILE = {headDeg: 3.0, cornerDeg: 5.0, unfocusedMs: 250, focusedMs: 150, settleMs: 600, composerDeg: 5.2, dens: 0.8};
/** Metres at the round 1 scale for an angular size at FOCUS.D (the tile is drawn at PPM and shown at FOCUS.S). */
export const eqOf = (deg) => (2 * FOCUS.D * Math.tan(deg * DEG / 2)) / FOCUS.S;
const pxOf = (deg) => Math.round(eqOf(deg) * PPM);
const scratch = document.createElement('canvas').getContext('2d');
const findArt = (id) => { const sid = id.split(':')[0]; return client.artifacts(sid).find((a) => a.id === id); };

let seq = 0;
export class Tile {
  constructor(handlers) {
    this.n = seq++; this.h = handlers; // {grab(tile), resize(tile), focus(tile), close(tile)} -> region drag/click handlers
    this.item = null; this.focused = false; this.wDeg = 0; this.hDeg = 0; this.panel = null;
    this.rasters = 0; this.uploads = 0; this.mipped = false; this.lastRaster = -1e9; this.sig = ''; this.scrollPx = 0; this.layouts = new Map();
    this.g = new THREE.Group(); this.g.name = `tile-${this.n}`;
  }
  get id() { return this.item ? `${this.item.kind}:${this.item.id}` : null; }
  /** (Re)build the canvas for a new angular size (only when the size really changes). */
  /** dens: canvas pixels per layout pixel (TILE.dens: 1 for the focused tile, less for the others, which are glanced
   * at rather than read closely; their rasters and uploads cost that much less). Regions stay in layout pixels. */
  setSize(wDeg, hDeg, dens = 1) {
    if (this.panel && Math.abs(wDeg - this.wDeg) < 0.5 && Math.abs(hDeg - this.hDeg) < 0.5 && dens === this.dens) return;
    this.wDeg = wDeg; this.hDeg = hDeg; this.dens = dens;
    this.panel?.dispose();
    const lw = Math.round(eqOf(wDeg) * PPM), lh = Math.round(eqOf(hDeg) * PPM); this.lw = lw; this.lh = lh;
    this.panel = new Panel(`tile:${this.n}`, {w: eqOf(wDeg), h: eqOf(hDeg), ppm: PPM, canvasW: Math.round(lw * dens), canvasH: Math.round(lh * dens), draw: (ctx, p) => { ctx.save(); ctx.setTransform(dens, 0, 0, dens, 0, 0); this.draw(ctx, p); ctx.restore(); }, renderOrder: 5, hoverRedraw: true});
    this.panel.toCanvas = (uv) => ({x: uv.x * lw, y: (1 - uv.y) * lh});
    this.panel.fromCanvas = (x, y) => ({u: x / lw, v: 1 - y / lh});
    this.panel.tile = this; this.panel.mesh.scale.setScalar(FOCUS.S);
    // Opaque (its canvas is fully painted; alphaTest trims the rounded corners): drawn in the opaque pass, front to
    // back, so the depth test rejects the city behind the tile instead of shading it and blending over it.
    this.panel.mat.transparent = false; this.panel.mat.alphaTest = 0.5; this.panel.mat.depthWrite = true; this.panel.mesh.renderOrder = 0;
    // Every raster goes through the throttle (the frame loop's update of a dirty panel too, e.g. after a hover).
    const raw = this.panel.update.bind(this.panel);
    this.panel.rawUpdate = raw; this.panel.update = () => (this.panel.dirty ? this.update() : false);
    this.g.add(this.panel.mesh);
    this.sig = ''; this.layouts.clear();
  }
  setItem(item, focused) { if (this.item?.kind !== item?.kind || this.item?.id !== item?.id) { this.item = item; this.sig = ''; this.scrollPx = 0; this.layouts.clear(); } this.focused = focused; }
  setMips(on) { const x = this.panel.tex; if (x.generateMipmaps === on) return; x.generateMipmaps = on; x.minFilter = on ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; }
  /** What the tile shows, as a signature: a change re-rasters it (throttled). */
  signature() {
    const it = this.item; if (!it) return '';
    if (it.kind === 'artifact') { const a = findArt(it.id); return `${it.id}|${a?.kind === 'video' ? Math.floor(nowMs() / 250) : 0}|${this.focused}|${a ? contentOf(a, false)?.state : ''}`; }
    const s = get(it.id); if (!s) return '';
    const m = s.messages[s.messages.length - 1];
    return `${it.id}|${indicator(s)}|${s.messages.length}|${m?.html?.length || 0}|${m?.status || ''}|${m?.streaming ? 1 : 0}|${this.focused}|${this.scrollPx}|${S.composer.text.length}|${S.composer.dictating}|${unreadTurns(s)}`;
  }
  /** Raster if changed: the focused tile at once, the others at most every TILE.unfocusedMs. */
  update(force = false) {
    if (!this.panel || !this.item) return false;
    const sig = this.signature(), t = nowMs();
    // While a tile's content changes it uploads only the full-size level (generating mipmaps on every raster is the
    // costly part); once it has been still for TILE.settleMs, one more upload builds the mipmaps for crisp text.
    if (sig === this.sig && !this.panel.dirty && !force) {
      if (!this.mipped && t - this.lastRaster > TILE.settleMs) { this.mipped = true; this.setMips(true); this.panel.tex.needsUpdate = true; this.uploads++; }
      return false;
    }
    if (!force && t - this.lastRaster < (this.focused ? TILE.focusedMs : TILE.unfocusedMs)) return false;
    this.sig = sig; this.lastRaster = t; this.rasters++; this.uploads++;
    this.mipped = false; this.setMips(false);
    this.panel.dirty = true; this.panel.rawUpdate(true);
    return true;
  }
  draw(ctx, p) {
    const W = this.lw, H = this.lh, it = this.item, f = this.focused, hh = pxOf(TILE.headDeg), n = this.n;
    const k = it.kind === 'session' ? indicator(get(it.id)) : 'idle';
    fillRR(ctx, 3, 3, W - 6, H - 6, 26, '#060606', f ? '#e2b15f' : k === 'unread' || k === 'asking' ? 'rgba(226,177,95,0.55)' : k === 'error' ? C.danger : '#2a2a2a', f ? 5 : 3);
    // The grab bar: the header across the whole width (drag it to move the tile).
    fillRR(ctx, 6, 6, W - 12, hh - 6, 22, p.isHover(`tile:grab:${n}`) ? '#1c1c1c' : '#121212');
    icon(ctx, 'grip-horizontal', 40, hh / 2 + 2, 30, C.dim, 2.4);
    const hy = hh / 2 + 3;
    if (it.kind === 'session') {
      const s = get(it.id);
      drawAvatar(ctx, s.id, 96, hy, hh * 0.32);
      ctx.font = font(30, 700); text(ctx, ellipsize(ctx, s.title, W * 0.5), 136, hy - 14, {size: 30, weight: 700});
      const need = k === 'unread' ? `${unreadTurns(s)} unread · needs you` : k === 'asking' ? 'asking you · needs you' : k === 'error' ? 'error · needs you' : null;
      text(ctx, ellipsize(ctx, need || statusText(s), W * 0.5), 136, hy + 20, {size: 23, weight: 700, color: need ? (k === 'error' ? C.danger : C.accent) : k === 'running' ? C.accent : C.dim});
      if (f) text(ctx, 'FOCUSED', W - 150, hy, {size: 20, weight: 800, color: C.accent, align: 'right'});
    } else {
      const a = findArt(it.id), K = KIND[a?.kind] || KIND.image;
      icon(ctx, K.icon, 96, hy, 34, K.color, 2.4);
      ctx.font = font(30, 700); text(ctx, ellipsize(ctx, a?.name || it.id, W * 0.55), 130, hy - 14, {size: 30, weight: 700});
      text(ctx, `${K.label} · ${get(a?.sessionId)?.title || ''} · turn ${a?.turn}`, 130, hy + 20, {size: 22, color: C.dim});
    }
    // Close (unpin from the layout).
    const cx = W - 60, cs = hh - 24;
    fillRR(ctx, cx - cs / 2, 12, cs, cs, 14, p.isHover(`tile:close:${n}`) ? '#2a2a2a' : '#181818', '#2c2c2c', 2);
    icon(ctx, 'x', cx, 12 + cs / 2, 30, C.muted, 2.6);
    p.region(`tile:grab:${n}`, 0, 0, W - 110, hh, {drag: this.h.grab(this), click: () => this.h.focus(this)});
    p.region(`tile:close:${n}`, cx - cs / 2 - 6, 6, cs + 12, cs + 12, {click: () => this.h.close(this)});
    // The body: the live tail (or the artifact); selecting it refocuses this tile.
    const by = hh + 8, bh = H - by - 10 - (f && it.kind === 'session' ? pxOf(TILE.composerDeg) : 0);
    p.region(`tile:body:${n}`, 0, by, W, bh, {under: true, click: () => this.h.focus(this), scroll: true});
    ctx.save(); ctx.beginPath(); ctx.rect(8, by, W - 16, bh); ctx.clip();
    if (it.kind === 'session') this.drawTail(ctx, get(it.id), by, bh, W);
    else { const a = findArt(it.id); if (a) { ctx.translate(14, by + 6); drawArtifact(ctx, a, W - 28, bh - 12, nowMs() / 1000); } }
    ctx.restore();
    if (f && it.kind === 'session') this.drawComposer(ctx, p, H - 10 - pxOf(TILE.composerDeg), W);
    // The corner handle: drag to resize.
    const cz = pxOf(TILE.cornerDeg);
    icon(ctx, 'move-diagonal-2', W - cz / 2, H - cz / 2, 34, p.isHover(`tile:resize:${n}`) ? C.accent : C.dim, 2.4);
    p.region(`tile:resize:${n}`, W - cz, H - cz, cz, cz, {drag: this.h.resize(this)});
  }
  /** The tail of the conversation, bottom-anchored (or from "New since you looked" when it needs you). */
  drawTail(ctx, s, by, bh, W) {
    const ts = turnsOf(s), tw = W - 16, mark = s.id === S.currentId ? s.newMark : s.seenCount < s.messages.length ? s.seenCount : null;
    const items = []; let total = 0;
    for (let i = ts.length - 1; i >= 0 && total < bh + this.scrollPx + 200; i--) {
      const t = ts[i], key = `${i}|${t.end}|${s.messages[t.end - 1]?.html?.length || 0}|${s.messages[t.end - 1]?.status || ''}|${mark}`;
      let lay = this.layouts.get(i);
      if (!lay || lay.key !== key) { lay = {key, l: layoutTurn(scratch, s, t, {index: i, expanded: new Set(), newMark: mark, width: tw})}; this.layouts.set(i, lay); }
      items.unshift(lay.l); total += lay.l.h + 18;
    }
    let y = by + bh + this.scrollPx - total;
    // drawTurn clears its own canvas first; on a tile it must paint over the tile's background instead.
    const clear = ctx.clearRect; ctx.clearRect = () => {};
    for (const l of items) { if (y + l.h > by && y < by + bh) { ctx.save(); ctx.translate(8, y); ctx.beginPath(); ctx.rect(0, 0, tw, l.h); ctx.clip(); drawTurn(ctx, l, tw); ctx.restore(); } y += l.h + 18; }
    ctx.clearRect = clear;
    this.maxScroll = Math.max(0, total - bh);
  }
  /** The focused tile's composer strip: the draft, dictation and send (the composer column's actions). */
  drawComposer(ctx, p, y, W) {
    const h = pxOf(TILE.composerDeg) - 8, c = S.composer, bw = h * 1.4;
    fillRR(ctx, 12, y, W - 24 - 2 * (bw + 12), h, 22, '#0f0f0f', c.focused ? 'rgba(226,177,95,0.6)' : '#242424', 3);
    text(ctx, c.text || (c.dictating ? 'Listening…' : 'Ask pi…'), 40, y + h / 2, {size: 30, color: c.text ? C.text : C.dim});
    p.region('composer:input', 12, y, W - 24 - 2 * (bw + 12), h, {click: () => V.UI.focusComposer()});
    const mx = W - 12 - 2 * bw - 12, sx = W - 12 - bw;
    fillRR(ctx, mx, y, bw, h, 22, c.dictating ? 'rgba(251,113,133,0.22)' : '#1a1a1a', '#2c2c2c', 2); icon(ctx, 'mic', mx + bw / 2, y + h / 2, 44, c.dictating ? C.danger : C.text, 2.6);
    p.region('composer:mic', mx, y, bw, h, {click: () => V.UI.toggleDictation()});
    fillRR(ctx, sx, y, bw, h, 22, c.text ? C.accent : '#1a1a1a', '#2c2c2c', 2); icon(ctx, 'arrow-up', sx + bw / 2, y + h / 2, 44, c.text ? '#111' : C.dim, 3);
    p.region('composer:send', sx, y, bw, h, {click: () => V.UI.send()});
  }
  dispose() { this.panel?.dispose(); this.g.parent?.remove(this.g); }
}
export {MONO};
