// Turns: a turn is your prompt plus everything the agent did until the next prompt. Each turn is laid out and drawn
// once into its own canvas (its own texture), so scrolling and switching never re-rasterise text.
// Tool calls collapse to one-line chips with an outcome summary; thinking collapses to one line.
import {C, MONO, SANS, font, fillRR, icon, text, ellipsize, parseHtml, layoutRuns, drawRuns, codeTokens} from './draw.js';

export const PPM = 1100; // canvas px per metre on the reading panel
export const TURN_W = 1240; // turn canvas width (px) = 1.127 m; text column ≈ 1144 px ≈ 65-70 characters at 35 px
export const BODY = 35; // body text px: 31.8 mm at 1.4 m = 1.3° (22.7 px-at-1 m, where 1 px at 1 m = 1 mm)
const M = 12; // block margin inside the canvas
const PAD = 36; // inner padding of a turn block
const INNER = TURN_W - 2 * M - 2 * PAD;
const LH = Math.round(BODY * 1.5);
const CHIP_H = 66;

const htmlCache = new WeakMap();
const blocksOf = (m) => { let b = htmlCache.get(m); if (!b || b.html !== m.html) { b = {html: m.html, blocks: parseHtml(m.html)}; htmlCache.set(m, b); } return b.blocks; };
const base = (p) => String(p || '').split('/').pop();

/** One-line chip label for a tool call: name, outcome summary, and a dim detail. */
export function chipLabel(m) {
  if (m.type === 'thinking') return {name: 'Thinking', sum: m.heading, detail: '', icon: 'brain'};
  if (m.type === 'edit') {
    let add = 0, del = 0;
    for (const [k] of m.rows) { if (k === 'add') add++; else if (k === 'del') del++; else if (k === 'changed') { add++; del++; } }
    return {name: 'edit', sum: `${base(m.path)} · +${add} −${del}`, detail: m.path, icon: 'pencil', joined: true};
  }
  const running = m.status === 'running';
  if (m.name === 'read') return {name: 'read', sum: base(m.args?.path || m.sub), detail: m.args?.path || m.sub, icon: 'file-text', joined: true};
  if (m.name === 'write') return {name: 'write', sum: m.sum || base(m.sub), detail: m.sub, icon: 'pencil', joined: true};
  if (m.name === 'sessions_spawn') return {name: 'spawn', sum: m.sum || m.sub, detail: 'worker session', icon: 'git-fork'};
  const cmd = m.args?.command || (m.sub || '').split(' · ')[0];
  let sum = m.sum;
  if (!sum) { const pm = /(\d+) passed/.exec(m.body || ''); sum = pm ? `${pm[1]} passed` : cmd.split(' ').slice(0, 2).join(' '); }
  if (running && !/running|looping|rendering/.test(sum)) sum = `${sum} · running`;
  return {name: m.name, sum, detail: cmd, icon: 'terminal'};
}
export function chipText(m) { const l = chipLabel(m); return l.joined ? `${l.name} ${l.sum}` : `${l.name} · ${l.sum}`; }

/**
 * Lay out one turn. Returns {h, items: [{y, h, draw(c, y)}], regions: [{id, msg, y, h}], replyY, markY}.
 * opts: {index, expanded: Set<msgIndex>, newMark: msgIndex|null}
 */
