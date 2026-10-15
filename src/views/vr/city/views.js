// Canvas drawing for the Town's reading panel: header, turn strip, composer, settings, pill (borrowed from vr-breeze).
import {C, MONO, font, fillRR, icon, text, dot, measure, ellipsize} from './draw.js';
import {S, get, indicator, statusText, folderLabel, waitingCount, turnsOf, needsYou, fenceLine} from './state.js';

export const UI = {};
export const STATUS_COL = {running: '#e2b15f', waiting: '#8fb8ff', unread: '#ffd58a', asking: '#ffd58a', error: '#fb7185', current: '#f2f2f2', idle: '#6f6f6f'};

/** Wrap plain text to at most maxLines lines at the current font; the last line gets an ellipsis. */
export function wrapLines(ctx, str, maxW, maxLines) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= maxW) { cur = t; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const truncated = lines.length === maxLines && words.join(' ').length > lines.join(' ').length;
  if (truncated) lines[maxLines - 1] = ellipsize(ctx, lines[maxLines - 1] + ' …', maxW);
  return lines.slice(0, maxLines);
}

// ---------------------------------------------------------------- reader header (pi-web's status bar and runtime status)
// Round 3: the focused session gets the room. In metres at the round 1 scale (1.4 m); the focus panel shows it 1.9 m
// away at FOCUS.S (core.js), so text stays about 1.2° while the panel is 55° × 44° (round 2: 50° × 30°).
export const READER = {w: 1.56, headerH: 0.13, streamH: 1.06, gutter: 0.19, ppm: 1100};
/** pi-web's status bar: the title in bold on the dark bar, the runtime status ("running" in gold, with the tool) and
 * the session's note below it, the context meter as a thin track along the bottom edge, and the City and Fly-to buttons. */
export function drawHeader(ctx, p) {
  const r = p.reader;
  const s = get(r.sid);
  if (!s) return;
  p.drawn = {sid: s.id, title: s.title, note: s.note || null};
  const W = p.cw, H = p.ch;
  fillRR(ctx, 2, 2, W - 4, H - 2, [22, 22, 0, 0], '#0a0a0a', '#242424', 2);
  const kind = indicator(s);
  const col = STATUS_COL[kind];
  // Right end: City (back) and Fly to (its place in the city), each the full header height.
  const BW = 200, FW = 200;
  const hovC = p.isHover('header:town'), hovF = p.isHover('header:fly');
  fillRR(ctx, W - BW - 10, 12, BW, H - 24, (H - 24) / 2, hovC ? '#2c2c2c' : '#161616', '#333', 2);
  icon(ctx, 'house', W - BW + 30, H / 2, 30, C.accent, 2.4);
  text(ctx, UI.xr ? 'City (B)' : 'City (Esc)', W - BW + 54, H / 2 + 1, {size: 25, weight: 700, color: C.text});
  p.region('header:town', W - BW - 14, 0, BW + 14, H, {click: () => UI.closeReader()});
  fillRR(ctx, W - BW - FW - 22, 12, FW, H - 24, (H - 24) / 2, hovF ? '#2c2c2c' : '#161616', 'rgba(226,177,95,0.55)', 2);
  icon(ctx, 'locate-fixed', W - BW - FW + 8, H / 2, 30, C.accent, 2.4);
  text(ctx, UI.xr ? 'Fly to' : 'Fly to (F)', W - BW - FW + 32, H / 2 + 1, {size: 25, weight: 700, color: C.text});
  p.region('header:fly', W - BW - FW - 26, 0, FW + 10, H, {click: () => UI.flyCurrent()});
  const n = r.set?.turns.length || 0;
  const y1 = H * 0.34, y2 = H * 0.70;
  const right = W - BW - FW - 40;
  const pos = n ? `Turn ${Math.min(n, r.turnIdx + 1)} of ${n}` : '';
  const posW = text(ctx, pos, right, y1, {size: 23, color: C.muted, align: 'right', weight: 600});
  text(ctx, s.title, 36, y1, {size: 36, weight: 700, maxW: right - posW - 60});
  // Runtime status, as pi-web shows it above the composer: running in gold, with the tool.
  let x = 36;
  if (kind === 'running') x += text(ctx, `● running · ${currentToolLabel(s)} · ${statusText(s).replace('Running ', '')}`, x, y2, {size: 23, weight: 800, color: C.accent, maxW: 420}) + 24;
  else x += text(ctx, kind === 'current' ? (s.model || 'Current session') : statusText(s), x, y2, {size: 23, weight: 700, color: kind === 'waiting' || kind === 'error' ? col : C.muted, maxW: 380}) + 24;
  x += text(ctx, folderLabel(s.cwd), x, y2, {size: 21, family: MONO, color: '#6f6f6f', maxW: 200}) + 22;
  if (s.note) {
    icon(ctx, 'sticky-note', x + 12, y2, 22, '#ffd58a', 2.2);
    text(ctx, s.note, x + 32, y2, {size: 23, weight: 600, color: '#ffe3ae', maxW: right - x - 40, style: 'italic'});
  }
  // The context meter: a thin track along the bottom edge, gold while running, with its percentage.
  const pct = Math.round((s.ctx || 0) * 100), tw = W - 2 * 36 - 90;
  fillRR(ctx, 36, H - 9, tw, 5, 2.5, 'rgba(163,163,163,0.14)');
  fillRR(ctx, 36, H - 9, tw * (s.ctx || 0), 5, 2.5, kind === 'running' ? C.accent : s.ctx > 0.6 ? '#f59e0b' : 'rgba(163,163,163,0.45)');
  text(ctx, `${pct}%`, W - 36, H - 8, {size: 18, weight: 800, color: s.ctx > 0.6 ? '#fbbf24' : C.muted, align: 'right'});
}
function currentToolLabel(s) { for (let i = s.messages.length - 1; i >= 0; i--) { const m = s.messages[i]; if (m.type === 'tool' && m.status === 'running') return m.name; } return 'thinking'; }

