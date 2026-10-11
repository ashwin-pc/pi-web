// Text for the live cards and the bar's unread previews: whole sentences, wrapped by whole words, never cut mid-word.
import {parseHtml} from './draw.js';
import {chipLabel} from './turns.js';

const cache = new WeakMap();
export function plainOf(m) {
  if (m.type !== 'assistant') return '';
  const c = cache.get(m);
  if (c && c.len === m.html.length) return c.text;
  const text = parseHtml(m.html).map((b) => b.runs.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
  cache.set(m, {len: m.html.length, text});
  return text;
}
export const sentences = (t) => t.split(/(?<=[.!?:])\s+(?=[A-Z0-9"“(`])/).map((x) => x.trim()).filter(Boolean);

/** What a running session's live card shows: its current tool card, or the newest sentence it is writing. */
export function liveLine(s) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.type === 'tool' || m.type === 'edit') {
      if (m.status === 'running') { const l = chipLabel(m); return {tool: true, running: true, name: l.name, sum: l.sum}; }
      continue;
    }
    if (m.type === 'thinking') return {tool: true, running: false, name: 'Thinking', sum: m.heading};
    if (m.type === 'assistant') { const ss = sentences(plainOf(m)); return {tool: false, text: ss[ss.length - 1] || '', streaming: !!m.streaming}; }
    if (m.type === 'user') return {tool: false, text: m.text};
  }
  return {tool: false, text: ''};
}

/** The unread preview: the reply's last sentence that asks something or says Changed / Fixed / Finished, else its
 * first sentence; then more sentences until it is at least 80 characters (or the reply ends). */
export function previewText(s) {
  let reply = null;
  for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].type === 'assistant') { reply = s.messages[i]; break; }
  if (!reply) return '';
  const ss = sentences(plainOf(reply));
  if (!ss.length) return '';
  let i = -1;
  for (let k = ss.length - 1; k >= 0; k--) if (/\?|\b(Changed|Fixed|Finished)\b/.test(ss[k])) { i = k; break; }
  if (i < 0) i = 0;
  let t = ss[i];
  for (let k = i + 1; t.length < 80 && k < ss.length; k++) t += ' ' + ss[k];
  for (let k = i - 1; t.length < 80 && k >= 0; k--) t = ss[k] + ' ' + t;
  return t;
}
/** Does the latest reply ask the user something? (needs attention even when read) */
export function asksQuestion(s) {
  for (let i = s.messages.length - 1; i >= 0; i--) { const m = s.messages[i]; if (m.type === 'user') return false; if (m.type === 'assistant') return /\?\s*$/.test(plainOf(m)); }
  return false;
}

/** Wrap whole words into at most n lines at the current font. mode 'head' keeps the start (ends with "…" after a
 * whole word if it does not fit); 'tail' keeps the end (starts with "…"), for a sentence still being written. */
export function wrapWhole(ctx, text, maxW, n, mode = 'head') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const fit = (ws) => {
    const lines = []; let cur = '';
    for (const w of ws) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    return lines;
  };
  let lines = fit(words);
  if (lines.length <= n) return {lines, shown: words.join(' ').length, total: words.join(' ').length, cut: false};
  if (mode === 'tail') {
    let k = words.length - 1;
    while (k > 0 && fit(['…', ...words.slice(k - 1)]).length <= n) k--;
    lines = fit(['…', ...words.slice(k)]);
    return {lines, shown: words.slice(k).join(' ').length, total: words.join(' ').length, cut: true};
  }
  let k = words.length;
  while (k > 1 && fit([...words.slice(0, k), '…']).length > n) k--;
  lines = fit([...words.slice(0, k)]);
  lines[lines.length - 1] += ' …';
  return {lines, shown: words.slice(0, k).join(' ').length, total: words.join(' ').length, cut: true};
}

/** Wrap whole words into lines of the given widths (one width per line), keeping the newest words: when the text does
 * not fit, the oldest words are dropped (whole words, marked by a leading "…"), never a cut word. */
export function wrapNewest(ctx, text, widths) {
  const words = String(text).split(/\s+/).filter(Boolean), total = words.join(' ').length;
  const fit = (ws) => {
    const lines = []; let cur = '';
    for (const w of ws) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width <= widths[Math.min(lines.length, widths.length - 1)] || !cur) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    return lines;
  };
  let lines = fit(words);
  if (lines.length <= widths.length) return {lines, shown: total, total, dropped: 0};
  let k = 1;
  while (k < words.length - 1 && fit(['…', ...words.slice(k)]).length > widths.length) k++;
  lines = fit(['…', ...words.slice(k)]);
  return {lines, shown: words.slice(k).join(' ').length, total, dropped: k};
}