export function layoutTurn(ctx, s, turn, opts) {
  const items = [], regions = [];
  let y = 0, replyY = null, markY = null;
  const add = (h, draw) => { items.push({y, h, draw}); y += h; };
  const gap = (g) => { y += g; };
  const msgs = s.messages;
  // Turn head: a clear start.
  const first = msgs[turn.start];
  const head = first.type === 'user' ? `Turn ${opts.index + 1}` : 'Start';
  gap(14);
  const markAtStart = opts.newMark === turn.start && first.type === 'user';
  if (markAtStart) { markY = y; add(46, (c, top) => drawMark(c, top)); gap(4); }
  add(44, (c, top) => {
    const w = text(c, head.toUpperCase(), M + PAD, top + 22, {size: 20, weight: 800, color: '#8a7a5c'});
    text(c, first.time ? `·  ${first.time}` : '', M + PAD + w + 14, top + 22, {size: 20, color: '#5a5a5a'});
  });
  gap(8);
  let prevKind = null;
  for (let i = turn.start; i < turn.end; i++) {
    const m = msgs[i];
    if (opts.newMark === i && !markAtStart) {
      gap(prevKind ? 6 : 0);
      markY = y;
      add(46, (c, top) => drawMark(c, top));
      gap(12);
    }
    const kind = m.type === 'tool' || m.type === 'edit' || m.type === 'thinking' ? 'chip' : m.type;
    if (replyY === null && m.type !== 'user') replyY = y;
    if (m.type === 'user') {
      // pi-web's user message: a right-aligned bubble, gold-tinted gradient, radius 16 16 6 16, accent-tinted border.
      const maxW = Math.round(INNER * 0.86) - 44;
      const lay = layoutRuns(ctx, [{text: m.text}], maxW, BODY, 400, LH);
      const lw = Math.max(...lay.lines.map((l) => l.frags.reduce((a, f) => Math.max(a, f.x + f.w), 0)), 60);
      const h = lay.height + 30, bw = lw + 44, bx = M + PAD + INNER + 14 - bw;
      add(h, (c, top) => {
        const g = c.createLinearGradient(bx, top, bx + bw, top + h);
        g.addColorStop(0, '#3a301f'); g.addColorStop(1, '#221c12');
        c.beginPath(); c.roundRect(bx, top, bw, h, [24, 24, 9, 24]); c.fillStyle = g; c.fill();
        c.lineWidth = 2; c.strokeStyle = '#4b3e26'; c.stroke();
        drawRuns(c, lay, bx + 22, top + 15, BODY, '#f2f2f2', 400);
      });
      gap(22);
    } else if (m.type === 'assistant') {
      if (prevKind === 'chip') gap(10);
      for (const b of blocksOf(m)) {
        if (b.type === 'h') {
          const lay = layoutRuns(ctx, b.runs, INNER, BODY * 1.22, 700, BODY * 1.6);
          add(lay.height, (c, top) => drawRuns(c, lay, M + PAD, top, BODY * 1.22, C.text, 700));
          gap(8);
        } else if (b.type === 'li') {
          const ind = 44;
          const lay = layoutRuns(ctx, b.runs, INNER - ind, BODY, 400, LH);
          add(lay.height + 4, (c, top) => {
            c.beginPath(); c.arc(M + PAD + 14, top + LH / 2, 5.5, 0, Math.PI * 2); c.fillStyle = C.muted; c.fill();
            drawRuns(c, lay, M + PAD + ind, top, BODY, C.text);
          });
        } else {
          const lay = layoutRuns(ctx, b.runs, INNER, BODY, 400, LH);
          const caret = m.streaming && b === blocksOf(m)[blocksOf(m).length - 1];
          add(lay.height, (c, top) => { drawRuns(c, lay, M + PAD, top, BODY, C.text); if (caret) drawCaret(c, lay, M + PAD, top); });
          gap(16);
        }
      }
      gap(8);
    } else if (m.type === 'code') {
      const lines = m.src.split('\n');
      const clh = 40, h = lines.length * clh + 40;
      if (prevKind === 'chip') gap(6);
      add(h, (c, top) => {
        fillRR(c, M + PAD - 8, top, INNER + 16, h, 16, '#131313', '#242424', 2);
        text(c, m.lang, M + PAD + INNER - 6, top + 22, {size: 19, color: C.dim, align: 'right', family: MONO});
        let ly = top + 20 + clh / 2;
        for (const ln of lines) {
          let x = M + PAD + 16;
          c.font = font(26, 400, MONO); c.textBaseline = 'middle'; c.textAlign = 'left';
          for (const [t, col] of codeTokens(ln)) {
            const w = c.measureText(t).width;
            if (x + w > M + PAD + INNER - 10) { c.fillStyle = C.dim; c.fillText('…', x, ly); break; }
            c.fillStyle = col; c.fillText(t, x, ly); x += w;
          }
          ly += clh;
        }
      });
      gap(20);
    } else if (kind === 'chip') {
      if (prevKind && prevKind !== 'chip') gap(4);
      const open = opts.expanded?.has(i);
      const body = open ? expandedBody(ctx, m) : null;
      const h = CHIP_H + (body ? body.h + 14 : 0);
      const lab = chipLabel(m);
      const running = m.status === 'running';
      const think = m.type === 'thinking';
      regions.push({id: `chip:${i}`, msg: i, y, h: CHIP_H});
      add(h, (c, top) => {
        // pi-web's collapsed tool card: full width, a top border, the state's fill with the woven texture, a status
        // icon, the tool name in bold mono, its one-line summary, a gold "running" pill, and the gold chevron.
        const x = M + 4, w = TURN_W - 2 * M - 8, err = m.status === 'error';
        const fill = think ? '#171b25' : running ? '#14191f' : err ? '#1f1116' : '#15201e';
        c.fillStyle = fill; c.fillRect(x, top, w, h);
        weave(c, x, top, w, h);
        c.fillStyle = '#242424'; c.fillRect(x, top, w, 2);
        const cy = top + CHIP_H / 2;
        icon(c, running ? 'loader-circle' : err ? 'triangle-alert' : think ? 'brain' : 'circle-check', x + 40, cy, 26, running ? C.accent : err ? C.danger : think ? '#9aa4c2' : '#86efac', 2.4);
        let tx = x + 70;
        tx += text(c, lab.name, tx, cy + 1, {size: 27, weight: 700, family: think ? SANS : MONO, color: '#f2f2f2'});
        tx += 14;
        const sumW = text(c, lab.sum, tx, cy + 1, {size: 25, weight: 500, family: MONO, color: think ? '#c9c9d1' : C.muted, maxW: w - (tx - x) - 240, style: think ? 'italic' : 'normal'});
        tx += sumW + 18;
        if (running) { c.font = font(21, 700); const pw = c.measureText('running').width + 26; fillRR(c, tx, cy - 16, pw, 32, 16, null, 'rgba(226,177,95,0.55)', 2); text(c, 'running', tx + 13, cy + 1, {size: 21, weight: 700, color: C.accent}); tx += pw + 16; }
        if (lab.detail && !lab.joined && lab.detail !== lab.sum) text(c, lab.detail, tx, cy + 1, {size: 21, family: MONO, color: '#5a5a5a', maxW: x + w - 70 - tx});
        goldChevron(c, x + w - 34, cy, open);
        if (body) body.draw(c, x + 24, top + CHIP_H + 2, w - 48);
      });
      gap(open ? 16 : 10);
    }
    prevKind = kind;
  }
  if (replyY === null) replyY = y;
  gap(18);
  return {h: Math.ceil(y), items, regions, replyY, markY};
}

