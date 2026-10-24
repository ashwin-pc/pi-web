// 2D canvas helpers: theme, fonts, icons, rich text layout. Every panel in the scene is a canvas texture.
import {ICONS, LANE_ICONS} from './icons.js';

export const C = {
  bg: '#0b0b0b', panel: '#0e0e0e', panel2: '#151515', panel3: '#1c1c1c', border: '#2a2a2a', borderHi: '#3a3a3a',
  text: '#f2f2f2', muted: '#a3a3a3', dim: '#6f6f6f', faint: '#4a4a4a',
  accent: '#e2b15f', accentDim: '#3a2e18', danger: '#fb7185', green: '#4ade80', blue: '#60a5fa',
  user: '#2a2315', userBorder: '#5a4626', code: '#0a0a0a', codeBorder: '#232323', tool: '#0d1210', toolHead: '#121a16',
};
export const MARKERS = {blue: '#60a5fa', purple: '#c084fc', yellow: '#facc15', red: '#fb7185', green: '#4ade80', orange: '#fb923c', cyan: '#22d3ee', pink: '#f472b6'};
export const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "DejaVu Sans", sans-serif'; // pi-web's font stack
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace'; // pi-web's mono stack
export const font = (px, weight = 400, family = SANS, style = 'normal') => `${style} ${weight} ${Math.round(px)}px ${family}`;

const pathCache = new Map();
const p2d = (d) => { let p = pathCache.get(d); if (!p) { p = new Path2D(d); pathCache.set(d, p); } return p; };

/** Lucide stroke icon centred at (cx, cy) with the given pixel size. */
export function icon(ctx, name, cx, cy, size, color, lineWidth = 2) {
  const paths = ICONS[name];
  if (!paths) return;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of paths) ctx.stroke(p2d(d));
  ctx.restore();
}

/** Filled lane icon (pin, parked bars, bookmark) centred at (cx, cy). */
export function laneIcon(ctx, lane, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 16, size / 16);
  ctx.fillStyle = color;
  ctx.fill(p2d(LANE_ICONS[lane]), 'evenodd');
  ctx.restore();
}

export function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
export function fillRR(ctx, x, y, w, h, r, fill, stroke, lw = 2) {
  rr(ctx, x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
export function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Truncate with an ellipsis so text fits maxW at the current font. */
export function ellipsize(ctx, text, maxW) {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

export function text(ctx, str, x, y, {size = 28, weight = 400, color = C.text, align = 'left', family = SANS, maxW = 0, style = 'normal', baseline = 'middle'} = {}) {
  ctx.font = font(size, weight, family, style);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  const s = maxW ? ellipsize(ctx, str, maxW) : str;
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}
export function measure(ctx, str, size = 28, weight = 400, family = SANS) {
  ctx.font = font(size, weight, family);
  return ctx.measureText(str).width;
}

/** Parse the fixtures' small HTML subset (h2, p, ul/ol/li, strong, em, code) into blocks of styled runs. */
export function parseHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const blocks = [];
  const runsOf = (node, style = {}) => {
    const out = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { const t = child.textContent.replace(/\s+/g, ' '); if (t) out.push({text: t, ...style}); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      const next = {...style};
      if (tag === 'STRONG' || tag === 'B') next.b = true;
      if (tag === 'EM' || tag === 'I') next.i = true;
      if (tag === 'CODE') next.code = true;
      out.push(...runsOf(child, next));
    }
    return out;
  };
  for (const el of doc.body.children) {
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      [...el.children].forEach((li, i) => blocks.push({type: 'li', ordered: tag === 'OL', index: i + 1, runs: runsOf(li)}));
    } else if (/^H[1-4]$/.test(tag)) blocks.push({type: 'h', runs: runsOf(el)});
    else blocks.push({type: 'p', runs: runsOf(el)});
  }
  if (!blocks.length && doc.body.textContent.trim()) blocks.push({type: 'p', runs: [{text: doc.body.textContent}]});
  return blocks;
}

const runFont = (run, size, weight) => run.code ? font(size * 0.86, 500, MONO) : font(size, run.b ? 700 : weight, SANS, run.i ? 'italic' : 'normal');

/** Word-wrap styled runs into lines. Returns {lines: [{frags: [{text, x, w, run}]}], lineH, height}. */
export function layoutRuns(ctx, runs, maxW, size, weight = 400, lineH = size * 1.45) {
  const lines = [];
  let frags = [], x = 0;
  const push = () => { lines.push({frags}); frags = []; x = 0; };
  for (const run of runs) {
    ctx.font = runFont(run, size, weight);
    const pad = run.code ? size * 0.28 : 0;
    const tokens = run.text.split(/(\s+)/).filter(Boolean);
    for (let tok of tokens) {
      const isSpace = /^\s+$/.test(tok);
      if (isSpace && x === 0) continue;
      let w = ctx.measureText(tok).width + (isSpace ? 0 : pad * 2);
      if (!isSpace && x + w > maxW && x > 0) { push(); }
      if (!isSpace && w > maxW) {
        // Hard-break a very long token.
        while (tok.length && ctx.measureText(tok).width + pad * 2 > maxW) {
          let n = tok.length;
          while (n > 1 && ctx.measureText(tok.slice(0, n)).width + pad * 2 > maxW) n--;
          frags.push({text: tok.slice(0, n), x, w: ctx.measureText(tok.slice(0, n)).width + pad * 2, run, pad});
          push();
          tok = tok.slice(n);
        }
        w = ctx.measureText(tok).width + pad * 2;
      }
      if (!tok) continue;
      frags.push({text: tok, x, w, run, pad: isSpace ? 0 : pad});
      x += w;
    }
  }
  if (frags.length) push();
  return {lines, lineH, height: lines.length * lineH};
}

export function drawRuns(ctx, layout, x0, y0, size, color = C.text, weight = 400) {
  let y = y0;
  for (const line of layout.lines) {
    const cy = y + layout.lineH / 2;
    for (const f of line.frags) {
      if (/^\s+$/.test(f.text)) continue;
      ctx.font = runFont(f.run, size, weight);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      if (f.run.code) {
        fillRR(ctx, x0 + f.x + 1, cy - size * 0.62, f.w - 2, size * 1.24, size * 0.22, '#131313', '#242424', 1.5);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(f.text, x0 + f.x + f.pad, cy + 1);
      } else {
        ctx.fillStyle = color;
        ctx.fillText(f.text, x0 + f.x, cy + 1);
      }
    }
    y += layout.lineH;
  }
  return y;
}

/** A tiny tokenizer good enough to colour the fixtures' TS / Rust / CSS snippets. */
const KW = /\b(const|let|var|function|return|export|import|from|async|await|if|else|for|new|fn|format|true|false|null|type)\b/;
export function codeTokens(line) {
  const out = [];
  const re = /(\/\/.*$)|("[^"]*"|'[^']*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][\w]*\b(?=\())|(\b[A-Za-z_]\w*\b)|(\s+)|(.)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) out.push([m[1], '#6b7280']);
    else if (m[2]) out.push([m[2], '#a5d6a7']);
    else if (m[3]) out.push([m[3], '#7dd3fc']);
    else if (m[4]) out.push([m[4], '#93c5fd']);
    else if (m[5]) out.push([m[5], KW.test(m[5]) && m[5].match(KW)[0] === m[5] ? '#f0abfc' : '#e5e7eb']);
    else out.push([m[0], '#d4d4d4']);
  }
  return out;
}
