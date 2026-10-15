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

export const RAIL = {perPage: 3};
export const rail = new Panel('rail', {w: COL.w, h: COL.railH, ppm: 1100, draw: drawRail, renderOrder: 5});
world.add(rail.mesh); rail.mesh.visible = false;
export const railState = {page: 0};
function drawRail(ctx, p) {
  const W = p.cw, H = p.ch, s = get(S.currentId), arts = s ? client.artifacts(s.id) : [];
  fillRR(ctx, 2, 2, W - 4, H - 4, 22, '#0b0b0b', '#262626', 2);
  const pages = Math.max(1, Math.ceil(arts.length / RAIL.perPage)); railState.page = Math.min(railState.page, pages - 1);
  text(ctx, 'ARTIFACTS', 22, 34, {size: 22, weight: 800, color: C.dim});
  text(ctx, arts.length ? `${arts.length}` : 'none yet', 150, 34, {size: 22, weight: 700, color: C.dim});
  if (pages > 1) for (const [d, ic, x] of [[-1, 'chevron-up', W - 96], [1, 'chevron-down', W - 40]]) {
    const id = `rail:page:${d}`; fillRR(ctx, x - 24, 12, 48, 44, 12, p.isHover(id) ? '#2a2a2a' : '#161616', '#2c2c2c', 1.5); icon(ctx, ic, x, 34, 28, C.text, 2.4);
    p.region(id, x - 28, 6, 56, 56, {click: () => { railState.page = (railState.page + d + pages) % pages; p.invalidate(); }});
  }
  const top = 66, ch = (H - top - 8) / RAIL.perPage;
  arts.slice(railState.page * RAIL.perPage, railState.page * RAIL.perPage + RAIL.perPage).forEach((a, i) => {
    const y = top + i * ch, id = `rail:art:${a.id}`, on = artState.art?.id === a.id || A.pedestal?.art?.id === a.id, hov = p.isHover(id), K = KIND[a.kind];
    fillRR(ctx, 10, y + 4, W - 20, ch - 8, 16, on ? '#1f1a10' : hov ? '#1a1a1a' : '#121212', on ? C.accent : '#2a2a2a', on ? 3 : 2);
    const tw = 128, th = ch - 36, tx = tw + 38;
    drawThumb(ctx, a, 22, y + 18, tw, th);
    ctx.font = font(24, 700);
    const w = wrapWhole(ctx, a.name, W - tx - 16, 2);
    w.lines.forEach((ln, k) => text(ctx, ln, tx, y + 36 + k * 28, {size: 24, weight: 700}));
    icon(ctx, K.icon, tx + 10, y + ch - 30, 22, K.color, 2.2);
    text(ctx, `${K.label} · turn ${a.turn}`, tx + 28, y + ch - 29, {size: 20, color: C.dim});
    p.region(id, 0, y, W - 66, ch, {click: () => A.r3?.pullOut(a), art: a.id});
    const pid = `rail:pin:${a.id}`, px = W - 40, py = y + ch - 32, pinned = A.r3?.isPinned(a.id);
    fillRR(ctx, px - 24, py - 22, 48, 44, 12, pinned ? '#2a2112' : p.isHover(pid) ? '#2a2a2a' : '#161616', pinned ? C.accent : '#2c2c2c', 1.5);
    icon(ctx, 'pin', px, py, 24, pinned ? C.accent : C.muted, 2.2);
    p.region(pid, px - 30, y + ch - 62, 60, 56, {click: () => A.r3?.pin(a)});
  });
}