/** pi-web's tool-card texture: a restrained cross weave over the dark fill. */
function weave(c, x, y, w, h) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.strokeStyle = 'rgba(255,255,255,0.045)'; c.lineWidth = 1;
  for (let i = -h; i < w; i += 10) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i + h * 0.47, y); c.stroke(); }
  c.strokeStyle = 'rgba(0,0,0,0.16)';
  for (let i = 0; i < w + h; i += 12) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i - h * 2.1, y); c.stroke(); }
  c.restore();
}
/** The gold chevron of pi-web's expand toggle. */
function goldChevron(c, x, y, open) {
  c.save(); c.translate(x, y); if (open) c.rotate(Math.PI);
  const g = c.createLinearGradient(-10, 0, 10, 0); g.addColorStop(0, '#7e6a43'); g.addColorStop(0.5, '#d8c18d'); g.addColorStop(1, '#7e6a43');
  c.fillStyle = g; c.beginPath(); c.moveTo(-10, -6); c.lineTo(0, 3); c.lineTo(10, -6); c.lineTo(10, -1); c.lineTo(0, 8); c.lineTo(-10, -1); c.closePath(); c.fill();
  c.restore();
}
/** The streaming caret: a gold bar after the last word. */
function drawCaret(c, lay, x0, top) {
  const L = lay.lines[lay.lines.length - 1]; if (!L) return;
  const f = L.frags[L.frags.length - 1], x = x0 + (f ? f.x + f.w : 0) + 6, y = top + (lay.lines.length - 1) * lay.lineH;
  c.fillStyle = '#e2b15f'; c.fillRect(x, y + lay.lineH * 0.18, 5, lay.lineH * 0.64);
}
function drawMark(c, top) {
  const cy = top + 23;
  c.fillStyle = C.accent; c.globalAlpha = 0.8; c.fillRect(M + 8, cy - 1.5, TURN_W - 2 * M - 16, 3); c.globalAlpha = 1;
  const label = 'New since you looked';
  c.font = font(22, 700);
  const lw = c.measureText(label).width + 30;
  fillRR(c, M + PAD - 6, cy - 17, lw, 34, 17, '#2a2112', C.accent, 2);
  text(c, label, M + PAD - 6 + 15, cy + 1, {size: 22, weight: 700, color: '#ffd58a'});
}

