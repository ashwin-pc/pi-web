// The status bar: one compact, gently curved row of pi-web avatars for the pinned sessions, in a stable pinned order.
// Avatars never move or reorder when a status changes; only their rings, glows and badges do. Ten are visible at a
// time; the row scrolls (a flick to a session outside it, or More) and the More chip counts what is off the row.
// Titles show for the current session, and for the avatar you point at or look at. Body-locked with lazy follow in
// both yaw and pitch: it sits about 24° below where you are looking (clamped), re-centring only when your gaze moves
// well away, so it stays under the city you look at instead of over it. It comes with you when you fly.
// Every avatar cell is a 6.1° × 6.6° target.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {S, get, indicator, unreadTurns, waitingCount, fenceLine} from './state.js';
import {C, SANS, MONO, font, fillRR, icon, text, ellipsize} from './draw.js';
import {drawAvatar} from './avatars.js';
import {wrapWhole} from './city-text.js';
import {animMs, clamp, DEG} from './core.js';

const QB = new URLSearchParams(location.search);
export const BAR = {D: 0.95, CELL: 6.1, ROW: 6.6, COLS: 12, ROWS: 1, VIS: 10, ELEV: -26.5, FOLLOW: 35, PPM: 2100, TITLE_DEG: 0.82, STATUS_DEG: 0.72,
  BELOW: +(QB.get('barbelow') || 24), CITY_GAZE: +(QB.get('barcity') || 26), PITCH_FOLLOW: 12, ELEV_MIN: -70, ELEV_MAX: -16};
const M_PER_DEG = BAR.D * DEG;
const CELL_M = BAR.CELL * M_PER_DEG, ROW_M = BAR.ROW * M_PER_DEG, PAD_M = 0.004;
export const PAGE = BAR.VIS; // avatars visible at once (the row scrolls past them)
const px = (deg) => deg * M_PER_DEG * BAR.PPM;
export const UIB = {};

/** The row shows PAGE pinned sessions from `start`; it scrolls only on a user action (moving to a session outside it,
 * or scrolling from More), never on a status change. */
export function pageOf(id) { const i = S.pinned.indexOf(id); return i < 0 ? 0 : Math.floor(i / PAGE); }
export const pages = () => Math.max(1, Math.ceil(S.pinned.length / PAGE));
export const maxStart = () => Math.max(0, S.pinned.length - PAGE);
export function cellOf(id, start) { const i = S.pinned.indexOf(id) - start; if (i < 0 || i >= PAGE) return null; return {col: i, row: 0}; }
/** Sessions off the row that need you (the More chip counts them). */
export function offRow(start) { const ids = S.pinned.filter((id, i) => i < start || i >= start + PAGE); return {n: ids.length, need: ids.filter((id) => ['unread', 'asking', 'error'].includes(indicator(get(id)))).length}; }
const RING = {idle: 0, current: 0, running: 1, waiting: 2, unread: 3, asking: 3, error: 4};

