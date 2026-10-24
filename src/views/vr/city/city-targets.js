// What each session is doing in the city: where its beam lands, today's heat, flares and scans, and lineage.
// Pure-ish (no three.js meshes): the City reads these and draws them.
import {S, get, indicator, waitingCount} from './state.js';
import {currentTarget, touchedFiles, toolPath} from './activity.js';
import {ensureFile, HOME} from './city-tree.js';
import {blockFor} from './city-layout.js';

export const HOUR = 36e5;
/** Every file any session touches must be on the map before it is laid out. */
export function ensureTouched(land, sessions) {
  for (const s of sessions) {
    for (const p of touchedFiles(s).files) if (p.startsWith(HOME + '/')) ensureFile(land, p);
  }
}
/** Where a session's beam lands now: {x, y, z, kind, path, block, building, tool} in city metres, or null. */
export function beamTarget(city, s) {
  const L = city.L, land = city.land, k = indicator(s);
  if (k !== 'running' && k !== 'waiting') return null;
  let t;
  if (k === 'running') t = currentTarget(s);
  else {
    const files = touchedFiles(s).files;
    t = files.length ? {path: files[files.length - 1], kind: 'wait', dir: false} : {path: s.cwd, kind: 'wait', dir: true};
  }
  if (!t) return null;
  let g = !t.dir ? L.byFile.get(t.path) : null;
  // A plain command touches no file, but often names one ("playwright test drawer-focus", "migrate:ledger"): the
  // beam lands on that building if its name is in the session's folder; otherwise on the folder's block.
  if (!g && t.kind === 'bash' && t.msg) g = fileNamed(city, s.cwd, t.msg.args?.command || t.msg.sub || '');
  if (g) return {x: g.x, y: g.base + g.h, z: g.z, kind: t.kind, path: t.path, building: g.idx, block: g.block, tool: t.tool, waiting: k === 'waiting'};
  const b = blockFor(L, land, t.dir ? t.path : t.path.split('/').slice(0, -1).join('/'));
  const r = b.rect;
  return {x: (r.x0 + r.x1) / 2, y: b.y, z: (r.z0 + r.z1) / 2, kind: t.kind, path: t.path, block: b.id, building: -1, tool: t.tool, waiting: k === 'waiting', blockRect: r};
}
function fileNamed(city, cwd, cmd) {
  if (!city.names) { city.names = new Map(); for (const g of city.L.buildings) { const k = g.file.name.replace(/\.(spec|test)?\.?[^.]+$/, '').toLowerCase(); if (!city.names.has(k)) city.names.set(k, []); city.names.get(k).push(g); } }
  const toks = cmd.split(/[\s=]+/).flatMap((x) => [x.replace(/:/g, '-'), ...x.split(':')]).map((x) => x.replace(/^[-.\/]+|["']/g, '').toLowerCase()).filter((x) => x.length >= 5 && !/^(test|tests|run|npm|npx|node|playwright|reporter|dry-run|trace|accounts|snapshot|break|seq)$/.test(x));
  for (const k of toks.reverse()) {
    const hits = (city.names.get(k) || city.names.get(k.replace(/-/g, '')) || []).filter((g) => g.path.startsWith(cwd + '/'));
    if (hits.length) return hits[0];
  }
  return null;
}
/** When each file was last edited (ms since epoch), from the sessions' edit and write tools, plus the synthetic list of
 * files the client reports as modified in the last hour (files.tree mtime). Heat fades over the hour. */
export function editTimes(city, sessions, now = Date.now()) {
  const at = new Map();
  const put = (p, t) => { if (city.L.byFile.has(p) && (!at.has(p) || at.get(p) < t)) at.set(p, t); };
  for (const s of sessions) {
    const n = s.messages.length;
    s.messages.forEach((m, i) => {
      const t = toolPath(s, m);
      if (!t || t.dir || t.kind !== 'edit') return;
      put(t.path, m.status === 'running' ? now : s.touched - (n - 1 - i) * 90e3);
    });
  }
  // Files the client reports as modified in the last hour (their mtime), whoever edited them.
  for (const f of city.land.files.values()) if (f.mtime && now - f.mtime < HOUR) put(f.path, f.mtime);
  return at;
}
export const heatOf = (t, now = Date.now()) => (t == null ? 0 : Math.max(0, 1 - (now - t) / HOUR));
/** Running workers of a waiting parent (for the lineage arcs). */
export function workersOf(s) { const out = []; for (const o of S.sessions.values()) if (o.origin === s.id && o.running && S.pinned.includes(o.id)) out.push(o.id); return out; }
export {get, indicator, waitingCount};