function expandedBody(ctx, m) {
  if (m.type === 'thinking') {
    const lay = layoutRuns(ctx, [{text: m.text, i: true}], INNER - 40, 29, 400, 44);
    return {h: lay.height + 10, draw: (c, x, y) => drawRuns(c, lay, x, y, 29, C.muted)};
  }
  if (m.type === 'edit') {
    const rows = [];
    for (const [k, , ot, nn, nt] of m.rows) {
      if (k === 'same') rows.push([' ', nn, nt]);
      else if (k === 'add') rows.push(['+', nn, nt]);
      else if (k === 'del') rows.push(['-', '', ot]);
      else { rows.push(['-', '', ot]); rows.push(['+', nn, nt]); }
    }
    const rh = 40;
    return {h: rows.length * rh + 18, draw: (c, x, y, w) => {
      fillRR(c, x, y, w, rows.length * rh + 8, 10, '#0a0a0a', '#1e1e1e', 1.5);
      rows.forEach(([sg, no, raw], r) => {
        const ry = y + 4 + r * rh;
        if (sg !== ' ') { c.fillStyle = sg === '+' ? 'rgba(74,222,128,0.13)' : 'rgba(248,113,113,0.13)'; c.fillRect(x + 2, ry, w - 4, rh); }
        text(c, String(no), x + 54, ry + rh / 2, {size: 22, family: MONO, color: C.dim, align: 'right'});
        text(c, sg, x + 74, ry + rh / 2, {size: 25, family: MONO, color: sg === '+' ? '#86efac' : sg === '-' ? '#fca5a5' : C.dim, weight: 700});
        let tx = x + 100;
        for (const [pi, part] of String(raw).split(/\[\[|\]\]/).entries()) {
          if (!part) continue;
          c.font = font(25, 400, MONO);
          const pw = c.measureText(part).width;
          if (pi % 2 === 1) { c.fillStyle = sg === '+' ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)'; c.fillRect(tx - 2, ry + 6, pw + 4, rh - 12); }
          c.fillStyle = '#e5e5e5'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(part, tx, ry + rh / 2); tx += pw;
        }
      });
    }};
  }
  const lines = String(m.body || '').split('\n').slice(0, 14);
  const rh = 38;
  const cmd = m.args?.command || m.args?.path || m.sub || '';
  return {h: (lines.length + 1) * rh + 18, draw: (c, x, y, w) => {
    fillRR(c, x, y, w, (lines.length + 1) * rh + 8, 10, '#0a0a0a', '#1e1e1e', 1.5);
    text(c, `$ ${cmd}`, x + 18, y + 4 + rh / 2, {size: 23, family: MONO, color: '#9fb5aa', maxW: w - 36});
    lines.forEach((ln, r) => text(c, ln, x + 18, y + 4 + (r + 1.5) * rh, {size: 23, family: MONO, color: '#cbd5cf', maxW: w - 36}));
  }};
}

export function drawTurn(c, lay, w) {
  c.clearRect(0, 0, w, lay.h);
  // pi-web's transcript has no cards around messages: a hairline between turns is enough.
  c.fillStyle = '#1c1c1c'; c.fillRect(M + PAD, 2, w - 2 * (M + PAD), 2);
  for (const it of lay.items) it.draw(c, it.y);
}

/** Plain text of the latest assistant reply, for neighbour cards. */
export function lastReplyText(s) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.type === 'assistant') return blocksOf(m).map((b) => b.runs.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
    if (m.type === 'tool' && m.status === 'running') return `${chipText(m)}…`;
  }
  return '';
}
export {ellipsize};