function drawBar(ctx, p) {
  const bar = p.bar, W = p.cw, H = p.ch, cw = px(BAR.CELL), rh = px(BAR.ROW), pad = PAD_M * BAR.PPM;
  fillRR(ctx, 2, 2, W - 4, H - 4, 26, 'rgba(10,10,10,0.74)', 'rgba(36,36,36,1)', 3);
  const start = bar.start, ids = S.pinned.slice(start, start + PAGE);
  bar.drawn = [];
  ids.forEach((id, i) => {
    const s = get(id), col = i, row = 0;
    const x = pad + col * cw, y = pad + row * rh, cx = x + cw / 2, k = indicator(s), cur = id === S.currentId;
    const hov = p.isHover(`avatar:${id}`);
    if (cur || hov) fillRR(ctx, x + 6, y + 6, cw - 12, rh - 12, 22, cur ? '#181818' : '#121212', cur ? '#3a3a3a' : '#2a2a2a', 2);
    const ay = y + px(2.1), r = px(1.55);
    drawAvatar(ctx, id, cx, ay, r, {dim: k === 'idle' ? 0.5 : 0});
    // Badges (rings are drawn live by the ring mesh).
    const bx = cx + r * 0.78, by = ay - r * 0.78, br = px(0.62);
    const badge = (fill, stroke, label, col2) => { ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.lineWidth = 3; ctx.strokeStyle = stroke; ctx.stroke(); } text(ctx, label, bx, by + 1, {size: px(BAR.STATUS_DEG), weight: 800, color: col2, align: 'center'}); };
    if (k === 'unread' || k === 'asking') badge(C.accent, '#0a0a0a', k === 'asking' ? '?' : String(unreadTurns(s)), '#111');
    else if (k === 'waiting') badge('#0a0a0a', '#8fb8ff', String(waitingCount(s)), '#8fb8ff');
    else if (k === 'error') badge(C.danger, '#0a0a0a', '!', '#111');
    if (k === 'running') {
      const tool = currentToolName(s);
      ctx.font = font(px(BAR.STATUS_DEG), 700, MONO); const tw = ctx.measureText(tool).width + 24, th = px(1.0);
      fillRR(ctx, cx - tw / 2, ay + r - th * 0.55, tw, th, th / 2, '#0a0a0a', 'rgba(226,177,95,0.55)', 2);
      text(ctx, tool, cx, ay + r - th * 0.05, {size: px(BAR.STATUS_DEG), weight: 700, family: MONO, color: C.accent, align: 'center'});
    }
    // Title: two lines of whole words (the short title when the full one needs more), for the current session and
    // the one you point at or look at; the others show only their avatar and status.
    ctx.font = font(px(BAR.TITLE_DEG), 650, SANS);
    let w = wrapWhole(ctx, s.title, cw - 26, 2);
    if (w.cut && s.short) w = wrapWhole(ctx, s.short, cw - 26, 2);
    const tc = k === 'idle' ? C.muted : '#f2f2f2', titled = cur || hov || bar.gaze === id;
    if (!titled) w = {...w, lines: []};
    w.lines.forEach((ln, j) => text(ctx, ln, cx, y + px(4.75) + j * px(1.0), {size: px(BAR.TITLE_DEG), weight: 650, color: tc, align: 'center'}));
    if (cur) fillRR(ctx, cx - cw * 0.3, y + rh - 16, cw * 0.6, 5, 2.5, C.accent);
    bar.drawn.push({id, col, titled, lines: w.lines, chars: w.lines.join(' ').replace(/ …$/, '').length, total: (s.title).length, usedShort: w.lines.join(' ').replace(/ …$/, '') !== s.title, cut: w.cut});
    p.region(`avatar:${id}`, x, y, cw, rh, {session: id, click: () => UIB.choose(id)});
  });
  // The chips at the end of the row: Home, and More (what is off the row, settings, back to chat, scrolling).
  const off = offRow(start), chips = [
    {id: 'bar:home', icon: 'house', label: 'Home', sub: 'H · Y', click: () => UIB.home()},
    {id: 'bar:more', icon: 'layers', label: 'More', sub: off.n ? `+${off.n} more${off.need ? ` · ${off.need} need you` : ''}` : 'settings', click: () => UIB.toggleMore(), need: off.need},
  ];
  chips.forEach((c, j) => {
    const x = pad + (PAGE + j) * cw, y = pad, hov = p.isHover(c.id) || (c.id === 'bar:more' && bar.moreOpen);
    fillRR(ctx, x + 8, y + 8, cw - 16, rh - 16, 22, hov ? '#202020' : '#141414', hov ? 'rgba(226,177,95,0.6)' : '#2c2c2c', 2);
    icon(ctx, c.icon, x + cw / 2, y + px(1.9), px(1.9), C.accent, 3);
    text(ctx, c.label, x + cw / 2, y + px(4.3), {size: px(BAR.TITLE_DEG), weight: 700, align: 'center'});
    ctx.font = font(px(BAR.STATUS_DEG), 600, SANS);
    const sw = wrapWhole(ctx, c.sub, cw - 24, 2);
    sw.lines.forEach((ln, k) => text(ctx, ln, x + cw / 2, y + px(5.35) + k * px(0.86), {size: px(BAR.STATUS_DEG), weight: 600, color: C.muted, align: 'center'}));
    if (c.need) { const bx = x + cw - px(1.15), by = y + px(1.0), br = px(0.62); ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill(); text(ctx, String(c.need), bx, by + 1, {size: px(BAR.STATUS_DEG), weight: 800, color: '#111', align: 'center'}); }
    p.region(c.id, x, y, cw, rh, {click: c.click});
  });
}
export function currentToolName(s) {
  for (let i = s.messages.length - 1; i >= 0; i--) { const m = s.messages[i]; if (m.type === 'tool' && m.status === 'running') { const cmd = (m.args?.command || m.sub || '').trim(); return m.name === 'bash' && /^(rg|grep|find|fd)\b/.test(cmd) ? 'search' : m.name; } }
  return 'thinking';
}

