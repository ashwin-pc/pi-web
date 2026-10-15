// Artifact content, drawn into a canvas at any size, in pi-web's palette. drawArtifact(ctx, art, W, H, t) fills the
// whole canvas. Ported from the mock's procedural version: the same kinds, layout and styles, but the content is the
// real file, loaded through the client (host.loadArtifact, see ../artifactContent.ts) and cached per artifact. While it
// loads the panel shows "Loading"; HTML (which WebGL cannot draw) is a card with "Open in 2D".
import {C, SANS, MONO, font, fillRR, text, icon} from './draw.js';
import {wrapLines} from './views.js';
import {host} from './host.js';

export const KIND = {
  image: {label: 'Image', icon: 'image', color: '#8fb8ff'}, markdown: {label: 'Report', icon: 'file-text', color: '#e8e8e8'},
  diff: {label: 'Diff', icon: 'git-compare', color: '#7ee2a8'}, diagram: {label: 'Diagram', icon: 'workflow', color: '#e2b15f'},
  html: {label: 'HTML app', icon: 'app-window', color: '#c4a7ff'}, video: {label: 'Video', icon: 'film', color: '#fb7185'},
  model: {label: '3D model', icon: 'box', color: '#f0c27a'},
  audio: {label: 'Audio', icon: 'play', color: '#c4a7ff'}, other: {label: 'File', icon: 'file-text', color: '#a3a3a3'},
};

// ------------------------------------------------------------------ live content: loaded once per artifact
const cache = new Map(); // id -> {state: 'loading' | 'ready' | 'error', content, reason}
const listeners = new Set();
let version = 0;
/** Called when any artifact's content arrives (panels re-raster). Returns an unsubscribe function. */
export function onArtifactContent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Kinds whose thumbnails need the content; video and model thumbnails are drawn without loading the file. */
const THUMB_LOADS = new Set(['image', 'markdown', 'diff', 'diagram']);
export function contentOf(a, load = true) {
  let e = cache.get(a.id);
  if (!e && load && host.loadArtifact) {
    e = {state: 'loading'}; cache.set(a.id, e);
    host.loadArtifact(a).then((content) => {
      if (content.kind === 'unavailable') Object.assign(e, {state: 'error', reason: content.reason}); else Object.assign(e, {state: 'ready', content});
    }, (err) => Object.assign(e, {state: 'error', reason: String(err?.message || err)})).finally(() => { version++; for (const fn of [...listeners]) fn(a); });
  }
  return e || null;
}
/** Forget loaded content (videos are paused and released). */
export function releaseArtifacts() { for (const e of cache.values()) e.content?.release?.(); cache.clear(); thumbs.clear(); }

function card(c, a, W, H, title, note, accent = C.muted) {
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  const k = Math.min(W / 1400, H / 900), K = KIND[a.kind] || KIND.other;
  icon(c, K.icon, W / 2, H * 0.36, 96 * k, K.color, 2.4);
  text(c, title, W / 2, H * 0.36 + 110 * k, {size: 40 * k, weight: 700, align: 'center', maxW: W * 0.86});
  c.font = font(28 * k);
  wrapLines(c, note, W * 0.8, 3).forEach((ln, i) => text(c, ln, W / 2, H * 0.36 + (170 + i * 40) * k, {size: 28 * k, color: accent, align: 'center'}));
}
const loading = (c, a, W, H) => card(c, a, W, H, a.name, 'Loading…');

