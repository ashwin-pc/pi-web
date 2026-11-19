// The city layout: a nested squarified treemap of the file tree, as a "code city". Pure (no three.js), so node can
// test it: every directory is a block, no blocks overlap, one building per file, height monotonic in line count.
//
// Coordinates: metres; x east, z south (toward the mayor's default vantage), y up. City hall stands at the origin on
// the civic plaza. North of the plaza runs the cross avenue: its west half is ~/oss, its east half ~/work. Each
// workspace root is a district north of its avenue, laid out as nested blocks: one plinth step higher per depth,
// streets between siblings, and buildings (files) on the blocks.
import {squarify, inset, rw, rd} from './treemap.js';
import {walk, total} from './city-tree.js';

/** Building footprint side (m) from bytes, and height (m) from lines. Both strictly increasing. */
export const footOf = (bytes) => Math.min(20, 2.4 + 1.6 * Math.log2(1 + Math.max(0, bytes) / 600));
export const heightOf = (lines) => 3 + 22 * Math.log10(1 + Math.max(0, lines) / 10);
const lotOf = (f) => (footOf(f.bytes) + 1.7) ** 2;
/** Street width (m) between sibling blocks at a depth inside the district (0 = the district itself). */
export const streetOf = (rel) => [8, 5, 3.4, 2.6, 2.1, 1.8][Math.min(5, rel)];
export const PLINTH = 0.7; // metres per depth step
export const plinthTop = (rel) => PLINTH * (rel + 1);
const EDGE = 1.1; // kerb inside each block before its contents

/** The area a directory needs (m²), from its files' lots and its children's areas, with streets. */
function areaOf(n, rel, memo) {
  if (memo.has(n)) return memo.get(n);
  let a = n.files.reduce((s, f) => s + lotOf(f), 0);
  for (const d of n.dirs) { const c = areaOf(d, rel + 1, memo); const side = Math.sqrt(c) + streetOf(rel + 1); a += side * side; }
  const side = Math.sqrt(Math.max(a, 20)) + 2 * EDGE;
  const A = side * side;
  memo.set(n, A);
  return A;
}

export const CIVIC = {hall: {x: 0, z: -4, w: 34, d: 30, h: 46}, plaza: {x0: -70, z0: -30, x1: 70, z1: 30}, avenueZ: [-50, -34], boulevard: {x0: -9, x1: 9, z0: -34, z1: -30}};

/** Lay out the whole city. Returns {blocks, buildings, districts, avenues, hall, bounds, byPath, byFile, centroid}. */
export function layoutCity(land) {
  const L = {blocks: [], buildings: [], districts: [], avenues: [], byPath: new Map(), byFile: new Map()};
  const memo = new Map();
  const root = land.root;
  const AZ = CIVIC.avenueZ;
  // Districts north of the avenue: oss to the west of the boulevard, work to the east, the first nearest the middle.
  root.dirs.filter((d) => d.kind === 'avenue').forEach((lane, li) => {
    const side = li % 2 === 0 ? -1 : 1; // the first avenue runs west of city hall, the second east
    let edge = side * 14;
    const av = {id: lane.path, node: lane, side, x0: 0, x1: 0, z0: AZ[0], z1: AZ[1], districts: []};
    for (const e of lane.dirs.filter((d) => d.kind === 'district')) {
      const A = areaOf(e, 0, memo), w = Math.sqrt(A) * 1.08, d = A / w;
      const rect = side < 0 ? {x0: edge - w, x1: edge, z0: AZ[0] - 10 - d, z1: AZ[0] - 10} : {x0: edge, x1: edge + w, z0: AZ[0] - 10 - d, z1: AZ[0] - 10};
      edge = side < 0 ? rect.x0 - 26 : rect.x1 + 26;
      const dist = {id: e.path, node: e, name: e.name, rect, side,
        tower: {x: side < 0 ? rect.x1 - 9 : rect.x0 + 9, z: rect.z1 + 4.5, h: Math.round(48 + Math.min(60, total(e) / 25))}}; // at the entrance, facing city hall
      L.districts.push(dist); av.districts.push(e.path);
      layBlock(e, rect, 0, L, memo, e.name);
    }
    av.x0 = side < 0 ? edge + 10 : 9; av.x1 = side < 0 ? -9 : edge - 10;
    L.avenues.push(av);
  });
  // The civic plaza: city hall in the middle, the home folders as small blocks on either side.
  const hall = {...CIVIC.hall, id: root.path, node: root, kind: 'hall'};
  L.hall = hall;
  const homeBlock = {id: root.path, node: root, rect: CIVIC.plaza, rel: -1, y: 0.25, kind: 'home', district: '~'};
  L.blocks.push(homeBlock); L.byPath.set(root.path, homeBlock);
  const extras = root.dirs.filter((d) => d.kind === 'dir');
  const sides = [{x0: -66, x1: -24, z0: -26, z1: 26}, {x0: 24, x1: 66, z0: -26, z1: 26}];
  const halves = [extras.filter((_, i) => i % 2 === 0), extras.filter((_, i) => i % 2 === 1)];
  halves.forEach((list, k) => {
    if (!list.length) return;
    const rects = squarify(list.map((d) => ({w: areaOf(d, 0, memo)})), sides[k], 0.05);
    list.forEach((d, i) => layBlock(d, inset(rects[i], 2.2), 0, L, memo, '~'));
  });
  // Bounds and the centroid of the built area (where the default view looks).
  const b = {x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity};
  for (const k of L.blocks) { b.x0 = Math.min(b.x0, k.rect.x0); b.z0 = Math.min(b.z0, k.rect.z0); b.x1 = Math.max(b.x1, k.rect.x1); b.z1 = Math.max(b.z1, k.rect.z1); }
  L.bounds = b;
  let cx = 0, cz = 0, wsum = 0;
  for (const g of L.buildings) { const w = g.w * g.d; cx += g.x * w; cz += g.z * w; wsum += w; }
  L.centroid = {x: cx / wsum, z: cz / wsum};
  return L;
}

