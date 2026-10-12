// What pops up from the bar: the hover card (a pi-web card above the avatar you point at: its title, status, and a
// whole sentence of at least 80 characters from its latest reply, the unread one when it needs you) and the More menu
// (settings, back to the 2D app, scrolling the row). Both live in the bar's group, so they follow it.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, indicator, statusText, unreadTurns} from './state.js';
import {C, SANS, font, fillRR, icon, text, ellipsize} from './draw.js';
import {drawAvatar} from './avatars.js';
import {previewText, wrapWhole} from './city-text.js';
import {BAR, UIB, PAGE, cellOf} from './bar.js';
import {currentToolName} from './bar.js';

// D: a little behind the bar's surface, so a ray coming down from a raised hand to an avatar meets the bar first.
export const PREVIEW = {w: 0.46, h: 0.15, ppm: 2000, TEXT_PX: 28, D: 0.98};
function drawPreview(ctx, p) {
  const id = p.sid, s = get(id); if (!s) return;
  const W = p.cw, H = p.ch, k = indicator(s);
  fillRR(ctx, 3, 3, W - 6, H - 6, 22, '#0b0b0b', '#e2b15f', 4);
  drawAvatar(ctx, id, 52, 52, 30);
  text(ctx, s.title, 96, 40, {size: 30, weight: 700, maxW: W - 120});
  const need = k === 'unread' || k === 'asking';
  const st = k === 'asking' ? 'Asking you a question' : need ? `${statusText(s)} · ${unreadTurns(s)} unread turn${unreadTurns(s) > 1 ? 's' : ''}`
    : k === 'running' ? `${statusText(s)} · ${currentToolName(s)}` : statusText(s);
  text(ctx, st, 96, 74, {size: 22, weight: 700, color: C.accent, maxW: W - 120});
  ctx.font = font(PREVIEW.TEXT_PX, 400, SANS);
  const body = previewText(s) || [...s.messages].reverse().find((m) => m.type === 'user')?.text || 'No messages yet.';
  const w = wrapWhole(ctx, body, W - 64, 3);
  ctx.fillStyle = '#e8e8e8'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  w.lines.forEach((ln, i) => ctx.fillText(ln, 32, 122 + i * 38));
  p.drawn = {sid: id, state: k, text: w.lines.join(' '), chars: w.shown, total: w.total, lines: w.lines.length, cut: w.cut};
  // Two actions along the bottom: open (the main one), and fly to its place in the city.
  const by = H - 52;
  for (const [i, b] of [{id: 'pv:open', label: 'Open', ic: 'chevron-right', click: () => UIB.choose(id)}, {id: 'pv:fly', label: 'Fly to', ic: 'locate-fixed', click: () => UIB.flyToSession(id)}].entries()) {
    const x = W - 32 - (2 - i) * 170 + (i ? 10 : 0), hov = p.isHover(b.id);
    fillRR(ctx, x, by - 22, 160, 44, 22, hov ? '#2a2a2a' : '#181818', i === 0 ? 'rgba(226,177,95,0.7)' : '#333', 2);
    icon(ctx, b.ic, x + 26, by, 22, C.accent, 2.6);
    text(ctx, b.label, x + 46, by + 1, {size: 22, weight: 700});
    p.region(b.id, x, by - 26, 160, 52, {click: b.click});
  }
  p.region('pv:card', 0, 0, W, H - 60, {under: true, click: () => UIB.choose(id)});
}

