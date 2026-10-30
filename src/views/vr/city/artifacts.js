// Round 3, artifacts as spatial objects. The artifact rail is the cockpit's right column: one card per artifact the
// focused session produced (a thumbnail, its name, a kind badge, the turn that produced it, and a pin). Selecting a
// card pulls the artifact out into its own large panel beside the conversation, sized for its content (images and
// diagrams 45° wide); the cockpit steps aside (up to 15°) to make room. A 3D model goes onto the pedestal instead
// (pedestal.js). The pin puts the artifact on the wall (layouts.js), next to other sessions' artifacts.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get} from './state.js';
import {C, font, fillRR, icon, text, ellipsize} from './draw.js';
import {client} from './client.js';
import {drawArtifact, drawThumb, KIND, aspectOf, onArtifactContent} from './artifact-draw.js';
import {host} from './host.js';
import {COL, ANG, room, placeRel} from './focus.js';
import {wrapWhole} from './city-text.js';
import {A, world, FOCUS, DEG, nowMs} from './core.js';
import {eqOf} from './tiles.js';

// pi-web (usability round 1): the rail is the cockpit's full right column; every target is at least 3° (page arrows
// and pins were 1.9°): 4 cards a page, each with its thumbnail on top and an 88 px pin.
export const RAIL = {perPage: 4};
export const rail = new Panel('rail', {w: COL.w, h: COL.railH, ppm: 1100, draw: drawRail, renderOrder: 5});
world.add(rail.mesh); rail.mesh.visible = false;
export const railState = {page: 0};
function drawRail(ctx, p) {
  const W = p.cw, H = p.ch, s = get(S.currentId), arts = s ? client.artifacts(s.id) : [];
  fillRR(ctx, 2, 2, W - 4, H - 4, 22, '#0b0b0b', '#262626', 2);
  const pages = Math.max(1, Math.ceil(arts.length / RAIL.perPage)); railState.page = Math.min(railState.page, pages - 1);
  const B = 88, top = B + 20;
  // Page arrows and pins sit on the rail's inner (left) edge, nearer the middle of your view.
  const tx = pages > 1 ? 2 * B + 36 : 22;
  text(ctx, 'ARTIFACTS', tx, 36, {size: 26, weight: 800, color: C.dim, maxW: W - tx - 10});
  text(ctx, arts.length ? (pages > 1 ? `${railState.page + 1}/${pages}` : `${arts.length}`) : 'none yet', tx, 74, {size: 26, weight: 700, color: C.dim});
  if (pages > 1) for (const [d, ic, x] of [[-1, 'chevron-up', 10], [1, 'chevron-down', B + 22]]) {
    const id = `rail:page:${d}`; fillRR(ctx, x, 10, B, B, 16, p.isHover(id) ? '#2a2a2a' : '#161616', '#2c2c2c', 1.5); icon(ctx, ic, x + B / 2, 10 + B / 2, 40, C.text, 2.6);
    p.region(id, x - 4, 6, B + 8, B + 8, {click: () => { railState.page = (railState.page + d + pages) % pages; p.invalidate(); }});
  }
  const ch = (H - top - 8) / RAIL.perPage;
  arts.slice(railState.page * RAIL.perPage, railState.page * RAIL.perPage + RAIL.perPage).forEach((a, i) => {
    const y = top + i * ch, id = `rail:art:${a.id}`, on = artState.art?.id === a.id || A.pedestal?.art?.id === a.id, hov = p.isHover(id), K = KIND[a.kind] || KIND.other;
    fillRR(ctx, 10, y + 4, W - 20, ch - 8, 16, on ? '#1f1a10' : hov ? '#1a1a1a' : '#121212', on ? C.accent : '#2a2a2a', on ? 3 : 2);
    const th = ch - B - 40;
    drawThumb(ctx, a, 22, y + 16, W - 44, th);
    const lx = B + 34;
    ctx.font = font(28, 700);
    text(ctx, ellipsize(ctx, a.name, W - lx - 14), lx, y + th + 44, {size: 28, weight: 700});
    icon(ctx, K.icon, lx + 10, y + ch - 36, 24, K.color, 2.2);
    text(ctx, `${K.label} · ${a.turn}`, lx + 30, y + ch - 35, {size: 24, color: C.dim, maxW: W - lx - 44});
    p.region(id, B + 24, y, W - B - 24, ch, {click: () => A.r3?.pullOut(a), art: a.id});
    p.region(id, 0, y, W, th + 16, {click: () => A.r3?.pullOut(a), art: a.id}); // the thumbnail too (same target)
    const pid = `rail:pin:${a.id}`, px = 18, py = y + ch - B - 12, pinned = A.r3?.isPinned(a.id);
    fillRR(ctx, px, py, B, B, 16, pinned ? '#2a2112' : p.isHover(pid) ? '#2a2a2a' : '#161616', pinned ? C.accent : '#2c2c2c', 1.5);
    icon(ctx, 'pin', px + B / 2, py + B / 2, 36, pinned ? C.accent : C.muted, 2.4);
    p.region(pid, px - 6, py - 6, B + 12, B + 12, {click: () => A.r3?.pin(a)});
  });
}