function image(c, a, W, H, e) {
  c.fillStyle = '#050505'; c.fillRect(0, 0, W, H);
  const im = e.content.image, s = Math.min(W / im.width, H / im.height);
  c.drawImage(im, (W - im.width * s) / 2, (H - im.height * s) / 2, im.width * s, im.height * s);
}
/** Markdown as the mock drew its reports: headings, bullets, paragraphs (code fences shown as plain lines). */
function mdLines(src) {
  const out = [];
  for (const raw of src.split('\n')) {
    const ln = raw.replace(/\s+$/, ''); if (!ln.trim() || /^```/.test(ln)) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(ln), li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(ln);
    const inline = (t) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
    out.push(h ? `${h[1].length === 1 ? '#' : '##'} ${inline(h[2])}` : li ? `- ${inline(li[1])}` : inline(ln));
  }
  return out;
}
function markdown(c, a, W, H, e) {
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  const k = W / 1000, lines = mdLines(e.content.text);
  let y = 70 * k;
  for (const ln of lines) {
    const h1 = ln.startsWith('# '), h2 = ln.startsWith('## '), li = ln.startsWith('- ');
    const size = (h1 ? 46 : h2 ? 34 : 28) * k, t = ln.replace(/^#+ |^- /, '');
    c.font = font(size, h1 || h2 ? 700 : 400);
    for (const w of wrapLines(c, t, W - (li ? 120 : 90) * k, 3)) {
      if (li) { c.beginPath(); c.arc(56 * k, y, 6 * k, 0, Math.PI * 2); c.fillStyle = C.accent; c.fill(); }
      text(c, w, (li ? 80 : 45) * k, y, {size, weight: h1 || h2 ? 700 : 400, color: h1 ? '#f2f2f2' : h2 ? C.accent : '#d8d8d8'}); y += size * 1.45;
    }
    y += (h1 || h2 ? 12 : 6) * k;
    if (y > H - 40 * k) break;
  }
}
/** A unified diff: the first file's header, then its lines with + / − colouring. */
function diffRows(src) {
  const rows = []; let file = '', add = 0, del = 0;
  for (const ln of src.split('\n')) {
    if (ln.startsWith('+++ ')) { file ||= ln.slice(4).replace(/^b\//, ''); continue; }
    if (ln.startsWith('--- ') || ln.startsWith('diff ') || ln.startsWith('index ')) continue;
    if (ln.startsWith('@@')) { rows.push(['@', ln]); continue; }
    const m = ln[0] === '+' || ln[0] === '-' ? ln[0] : ' ';
    if (m === '+') add++; else if (m === '-') del++;
    rows.push([m, m === ' ' ? ln.slice(ln[0] === ' ' ? 1 : 0) : ln.slice(1)]);
  }
  return {rows, file, add, del};
}
function diff(c, a, W, H, e) {
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  const k = W / 1200, lh = 40 * k, d = diffRows(e.content.text);
  fillRR(c, 0, 0, W, 64 * k, 0, '#131313'); text(c, d.file || a.name, 24 * k, 32 * k, {size: 26 * k, family: MONO, weight: 700, maxW: W - 240 * k});
  text(c, `+${d.add} −${d.del}`, W - 24 * k, 32 * k, {size: 24 * k, family: MONO, color: '#7ee2a8', align: 'right'});
  d.rows.slice(0, Math.max(1, Math.floor((H - 90 * k) / lh) + 1)).forEach(([m, ln], i) => {
    const y = 90 * k + i * lh;
    if (m === '+' || m === '-') { c.fillStyle = m === '+' ? 'rgba(126,226,168,0.12)' : 'rgba(251,113,133,0.13)'; c.fillRect(0, y - lh / 2, W, lh); }
    text(c, m === '@' ? '' : m, 24 * k, y, {size: 26 * k, family: MONO, color: m === '+' ? '#7ee2a8' : m === '-' ? '#fb7185' : C.dim});
    text(c, ln, 60 * k, y, {size: 24 * k, family: MONO, color: m === '@' ? '#8fb8ff' : '#d8d8d8', maxW: W - 84 * k});
  });
}
/** Nodes and edges of a Mermaid flowchart (`A[Label] --> B`, `A -->|x| B`, `A --- B`), or null if it is not one. */
export function parseFlowchart(src) {
  const ids = new Map(), nodes = [], edges = [];
  const node = (tok) => {
    const m = /^\s*([\w.-]+)\s*(?:\[\(?|\(\(?|\{\{?|>)?\s*"?([^\]\)\}"]*)"?\s*(?:\)?\]|\)?\)|\}?\}|)?\s*$/.exec(tok);
    if (!m) return -1;
    if (!ids.has(m[1])) { ids.set(m[1], nodes.length); nodes.push(m[2]?.trim() || m[1]); }
    else if (m[2]?.trim()) nodes[ids.get(m[1])] = m[2].trim();
    return ids.get(m[1]);
  };
  for (const raw of src.split('\n')) {
    const ln = raw.trim();
    if (!ln || /^(graph|flowchart|%%|style|classDef|class|linkStyle|subgraph|end)\b/.test(ln)) continue;
    const parts = ln.split(/\s*(?:-->|---|-\.->|==>|--[^-]+-->)\s*(?:\|[^|]*\|)?\s*/);
    if (parts.length < 2) { node(ln); continue; }
    const at = parts.map(node);
    for (let i = 1; i < at.length; i++) if (at[i - 1] >= 0 && at[i] >= 0) edges.push([at[i - 1], at[i]]);
  }
  return edges.length ? {nodes, edges} : null;
}
/** A mermaid-style flowchart: nodes in layers (longest path), rounded boxes, arrows with heads. */
function diagram(c, a, W, H, e) {
  const g = parseFlowchart(e.content.text);
  if (!g) { markdown(c, a, W, H, {content: {text: '```\n' + e.content.text}}); return; }
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  const k = W / 1400, n = g.nodes.length, layer = new Array(n).fill(0);
  for (let it = 0; it < n; it++) for (const [f, t] of g.edges) if (t > f && layer[t] < layer[f] + 1) layer[t] = layer[f] + 1;
  const L = Math.max(...layer) + 1, rows = Array.from({length: L}, (_, i) => layer.map((l, j) => [l, j]).filter(([l]) => l === i).map(([, j]) => j));
  const pos = [], bw = 260 * k, bh = 84 * k;
  rows.forEach((r, i) => r.forEach((j, q) => { pos[j] = {x: W * (q + 1) / (r.length + 1), y: 70 * k + (H - 140 * k) * (L === 1 ? 0.5 : i / (L - 1))}; }));
  c.lineWidth = 3 * k;
  for (const [f, t] of g.edges) {
    const p = pos[f], q = pos[t], back = layer[t] <= layer[f];
    c.strokeStyle = back ? '#8fb8ff' : '#8a6a36'; c.fillStyle = c.strokeStyle;
    const sy = p.y + (back ? -bh / 2 : bh / 2), ty = q.y + (back ? bh / 2 : -bh / 2), sx = p.x + (back ? bw * 0.3 : 0), tx = q.x + (back ? bw * 0.3 : 0);
    c.beginPath(); c.moveTo(sx, sy); c.bezierCurveTo(sx, (sy + ty) / 2, tx, (sy + ty) / 2, tx, ty); c.stroke();
    const dir = ty > sy ? 1 : -1; c.beginPath(); c.moveTo(tx, ty); c.lineTo(tx - 10 * k, ty - 16 * k * dir); c.lineTo(tx + 10 * k, ty - 16 * k * dir); c.fill();
  }
  g.nodes.forEach((nm, j) => { const p = pos[j]; fillRR(c, p.x - bw / 2, p.y - bh / 2, bw, bh, 18 * k, '#14110b', j === 0 ? C.accent : '#5a4a2a', 3 * k); text(c, nm, p.x, p.y, {size: 30 * k, weight: 700, align: 'center', maxW: bw - 20 * k}); });
}
/** HTML cannot be drawn into WebGL: a card that says so, with "Open in 2D" (the panel's header button). */
function html(c, a, W, H) { card(c, a, W, H, a.name, "HTML can't be drawn in VR. Use Open in 2D to view and interact with it in pi-web.", '#c4a7ff'); }
/** A video: the current frame of the real file, and a timeline. */
function video(c, a, W, H, e) {
  const k = W / 1600, v = e.content.video;
  c.fillStyle = '#050505'; c.fillRect(0, 0, W, H);
  const vh = H - 80 * k;
  if (v.videoWidth) { const s = Math.min(W / v.videoWidth, vh / v.videoHeight); c.drawImage(v, (W - v.videoWidth * s) / 2, (vh - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s); }
  const d = v.duration || 0, u = d ? v.currentTime / d : 0;
  c.fillStyle = '#222'; c.fillRect(40 * k, H - 44 * k, W - 80 * k, 8 * k); c.fillStyle = C.accent; c.fillRect(40 * k, H - 44 * k, (W - 80 * k) * u, 8 * k);
  icon(c, 'play', 30 * k, H - 90 * k + 30 * k, 26 * k, '#f2f2f2', 2.4); text(c, `${v.currentTime.toFixed(1)} / ${d.toFixed(1)} s`, 60 * k, H - 60 * k, {size: 22 * k, color: C.muted, family: MONO});
}
/** The 3D part as a flat drawing (thumbnails, and the panel behind the pedestal). */
function modelThumb(c, a, W, H) {
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.32;
  c.fillStyle = '#3a2f1a'; c.beginPath(); c.ellipse(cx, cy + r * 0.35, r, r * 0.45, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8a6a36'; c.fillRect(cx - r, cy - r * 0.2, r * 2, r * 0.55);
  c.fillStyle = C.accent; c.beginPath(); c.ellipse(cx, cy - r * 0.2, r, r * 0.45, 0, 0, Math.PI * 2); c.fill();
  for (let i = 0; i < 12; i++) { const an = i / 12 * Math.PI * 2; c.fillStyle = '#5a4a2a'; c.fillRect(cx + Math.cos(an) * r * 0.8 - 3, cy - r * 0.2 + Math.sin(an) * r * 0.36 - 3, 6, 6); }
}
function videoThumb(c, a, W, H) { c.fillStyle = '#050505'; c.fillRect(0, 0, W, H); icon(c, 'film', W / 2, H / 2, Math.min(W, H) * 0.4, KIND.video.color, 2.2); }
export function drawArtifact(c, a, W, H, t = 0, {thumb = false} = {}) {
  if (a.kind === 'html') return html(c, a, W, H);
  if (a.kind === 'model') return modelThumb(c, a, W, H);
  if (a.kind === 'audio' || a.kind === 'other') return card(c, a, W, H, a.name, 'No preview in VR. Use Open in 2D.');
  if (thumb && a.kind === 'video' && contentOf(a, false)?.state !== 'ready') return videoThumb(c, a, W, H);
  const e = contentOf(a, !thumb || THUMB_LOADS.has(a.kind));
  if (!e || e.state === 'loading') return loading(c, a, W, H);
  if (e.state === 'error') return card(c, a, W, H, a.name, e.reason || 'Could not load it.', C.danger);
  if (a.kind === 'image') return image(c, a, W, H, e);
  if (a.kind === 'markdown') return markdown(c, a, W, H, e);
  if (a.kind === 'diff') return diff(c, a, W, H, e);
  if (a.kind === 'diagram') return diagram(c, a, W, H, e);
  if (a.kind === 'video') return video(c, a, W, H, e);
  return card(c, a, W, H, a.name, 'No preview in VR.');
}
/** Natural aspect (width / height) of each kind's full view (images and videos: their real size, once loaded). */
export const aspectOf = (a) => {
  const e = cache.get(a.id), im = e?.state === 'ready' ? e.content.image : null, v = e?.state === 'ready' ? e.content.video : null;
  if (a.kind === 'image') return im ? im.width / im.height : 1.6;
  if (a.kind === 'video') return v?.videoWidth ? v.videoWidth / v.videoHeight : 1.78;
  return a.kind === 'markdown' ? 0.8 : a.kind === 'diff' ? 1.25 : a.kind === 'diagram' ? 1.4 : a.kind === 'html' ? 1.45 : 1.3;
};
/** A thumbnail with the kind's frame (cached per artifact, size and content version). */
const thumbs = new Map();
export function drawThumb(c, a, x, y, w, h) {
  const e = cache.get(a.id), key = `${a.id}|${w}|${h}|${e?.state || 'none'}`;
  let cv = thumbs.get(key);
  if (!cv) { cv = document.createElement('canvas'); const s = 3; const ar = aspectOf(a); cv.width = Math.round(Math.max(w, h * ar) * s); cv.height = Math.round(cv.width / ar); drawArtifact(cv.getContext('2d'), a, cv.width, cv.height, 0, {thumb: true}); if (cache.get(a.id)?.state === 'ready' || !THUMB_LOADS.has(a.kind)) thumbs.set(key, cv); }
  c.save(); fillRR(c, x, y, w, h, 10, '#0b0b0b', '#2c2c2c', 2); c.beginPath(); c.rect(x + 2, y + 2, w - 4, h - 4); c.clip();
  const sc = Math.max(w / cv.width, h / cv.height); c.drawImage(cv, x + (w - cv.width * sc) / 2, y + (h - cv.height * sc) / 2, cv.width * sc, cv.height * sc); c.restore();
}
export const contentVersion = () => version;
export {SANS};