const ringMat = () => new THREE.ShaderMaterial({
  uniforms: {uTime: {value: 0}}, transparent: true, depthWrite: false, depthTest: false,
  vertexShader: 'attribute vec4 aR; varying vec2 vP; varying vec4 vR; void main(){ vP = position.xy * 2.0; vR = aR; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform float uTime; varying vec2 vP; varying vec4 vR;
    void main() {
      float r = length(vP) * 1.3, ang = atan(vP.y, vP.x), m = vR.x;
      float band = smoothstep(0.80, 0.84, r) * (1.0 - smoothstep(0.96, 1.0, r));
      vec3 gold = vec3(0.886, 0.694, 0.373); vec3 c = gold; float a = 0.0;
      if (m < 0.5) { c = vec3(0.36); a = band * 0.55; }
      else if (m < 1.5) { float h = mod(ang + uTime * 4.0 + vR.z * 6.28, 6.28318); float arc = smoothstep(0.0, 0.25, h) * (1.0 - smoothstep(1.7, 2.1, h)); a = band * (0.18 + 0.82 * arc); }
      else if (m < 2.5) { c = vec3(0.56, 0.72, 1.0); float d = step(0.5, fract((ang + uTime * 0.8) / 6.28318 * 10.0)); a = band * (0.35 + 0.65 * d); }
      else if (m < 3.5) { float pulse = 0.75 + 0.25 * sin(uTime * 2.4 + vR.z * 6.0); a = band + (1.0 - smoothstep(1.0, 1.28, r)) * step(0.96, r) * 0.55 * pulse; }
      else { c = vec3(0.984, 0.443, 0.522); a = band; }
      gl_FragColor = vec4(c, a);
      /* colours are display-space (pi-web hex), written as they are */
    }`,
});

/** The bar's surface is a band on a sphere around your eye whose centre line is a great circle tilted down to −26.5°:
 * every cell is the same distance away and keeps its true angular size (6.1° × 7.2°), and because a great circle
 * projects to a straight line, the row looks straight when you look at it. The group's origin is the eye. */
class BarPanel extends Panel {
  uvToLocal(u, v, out = new THREE.Vector3()) {
    if (this.flat) return out.set((u - 0.5) * this.w, Math.tan((this.elev ?? BAR.ELEV) * DEG) * BAR.D + (v - 0.5) * this.h, -BAR.D);
    const a = (u - 0.5) * this.w / BAR.D, e = (v - 0.5) * this.h / BAR.D, el = (this.elev ?? BAR.ELEV) * DEG;
    const x = Math.sin(a) * Math.cos(e), y = Math.sin(e), z = -Math.cos(a) * Math.cos(e);
    return out.set(x * BAR.D, (y * Math.cos(el) - z * Math.sin(el)) * BAR.D, (y * Math.sin(el) + z * Math.cos(el)) * BAR.D);
  }
  setElev(e, flat = false) { if (Math.abs((this.elev ?? 1e9) - e) < 0.05 && flat === !!this.flat) return; this.elev = e; this.flat = flat; this.mesh.geometry.dispose(); this.mesh.geometry = this.geometry(); }
}
export class Bar {
  constructor(uiRoot) {
    this.g = new THREE.Group(); this.g.name = 'bar'; uiRoot.add(this.g);
    const w = BAR.COLS * CELL_M + 2 * PAD_M, h = BAR.ROWS * ROW_M + 2 * PAD_M;
    this.panel = new BarPanel('bar', {w, h, R: BAR.D, ppm: BAR.PPM, draw: drawBar, renderOrder: 30, depthWrite: false});
    this.panel.setElev(BAR.ELEV);
    this.panel.bar = this; this.panel.mat.depthTest = false;
    this.g.add(this.panel.mesh);
    this.rings = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), ringMat(), PAGE);
    this.ringA = new THREE.InstancedBufferAttribute(new Float32Array(PAGE * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.rings.geometry.setAttribute('aR', this.ringA); this.rings.renderOrder = 31; this.rings.frustumCulled = false; this.rings.name = 'bar-rings';
    this.g.add(this.rings);
    this.yaw = 0; this.yawTarget = 0; this.start = 0; this.lastCur = null; this.gaze = null; this.moreOpen = false; this.sig = ''; this.follow = []; this.hover = null; this.hoverSince = 0;
    this.pos = new THREE.Vector3(0, 1.6, 0); this.elev = BAR.ELEV; this.elevTarget = BAR.ELEV; this.pitchLog = []; this.snap = true;
  }
  get page() { return Math.floor((this.start + PAGE - 1) / PAGE); }
  /** Scroll the row by d avatars (clamped); a user action. */
  scroll(d) { const s0 = this.start; this.start = clamp(this.start + d, 0, maxStart()); if (this.start !== s0) this.invalidate(); return this.start; }
  invalidate() { this.panel.invalidate(); }
  /** Local position (in the bar group) of a cell's avatar centre, and its curve angle. */
  cellLocal(col, row) {
    const W = this.panel.cw, H = this.panel.ch, pad = PAD_M * BAR.PPM;
    const x = pad + col * px(BAR.CELL) + px(BAR.CELL) / 2, y = pad + row * px(BAR.ROW) + px(2.1);
    const {u, v} = this.panel.fromCanvas(x, y), out = this.panel.uvToLocal(u, v, new THREE.Vector3());
    return {p: out, t: (u - 0.5) * this.panel.w / BAR.D, u, v, W, H};
  }
  cellWorld(id) { const c = cellOf(id, this.start); if (!c) return null; const L = this.cellLocal(c.col, c.row); this.g.updateMatrixWorld(true); return L.p.clone().applyMatrix4(this.g.matrixWorld); }
  /** headPos / headYaw / headPitch (radians) in the bar's parent space (uiRoot). deskElev: desktop-only placement. */
  update(headPos, headYaw, dt, deskElev = null, headPitch = 0, contentLow = null) {
    // Lazy follow: re-centre only when the head has turned more than 35° away; then ease over to it.
    let d = Math.atan2(Math.sin(headYaw - this.yawTarget), Math.cos(headYaw - this.yawTarget));
    if (Math.abs(d) > BAR.FOLLOW * DEG) { this.yawTarget = headYaw; this.follow.push({t: Math.round(animMs()), to: +(headYaw / DEG).toFixed(1)}); }
    d = Math.atan2(Math.sin(this.yawTarget - this.yaw), Math.cos(this.yawTarget - this.yaw));
    this.yaw += S.reduceMotion ? d : d * Math.min(1, dt / 0.16);
    this.pos.copy(headPos); // body-locked in position (it never swims); only its heading follows lazily
    // In the headset the band sits BELOW (24°) under where you look, clamped to −70°…−16°, with lazy follow: it re-centres
    // only when your gaze has moved more than 12° from where it would put it, and never while you look at the bar
    // itself. The band is built on the equator and tilted by the group, so following costs no geometry. The desktop
    // preview has no body, so there the band is tilted with the camera's pitch and sits along the bottom of the window.
    if (deskElev) { this.elev = deskElev.offset; this.panel.setElev(Math.round(this.elev * 4) / 4, true); }
    else {
      // Where it wants to be: BELOW under your gaze, and a little lower when that would put it over the city's centre
      // region in view (contentLow, its lower edge). Only when you are looking at the city: if the region's edge is
      // more than CITY_GAZE under your gaze (you look at the sky or the horizon), the city is not your main view.
      // Clamped to −70°…−16°.
      const gaze = headPitch / DEG, t = animMs(), top = BAR.ROW / 2 + 2;
      const low = contentLow != null && contentLow > gaze - BAR.CITY_GAZE ? contentLow : null;
      const want = clamp(Math.min(gaze - BAR.BELOW, low == null ? 1e9 : low - top), BAR.ELEV_MIN, BAR.ELEV_MAX);

      const covering = low != null && this.elevTarget + top > low + 1 && want < this.elevTarget - 1;
      // Your gaze has to rest (0.5 s within 4°) somewhere new, and not on or just above the bar (looking at the bar
      // never moves it away).
      if (Math.abs(gaze - (this.rest ?? 1e9)) > 4) { this.rest = gaze; this.restAt = t; }
      // Looking at the bar (or pointing at it) holds it where it is.
      const onBar = this.pointed || (gaze > this.elev - BAR.ROW / 2 - 2 && gaze < this.elev + BAR.ROW / 2 + 4);
      if ((Math.abs(want - this.elevTarget) > BAR.PITCH_FOLLOW || covering) && !onBar && (t - this.restAt > 500 || this.snap)) { this.elevTarget = want; this.snap = false; this.pitchLog.push({t: Math.round(animMs()), gaze: +gaze.toFixed(1), to: +want.toFixed(1)}); }
      const de = this.elevTarget - this.elev;
      this.elev += S.reduceMotion || Math.abs(de) < 0.05 ? de : de * Math.min(1, dt / 0.16);
      this.panel.setElev(0, false);
    }
    this.g.position.copy(this.pos);
    this.g.rotation.set(deskElev ? deskElev.pitch : this.elev * DEG, this.yaw, 0, 'YXZ');
    // The row scrolls to keep the current session on it when you move to another one (a user action), never on a
    // status change; a scroll from More stays until you next move.
    if (S.currentId !== this.lastCur) {
      this.lastCur = S.currentId; const i = S.pinned.indexOf(S.currentId);
      if (i >= 0 && (i < this.start || i >= this.start + PAGE)) { this.start = clamp(i < this.start ? i : i - PAGE + 1, 0, maxStart()); this.invalidate(); }
    }
    if (this.start > maxStart()) { this.start = maxStart(); this.invalidate(); }
    // Gaze: the avatar within half a cell of your head's forward direction (titles show for it).
    this.gaze = null;
    if (!deskElev) {
      const fwd = new THREE.Vector3(-Math.sin(headYaw) * Math.cos(headPitch), Math.sin(headPitch), -Math.cos(headYaw) * Math.cos(headPitch));
      this.g.updateMatrix();
      S.pinned.slice(this.start, this.start + PAGE).forEach((id, i) => { const d = this.cellLocal(i, 0).p.clone().applyMatrix4(this.g.matrix).sub(this.pos).normalize(); if (d.angleTo(fwd) < BAR.CELL / 2 * DEG) this.gaze = id; });
    }
    const sig = S.pinned.slice(this.start, this.start + PAGE).map((id) => { const s = get(id); return `${id}:${indicator(s)}:${unreadTurns(s)}:${waitingCount(s)}:${indicator(s) === 'running' ? currentToolName(s) : ''}`; }).join('|') + `|${S.currentId}|${this.start}|${this.gaze}|${this.moreOpen}|${offRow(this.start).need}|${S.pinned.length}`;
    if (sig !== this.sig) { this.sig = sig; this.invalidate(); }
    this.panel.update();
    // Rings: one per visible avatar.
    const ids = S.pinned.slice(this.start, this.start + PAGE), m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    ids.forEach((id, i) => {
      const L = this.cellLocal(i, 0);
      const r = 2 * 1.85 * M_PER_DEG * 1.3;
      pos.copy(L.p).multiplyScalar(0.999);
      m.lookAt(pos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)); q.setFromRotationMatrix(m);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      m.compose(pos, q, sc.set(r, r, 1)); this.rings.setMatrixAt(i, m);
      const k = indicator(get(id));
      this.ringA.array.set([RING[k] ?? 0, id === S.currentId ? 1 : 0, (i * 0.137) % 1, 0], i * 4);
    });
    this.rings.count = ids.length; this.rings.instanceMatrix.needsUpdate = true; this.ringA.needsUpdate = true;
    this.rings.material.uniforms.uTime.value = performance.now() / 1000;
  }
  /** The bar as tangent-space boxes for the label and card passes (nothing in the city is drawn over it): one box per
   * two columns, so the band's curve does not grow into one huge box. */
  obstacle(eye, camQ) {
    const inv = camQ.clone().invert(), out = [];
    this.g.updateMatrixWorld(true);
    const n = BAR.COLS / 2, extra = this.moreOpen ? ((this.menuH || 0.44) + 0.03) / this.panel.h : 0; // the open More menu, in bar heights
    for (let k = 0; k < n; k++) {
      const pts = [];
      for (const [u, v] of [[k / n, 0], [(k + 1) / n, 0], [k / n, 1 + extra * (k >= n - 3 ? 1 : 0)], [(k + 1) / n, 1 + extra * (k >= n - 3 ? 1 : 0)], [(k + 0.5) / n, 0], [(k + 0.5) / n, 1]]) {
        const p = this.panel.uvToLocal(u, v, new THREE.Vector3()).applyMatrix4(this.g.matrixWorld).sub(eye).applyQuaternion(inv);
        if (p.z > -0.05) { pts.length = 0; break; }
        pts.push([p.x / -p.z, p.y / -p.z]);
      }
      if (!pts.length) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({id: `bar:${k}`, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 + 0.01});
    }
    return out;
  }
}
export {fenceLine, clamp, ellipsize};