// ------------------------------------------------------------------ a pulled-out artifact: its own large panel
/** Width (degrees) by kind: images and diagrams are large; reports are narrow; models go on the pedestal. */
// pi-web (usability round 1): an artifact opens over the conversation, at most 40° wide (it was beside it, up to 45°,
// pushing targets out to 70°); its header buttons are 3.4° tall.
export const WIDE = {image: 40, diagram: 40, html: 36, video: 38, diff: 36, markdown: 34, model: 30, audio: 34, other: 34};
const HEAD = 0.10; // header height (metres at the round 1 scale)
export const artState = {art: null, panel: null, wDeg: 0, hDeg: 0, frames: 0};
function drawArtPanel(ctx, p) {
  const a = artState.art; if (!a) return;
  const W = p.cw, H = p.ch, hh = Math.round(HEAD * 1100), K = KIND[a.kind] || KIND.other;
  fillRR(ctx, 2, 2, W - 4, H - 4, 24, '#060606', K.color === '#e8e8e8' ? '#3a3a3a' : 'rgba(226,177,95,0.7)', 3);
  const nb = a.kind === 'html' || a.kind === 'audio' || a.kind === 'other' ? 3 : 2, BW = 150, right = W - nb * (BW + 10) - 14;
  icon(ctx, K.icon, 40, hh / 2 + 2, 30, K.color, 2.4);
  ctx.font = font(30, 700); text(ctx, ellipsize(ctx, a.name, right - 90), 72, hh / 2 - 14, {size: 30, weight: 700});
  text(ctx, `${K.label} · turn ${a.turn} · ${(a.bytes / 1024).toFixed(1)} KB`, 72, hh / 2 + 20, {size: 26, color: C.dim, maxW: right - 90});
  const btn = (id, ic, label, x, on, click) => { fillRR(ctx, x, 8, BW, hh - 16, 16, on ? '#2a2112' : p.isHover(id) ? '#2a2a2a' : '#161616', on ? C.accent : '#2c2c2c', 2); icon(ctx, ic, x + 30, hh / 2, 26, on ? C.accent : C.text, 2.4); text(ctx, label, x + 52, hh / 2 + 1, {size: 22, weight: 700}); p.region(id, x, 4, 150, hh - 8, {click}); };
  btn('art:pin', 'pin', 'Pin', W - 2 * (BW + 10) - 4, A.r3?.isPinned(a.id), () => A.r3?.pin(a));
  // pi-web: what WebGL cannot draw (HTML, audio, other files) opens in the 2D viewer instead.
  if (nb === 3) btn('art:2d', 'external-link', 'Open 2D', W - 3 * (BW + 10) - 4, false, () => host.openIn2D?.(a));
  btn('art:close', 'x', 'Close', W - BW - 14, false, () => closeArtifact());
  ctx.save(); ctx.beginPath(); ctx.rect(10, hh, W - 20, H - hh - 10); ctx.clip(); ctx.translate(10, hh);
  drawArtifact(ctx, a, W - 20, H - hh - 10, nowMs() / 1000);
  ctx.restore();
  artState.frames++;
}
/** Pull an artifact out beside the conversation (a model goes onto the pedestal). Returns where it went. */
export function pullOut(a) {
  if (a.kind === 'model') { closeArtifact(); A.pedestal?.show(a); rail.invalidate(); return 'pedestal'; }
  A.pedestal?.hide();
  artState.art = a;
  const wDeg = WIDE[a.kind] || 36, wEq = eqOf(wDeg), hEq = Math.min(eqOf(ANG.readerH), wEq / aspectOf(a) + HEAD);
  artState.wDeg = wDeg; artState.hDeg = 2 * Math.atan(hEq * FOCUS.S / 2 / FOCUS.D) / DEG;
  artState.panel?.dispose();
  artState.panel = new Panel('artifact', {w: wEq, h: hEq, ppm: 1100, draw: drawArtPanel, renderOrder: 5});
  artState.panel.mesh.scale.setScalar(FOCUS.S); world.add(artState.panel.mesh);
  room.shiftTo = 0;
  rail.invalidate();
  return 'panel';
}
/** How far the cockpit steps left so the cockpit plus this width stays within ±75° (at most 15°). */
export const sideShift = (wDeg) => Math.max(0, Math.min(15, (ANG.totalW / 2 + 1.5 + wDeg) - 75));
export function closeArtifact() {
  if (!artState.art) return;
  artState.art = null; artState.panel?.dispose(); artState.panel = null;
  if (!A.pedestal?.art) room.shiftTo = 0;
  rail.invalidate();
}
/** Where a pulled-out artifact (or the pedestal) goes: over the conversation (pi-web, usability round 1). */
export const sideSlotYaw = () => -room.shift;
let lastVideo = 0;
/** Each frame: place the pulled-out panel beside the cockpit (focus layout only); videos re-raster at 10 fps. */
export function tickArtifacts(show, alpha) {
  const p = artState.panel; if (!p) return;
  p.mesh.visible = show;
  if (!show) return;
  placeRel(p.mesh, sideSlotYaw(artState.wDeg), 0, FOCUS.D * 0.97);
  p.mat.opacity = alpha;
  if (artState.art.kind === 'video' && nowMs() - lastVideo > 100) { lastVideo = nowMs(); p.invalidate(); }
}
// pi-web: real content arrives asynchronously; re-raster what shows it, and resize a pulled-out panel to the image's
// or video's real aspect.
onArtifactContent((a) => {
  rail.invalidate();
  if (artState.art?.id === a.id) pullOut(artState.art);
});
export function syncRail() { const s = S.currentId; if (railState.sid !== s) { railState.sid = s; railState.page = 0; rail.invalidate(); } }
export {THREE};