function layBlock(n, rect, rel, L, memo, district) {
  const blk = {id: n.path, node: n, rect, rel, y: plinthTop(rel), kind: rel === 0 && n.kind === 'district' ? 'district' : 'block', district, files: n.files.length, total: total(n)};
  L.blocks.push(blk); L.byPath.set(n.path, blk);
  const inner = inset(rect, EDGE);
  const items = [];
  if (n.files.length) items.push({kind: 'files', w: n.files.reduce((s, f) => s + lotOf(f), 0)});
  for (const d of n.dirs) { const side = Math.sqrt(areaOf(d, rel + 1, memo)) + streetOf(rel + 1); items.push({kind: 'dir', node: d, w: side * side}); }
  const rects = squarify(items, inner, 0.004);
  items.forEach((it, i) => {
    if (it.kind === 'dir') layBlock(it.node, inset(rects[i], streetOf(rel + 1) / 2), rel + 1, L, memo, district);
    else layFiles(n.files, rects[i], blk, L);
  });
  // The block's street sign: at the middle of its south (front) edge, on the kerb.
  blk.sign = {x: (rect.x0 + rect.x1) / 2, z: rect.z1 - 1, y: blk.y};
}

function layFiles(files, r, blk, L) {
  const order = files.map((f, i) => ({f, i, w: lotOf(f)}));
  const rects = squarify(order, r, 0);
  order.forEach(({f}, k) => {
    const c = rects[k], foot = footOf(f.bytes);
    const w = Math.max(0.6, Math.min(foot, rw(c) - 1.2)), d = Math.max(0.6, Math.min(foot, rd(c) - 1.2));
    const g = {path: f.path, file: f, x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2, w, d, base: blk.y, h: heightOf(f.lines), type: f.type, block: blk.id, lot: c, idx: L.buildings.length};
    L.buildings.push(g); L.byFile.set(f.path, g);
  });
}

/** The nearest block for a directory path (walking up until a laid-out block is found). */
export function blockFor(L, land, path) {
  let d = land.byPath.get(path);
  while (d && !L.byPath.has(d.path)) d = d.parent;
  return d ? L.byPath.get(d.path) : L.byPath.get(land.root.path);
}
/** Checks for the tests: every directory is a block; no two sibling blocks overlap; one building per file;
 * buildings inside their block; height monotonic in lines. */
export function checkLayout(L, land) {
  const dirs = [...walk(land.root)].filter((d) => d.kind === 'dir' || d.kind === 'district' || d.kind === 'home');
  const uncovered = dirs.filter((d) => !L.byPath.has(d.path)).map((d) => d.path);
  let overlaps = 0, outside = 0;
  const kids = new Map();
  for (const b of L.blocks) { const p = b.node.parent?.path; if (!p) continue; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(b); }
  for (const list of kids.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i].rect, c = list[j].rect;
    if (a.x0 < c.x1 - 1e-6 && c.x0 < a.x1 - 1e-6 && a.z0 < c.z1 - 1e-6 && c.z0 < a.z1 - 1e-6) overlaps++;
  }
  for (const g of L.buildings) { const r = L.byPath.get(g.block).rect; if (g.x - g.w / 2 < r.x0 - 1e-6 || g.x + g.w / 2 > r.x1 + 1e-6 || g.z - g.d / 2 < r.z0 - 1e-6 || g.z + g.d / 2 > r.z1 + 1e-6) outside++; }
  // Buildings never overlap one another.
  let bOver = 0;
  const grid = new Map(), cell = 40, key = (i, j) => i * 100003 + j;
  for (const g of L.buildings) { const k = key(Math.floor(g.x / cell), Math.floor(g.z / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(g); }
  for (const g of L.buildings) for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const o of grid.get(key(Math.floor(g.x / cell) + di, Math.floor(g.z / cell) + dj)) || []) {
    if (o.idx <= g.idx) continue;
    if (Math.abs(g.x - o.x) < (g.w + o.w) / 2 - 1e-6 && Math.abs(g.z - o.z) < (g.d + o.d) / 2 - 1e-6) bOver++;
  }
  const byLines = [...L.buildings].sort((a, b) => a.file.lines - b.file.lines);
  let nonMono = 0;
  for (let i = 1; i < byLines.length; i++) if (byLines[i].file.lines > byLines[i - 1].file.lines && !(byLines[i].h > byLines[i - 1].h)) nonMono++;
  return {dirs: dirs.length, blocks: L.blocks.length, uncovered, siblingOverlaps: overlaps, buildingOverlaps: bOver, outside, buildings: L.buildings.length, files: land.files.size, nonMonotonic: nonMono};
}