// ------------------------------------------------------------------ a pulled-out artifact: its own large panel
/** Width (degrees) by kind: images and diagrams are large; reports are narrow; models go on the pedestal. */
export const WIDE = {image: 45, diagram: 45, html: 44, video: 42, diff: 40, markdown: 34, model: 30};
const HEAD = 0.07; // header height (metres at the round 1 scale)
export const artState = {art: null, panel: null, wDeg: 0, hDeg: 0, frames: 0};
function drawArtPanel(ctx, p) {
  const a = artState.art; if (!a) return;
  const W = p.cw, H = p.ch, hh = Math.round(HEAD * 1100), K = KIND[a.kind];
  fillRR(ctx, 2, 2, W - 4, H - 4, 24, '#060606', K.color === '#e8e8e8' ? '#3a3a3a' : 'rgba(226,177,95,0.7)', 3);
  icon(ctx, K.icon, 40, hh / 2 + 2, 30, K.color, 2.4);
  ctx.font = font(30, 700); text(ctx, ellipsize(ctx, a.name, W * 0.55), 72, hh / 2 - 10, {size: 30, weight: 700});
  text(ctx, `${K.label} · ${get(a.sessionId)?.title || ''} · turn ${a.turn} · ${(a.bytes / 1024).toFixed(1)} KB`, 72, hh / 2 + 20, {size: 21, color: C.dim});
  const btn = (id, ic, label, x, on, click) => { fillRR(ctx, x, 10, 150, hh - 20, 16, on ? '#2a2112' : p.isHover(id) ? '#2a2a2a' : '#161616', on ? C.accent : '#2c2c2c', 2); icon(ctx, ic, x + 30, hh / 2, 24, on ? C.accent : C.text, 2.4); text(ctx, label, x + 52, hh / 2 + 1, {size: 22, weight: 700}); p.region(id, x, 4, 150, hh - 8, {click}); };
  btn('art:pin', 'pin', 'Pin', W - 340, A.r3?.isPinned(a.id), () => A.r3?.pin(a));
  // pi-web: what WebGL cannot draw (HTML, audio, other files) opens in the 2D viewer instead.
  if (a.kind === 'html' || a.kind === 'audio' || a.kind === 'other') btn('art:2d', 'external-link', 'Open 2D', W - 500, false, () => host.openIn2D?.(a));
  btn('art:close', 'x', 'Close', W - 180, false, () => closeArtifact());
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
  const wDeg = WIDE[a.kind] || 40, wEq = eqOf(wDeg), hEq = Math.min(eqOf(40), wEq / aspectOf(a) + HEAD);
  artState.wDeg = wDeg; artState.hDeg = 2 * Math.atan(hEq * FOCUS.S / 2 / FOCUS.D) / DEG;
  artState.panel?.dispose();
  artState.panel = new Panel('artifact', {w: wEq, h: hEq, ppm: 1100, draw: drawArtPanel, renderOrder: 5});
  artState.panel.mesh.scale.setScalar(FOCUS.S); world.add(artState.panel.mesh);
  room.shiftTo = sideShift(wDeg);
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
/** The side slot beside the cockpit (yaw of its centre, degrees) for a width. */
export const sideSlotYaw = (wDeg) => ANG.totalW / 2 - room.shift + 1.5 + wDeg / 2;
let lastVideo = 0;
/** Each frame: place the pulled-out panel beside the cockpit (focus layout only); videos re-raster at 10 fps. */
export function tickArtifacts(show, alpha) {
  const p = artState.panel; if (!p) return;
  p.mesh.visible = show;
  if (!show) return;
  placeRel(p.mesh, sideSlotYaw(artState.wDeg), 0, FOCUS.D);
  p.mat.opacity = alpha;
  if (artState.art.kind === 'video' && nowMs() - lastVideo > 100) { lastVideo = nowMs(); p.invalidate(); }
}
// pi-web: real content arrives asynchronously; re-raster what shows it, and resize a pulled-out panel to the image's
// or video's real aspect.
onArtifactContent((a) => {
  rail.invalidate();
  if (artState.art?.id === a.id) { const w = artState.wDeg; pullOut(artState.art); if (artState.wDeg !== w) room.shiftTo = sideShift(artState.wDeg); }
});
export function syncRail() { const s = S.currentId; if (railState.sid !== s) { railState.sid = s; railState.page = 0; rail.invalidate(); } }
export {THREE};
