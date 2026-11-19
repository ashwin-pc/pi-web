// pi-web's own avatars (public/avatars/<id>/icon.png, served by pi-web). One per session, assigned deterministically by pinned order, cycling with a tint once there
// are more sessions than avatars.
import {S} from './state.js';

export const AVATAR_IDS = ['bun', 'cat', 'current-pi', 'deer', 'dragon', 'fox', 'hoodie', 'robot', 'wisp'].map((id) => ({id, url: `/avatars/${id}/icon.png`}));
const imgs = AVATAR_IDS.map(({id, url}) => { const im = new Image(); im.src = url; im.dataset.id = id; return im; });
export const avatarsReady = Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = r; im.onerror = r; }))));
const TINTS = [null, '#60a5fa', '#c084fc', '#4ade80', '#fb7185', '#22d3ee'];
const fixed = new Map();
/** {img, id, tint} for a session. Stable: the first time a session is seen it keeps its avatar. */
export function avatarOf(sid) {
  if (fixed.has(sid)) return fixed.get(sid);
  let i = S.pinned.indexOf(sid);
  if (i < 0) i = fixed.size + 50;
  const a = {img: imgs[i % imgs.length], id: AVATAR_IDS[i % imgs.length].id, tint: TINTS[Math.floor(i / imgs.length) % TINTS.length]};
  fixed.set(sid, a);
  return a;
}
/** Draw a session's avatar as a disc of radius r centred at (cx, cy). */
export function drawAvatar(ctx, sid, cx, cy, r, {dim = 0} = {}) {
  const a = avatarOf(sid);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = '#131313'; ctx.fill();
  ctx.clip();
  if (a.img.complete && a.img.naturalWidth) ctx.drawImage(a.img, cx - r * 1.08, cy - r * 1.1, r * 2.16, r * 2.16);
  if (a.tint) { ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = 0.32; ctx.fillStyle = a.tint; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
  if (dim) { ctx.fillStyle = `rgba(3,3,3,${dim})`; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
  ctx.restore();
}