// ---------------------------------------------------------------- turn strip (ticks only; the position bar is a mesh)
export const STRIP = {ppm: 800};
export function drawStrip(ctx, p) {
  const r = p.reader;
  const set = r.set;
  const W = p.cw, H = p.ch;
  const cx = W / 2 + 18;
  // Subtle hit-area hint so the wide target is discoverable without clutter.
  fillRR(ctx, 6, 6, W - 12, H - 12, 18, p.isHover('strip') || r.scrubbing ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.0)', null);
  fillRR(ctx, cx - 5, 14, 10, H - 28, 5, '#1d1d1d', '#2a2a2a', 1.5);
  if (set && set.turns.length) {
    const n = set.turns.length;
    const yOf = (f) => 14 + f * (H - 28);
    set.turns.forEach((t, i) => {
      const y0 = yOf(i / n);
      fillRR(ctx, cx - 22, y0 - 4 + (i === 0 ? 6 : 0), 44, 8, 4, C.accent);
      const fr = (i + Math.min(0.95, t.replyY / Math.max(1, t.h))) / n;
      fillRR(ctx, cx - 14, yOf(fr) - 2.5, 28, 5, 2.5, '#8a8a8a');
    });
    if (set.markF != null) {
      const y = yOf(set.markF);
      ctx.save(); ctx.translate(cx, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = '#ffd58a'; ctx.fillRect(-11, -11, 22, 22); ctx.restore();
      ctx.save(); ctx.translate(cx - 38, y); ctx.rotate(-Math.PI / 2);
      text(ctx, 'NEW', 0, 0, {size: 20, weight: 800, color: '#ffd58a', align: 'center'});
      ctx.restore();
    }
  }
  p.region('strip', 0, 0, W, H, {strip: true});
}

// ---------------------------------------------------------------- pill "↓ New output"
export const PILL = {w: 0.46, h: 0.17, ppm: 1000};
export function drawPill(ctx, p) {
  const W = p.cw, H = p.ch;
  const hov = p.isHover('pill');
  const pw = 300, ph = 76;
  fillRR(ctx, (W - pw) / 2, (H - ph) / 2, pw, ph, ph / 2, hov ? '#f0c27a' : C.accent, null);
  icon(ctx, 'arrow-down', (W - pw) / 2 + 52, H / 2, 32, '#111', 3);
  text(ctx, 'New output', (W - pw) / 2 + 84, H / 2 + 1, {size: 32, weight: 700, color: '#111'});
  p.region('pill', 0, 0, W, H, {click: () => UI.toLatest()});
}

// ---------------------------------------------------------------- composer
export const COMPOSER = {w: 0.24, h: 0.58, ppm: 1000};
/** The composer, round 2: a column to the right of the reading panel. Draft text on top, then mic, then send. */
export function drawComposer(ctx, p) {
  const W = p.cw, H = p.ch;
  const c = S.composer;
  const focused = c.focused || c.dictating;
  const BH = 180; // each button: 0.24 m × 0.18 m (more than 6° from the eye at 1.6 m)
  const fh = H - 2 * BH - 24;
  fillRR(ctx, 4, 4, W - 8, fh - 4, 26, '#0f0f0f', focused ? 'rgba(226,177,95,0.6)' : '#242424', 3);
  p.region('composer:input', 0, 0, W, fh, {click: () => UI.focusComposer()});
  let y = 46;
  if (c.dictating) {
    dot(ctx, 34, y, 9, C.danger);
    const t = performance.now() / 120;
    for (let i = 0; i < 4; i++) { const bh = 10 + Math.abs(Math.sin(t + i * 0.9)) * 22; fillRR(ctx, 56 + i * 12, y - bh / 2, 6, bh, 3, C.danger); }
    text(ctx, 'Listening…', 116, y + 1, {size: 26, color: C.muted});
    y += 44;
  }
  ctx.font = font(28);
  const lines = c.text ? wrapLines(ctx, c.text, W - 48, Math.floor((fh - y) / 36)) : [];
  if (lines.length) for (const ln of lines) { text(ctx, ln, 24, y, {size: 28}); y += 36; }
  else if (!c.dictating) { text(ctx, 'Ask pi…', 24, y, {size: 30, color: C.dim}); text(ctx, c.unavailable ? 'no dictation here: type' : 'mic to dictate', 24, y + 38, {size: 24, color: C.faint}); }
  if (focused && Math.floor(performance.now() / 500) % 2 === 0) { ctx.fillStyle = C.accent; ctx.fillRect(24, Math.min(fh - 30, y - 6), 3, 30); }
  const micY = fh + 8, sendY = fh + 16 + BH;
  const micHov = p.isHover('composer:mic'), sendHov = p.isHover('composer:send');
  fillRR(ctx, 4, micY, W - 8, BH - 8, 30, c.dictating ? 'rgba(251,113,133,0.22)' : micHov ? '#2c2c2c' : '#1a1a1a', '#2c2c2c', 2);
  icon(ctx, 'mic', W / 2, micY + BH / 2 - 4, 52, c.dictating ? C.danger : C.text, 2.6);
  p.region('composer:mic', 0, micY - 4, W, BH, {click: () => UI.toggleDictation()});
  fillRR(ctx, 4, sendY, W - 8, BH - 8, 30, c.text ? (sendHov ? '#f0c27a' : C.accent) : '#1a1a1a', '#2c2c2c', 2);
  icon(ctx, 'arrow-up', W / 2, sendY + BH / 2 - 4, 52, c.text ? '#111' : C.dim, 3);
  p.region('composer:send', 0, sendY - 4, W, BH, {click: () => UI.send()});
}

// ---------------------------------------------------------------- navigation column (left of the panel)
export const NAV = {w: 0.2, h: 0.58, ppm: 1000};
/** Three big buttons beside the panel, mirroring the composer: back to the city, what needs me, and fly to this
 * session's place in the city. Each is 0.2 m × 0.18 m, about 7° from the eye. */
export function drawNav(ctx, p) {
  const W = p.cw, H = p.ch, BH = (H - 32) / 3;
  const n = fenceLine().length;
  const rows = [
    {id: 'nav:town', icon: 'house', label: 'City', sub: 'Esc · B', click: () => UI.closeReader()},
    {id: 'nav:needs', icon: 'bell', label: n ? `${n} need you` : 'Nobody', sub: 'N · A', click: () => UI.needsYou(), accent: n > 0},
    {id: 'nav:fly', icon: 'locate-fixed', label: 'Fly there', sub: 'F', click: () => UI.flyCurrent()},
  ];
  rows.forEach((r, i) => {
    const y = i * (BH + 16), hov = p.isHover(r.id);
    fillRR(ctx, 4, y + 4, W - 8, BH - 8, 30, hov ? '#2c2c2c' : '#141414', r.accent ? 'rgba(226,177,95,0.55)' : '#2c2c2c', 2);
    icon(ctx, r.icon, W / 2, y + BH * 0.34, 50, r.accent ? C.accent : C.text, 2.6);
    text(ctx, r.label, W / 2, y + BH * 0.64, {size: 28, weight: 700, align: 'center'});
    text(ctx, r.sub, W / 2, y + BH * 0.84, {size: 22, color: C.dim, align: 'center'});
    p.region(r.id, 0, y, W, BH + 8, {click: r.click});
  });
}

// ---------------------------------------------------------------- "2 need you" hint
export const HINT = {w: 0.62, h: 0.07, ppm: 1000};
export function drawHint(ctx, p) {
  const W = p.cw, H = p.ch;
  const n = fenceLine().length;
  const hov = p.isHover('hint');
  const label = n ? `${n} at the fence` : 'Nobody at the fence';
  const keys = UI.xr ? 'stick click' : 'N';
  ctx.font = font(28, 700);
  const lw = ctx.measureText(label).width;
  ctx.font = font(22, 600);
  const kw = ctx.measureText(keys).width;
  const w = 60 + lw + (n ? 28 + kw + 24 : 30);
  const x = (W - w) / 2;
  fillRR(ctx, x, 6, w, H - 12, (H - 12) / 2, n ? (hov ? 'rgba(226,177,95,0.22)' : 'rgba(226,177,95,0.12)') : 'rgba(255,255,255,0.04)', n ? '#6b5426' : '#2a2a2a', 2);
  dot(ctx, x + 32, H / 2, 9, n ? '#ffd58a' : '#4a4a4a');
  text(ctx, label, x + 52, H / 2 + 1, {size: 28, weight: 700, color: n ? '#ffd58a' : C.dim});
  if (n) {
    const kx = x + 52 + lw + 18;
    fillRR(ctx, kx, H / 2 - 17, kw + 20, 34, 8, '#1a1a1a', '#3a3a3a', 1.5);
    text(ctx, keys, kx + 10, H / 2 + 1, {size: 22, weight: 600, color: C.muted});
  }
  p.region('hint', x, 0, w, H, {click: () => UI.needsYou()});
}

// ---------------------------------------------------------------- settings chip + panel
export const GEAR = {w: 0.13, h: 0.11, ppm: 1000};
export function drawGear(ctx, p) {
  const W = p.cw, H = p.ch;
  const hov = p.isHover('gear') || S.settingsOpen;
  fillRR(ctx, 6, 10, W - 12, H - 20, (H - 20) / 2, hov ? '#262626' : '#161616', S.settingsOpen ? C.accent : '#2c2c2c', 2);
  icon(ctx, 'settings', W / 2, H / 2, 40, C.muted, 2.2);
  p.region('gear', 0, 0, W, H, {click: () => UI.toggleSettings()});
}
export const SETTINGS = {w: 0.9, h: 0.27, ppm: 1000};
export function drawSettings(ctx, p) {
  const W = p.cw, H = p.ch;
  fillRR(ctx, 3, 3, W - 6, H - 6, 26, '#151515', '#3a3a3a', 2);
  text(ctx, 'Settings', 36, 50, {size: 32, weight: 700});
  icon(ctx, 'x', W - 50, 50, 30, C.muted, 2.4);
  p.region('set:close', W - 100, 0, 100, 100, {click: () => UI.toggleSettings(false)});
  const y = 120, h = 110;
  fillRR(ctx, 36, y, W - 72, h, 18, p.isHover('set:motion') ? '#222' : '#181818', '#2e2e2e', 2);
  text(ctx, 'Reduce motion', 60, y + 38, {size: 29, weight: 700});
  text(ctx, 'instant switches, people step instead of walking, no birds', 60, y + 78, {size: 21, color: C.muted, maxW: W - 260});
  const on = S.reduceMotion;
  fillRR(ctx, W - 150, y + h / 2 - 22, 84, 44, 22, on ? C.accent : '#333', null);
  dot(ctx, on ? W - 88 : W - 128, y + h / 2, 17, on ? '#111' : '#bbb');
  p.region('set:motion', 36, y, W - 72, h, {click: () => UI.setReduceMotion(!S.reduceMotion)});
}