export const MENU = {w: 0.52, h: 0.44, ppm: 1600};
function drawMenu(ctx, p) {
  const W = p.cw, H = p.ch, rows = 4, rh = (H - 24) / rows, cw = (W - 24) / 2;
  fillRR(ctx, 3, 3, W - 6, H - 6, 22, 'rgba(10,10,10,0.96)', '#2c2c2c', 3);
  const pg = S.pinned.length > PAGE, st = UIB.start?.() || 0, range = `showing ${st + 1}–${Math.min(S.pinned.length, st + PAGE)} of ${S.pinned.length}`;
  const items = [
    {id: 'menu:motion', label: 'Reduce motion', sub: 'blink instead of fly', on: S.reduceMotion, click: () => UIB.setReduceMotion(!S.reduceMotion)},
    {id: 'menu:vignette', label: 'Vignette', sub: 'while flying or grabbing', on: S.vignette !== false, click: () => UIB.setVignette(S.vignette === false)},
    {id: 'menu:table', label: 'Tabletop', sub: 'god mode: city as a model', on: !!UIB.isTable?.(), click: () => UIB.toggleTable()},
    {id: 'menu:exit', label: 'Back to chat', sub: 'the normal pi-web view', click: () => UIB.exit()},
    ...(pg ? [{id: 'menu:prev', label: '◂ Scroll left', sub: range, click: () => UIB.turnPage(-1)},
      {id: 'menu:next', label: 'Scroll right ▸', sub: range, click: () => UIB.turnPage(1)}] : []),
  ];
  items.forEach((it, i) => {
    const x = 12 + (i % 2) * cw, y = 12 + Math.floor(i / 2) * rh, hov = it.click && p.isHover(it.id);
    fillRR(ctx, x + 6, y + 6, cw - 12, rh - 12, 18, hov ? '#222' : '#151515', '#2c2c2c', 2);
    text(ctx, it.label, x + 28, y + rh * 0.36, {size: 30, weight: 700, maxW: cw - (it.on != null ? 140 : 50)});
    ctx.font = font(22, 400, SANS); const sub = wrapWhole(ctx, it.sub, cw - 50, 1).lines[0] || ''; // whole words, never a cut word
    text(ctx, sub, x + 28, y + rh * 0.68, {size: 22, color: C.muted});
    if (it.on != null) { fillRR(ctx, x + cw - 110, y + rh * 0.36 - 20, 72, 40, 20, it.on ? C.accent : '#333'); ctx.beginPath(); ctx.arc(it.on ? x + cw - 58 : x + cw - 90, y + rh * 0.36, 15, 0, Math.PI * 2); ctx.fillStyle = it.on ? '#111' : '#bbb'; ctx.fill(); }
    p.region(it.id, x, y, cw, rh, it.click ? {click: it.click} : {});
  });
}

export class BarPops {
  constructor(bar) {
    this.bar = bar;
    this.preview = new Panel('preview', {w: PREVIEW.w, h: PREVIEW.h, ppm: PREVIEW.ppm, draw: drawPreview, renderOrder: 32, depthWrite: false});
    this.preview.mat.depthTest = false; this.preview.mesh.visible = false; this.preview.sid = null;
    this.menu = new Panel('menu', {w: MENU.w, h: MENU.h, ppm: MENU.ppm, draw: drawMenu, renderOrder: 32, depthWrite: false});
    this.menu.mat.depthTest = false; this.menu.mesh.visible = false;
    bar.g.add(this.preview.mesh, this.menu.mesh);
    bar.menuH = MENU.h; // the bar keeps labels and cards clear of the open menu
    this.sig = '';
  }
  /** Placed just above the bar, at the avatar (preview) or the chip column (menu), turned to face you. */
  place(panel, col, h) {
    // Just above the bar's top edge, over the cell, a little nearer than the bar; turned to face your eye.
    const u = (col + 0.5) / BAR.COLS, v = 1 + (h / 2 + 0.02) / this.bar.panel.h;
    const p = this.bar.panel.uvToLocal(u, v, new THREE.Vector3()).multiplyScalar(PREVIEW.D / BAR.D);
    panel.mesh.position.copy(p);
    if (this.bar.panel.flat) panel.mesh.rotation.set(0, 0, 0); // the desktop strip is flat: stay parallel to it
    else panel.mesh.lookAt(this.bar.g.localToWorld(new THREE.Vector3()));
  }
  update(hoverSid) {
    const s = hoverSid && get(hoverSid), k = s && indicator(s);
    const show = !!s && !this.bar.moreOpen;
    if (show) {
      const c = cellOf(hoverSid, this.bar.start);
      if (c) {
        const sig = `${hoverSid}|${k}|${s.messages.length}|${k === 'running' ? currentToolName(s) : ''}`;
        if (this.preview.sid !== hoverSid || this.pvSig !== sig) { this.preview.sid = hoverSid; this.pvSig = sig; this.preview.invalidate(); }
        this.place(this.preview, Math.min(BAR.COLS - 2.4, Math.max(1.9, c.col)), PREVIEW.h);
      }
      this.preview.mesh.visible = !!c;
    } else this.preview.mesh.visible = false;
    this.menu.mesh.visible = this.bar.moreOpen;
    if (this.menu.mesh.visible) this.place(this.menu, BAR.COLS - 2.2, MENU.h);
    const sig = `${S.reduceMotion}|${S.vignette}|${UIB.isTable?.()}|${UIB.start?.()}|${S.pinned.length}`;
    if (sig !== this.sig) { this.sig = sig; this.menu.invalidate(); }
    this.preview.update(); this.menu.update();
  }
}
export {ellipsize, THREE};
