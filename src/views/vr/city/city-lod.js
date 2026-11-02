// Level of detail for the city's labels. From altitude: districts (on their name towers), the two avenues and city
// hall. Closer: block street signs, once a block is big enough in view to carry its name. Close up: building (file)
// names. Candidates are in city metres (`local`); the label pass sizes them in degrees and hides collisions.
import * as THREE from 'three';

export const LOD = {blockMinDeg: 9, blockMaxDist: 230, fileMaxDist: 150, fileMinDeg: 3.2, maxFiles: 26, deg: {district: 1.6, avenue: 1.1, hall: 1.2, block: 0.92, file: 0.84}};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function cityLabelCands(city, eye, scale, fwd) {
  const L = city.L, out = [], hot = city.blockHeat || new Map();
  const dist = (x, y, z) => Math.hypot(x - eye.x, y - eye.y, z - eye.z) * (1 / Math.max(1e-6, 1)) ;
  const S_ = scale; // city metres per user metre: in god mode labels stay, at the same angular size
  for (const d of L.districts) {
    const files = d.node ? countFiles(d.node) : 0;
    out.push({id: `district:${d.id}`, kind: 'district', text: d.name, sub: `~/${d.node.parent.name}/${d.name} · ${plural(files, 'file')}`, local: new THREE.Vector3(d.tower.x, d.tower.h + 1, d.tower.z), deg: LOD.deg.district, prio: 1000, click: {fly: d.id}});
  }
  out.push({id: 'hall', kind: 'district', text: 'City hall', sub: '~ · the mayor\'s office', local: new THREE.Vector3(L.hall.x, 59, L.hall.z), deg: LOD.deg.hall, prio: 960, click: {fly: city.land.root.path}});
  for (const a of L.avenues) out.push({id: `avenue:${a.id}`, kind: 'avenue', text: `~/${a.node.name}`, sub: 'avenue', local: new THREE.Vector3(a.side < 0 ? Math.max(a.x0 + 30, -140) : Math.min(a.x1 - 30, 120), 0.4, (a.z0 + a.z1) / 2), deg: LOD.deg.avenue, prio: 900, click: null});
  for (const b of L.blocks) {
    if (b.kind === 'home' || b.kind === 'district') continue;
    const r = b.rect, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const D = dist(cx, b.y, cz) || 1, size = Math.max(r.x1 - r.x0, r.z1 - r.z0) / D * 180 / Math.PI;
    if (size < LOD.blockMinDeg / (b.rel <= 1 ? 1.4 : 1) || D > LOD.blockMaxDist * (S_ > 3 ? 1e9 : 1)) continue;
    const h = hot.get(b.id) || 0;
    const sub = `${plural(b.total, 'file')}${h > 0.05 ? ' · edited today' : ''}`;
    out.push({id: `block:${b.id}`, kind: 'block', text: `${b.node.name}/`, sub, hot: h > 0.05, local: new THREE.Vector3(b.sign.x, b.y + 0.3, b.sign.z), deg: LOD.deg.block, prio: 400 + Math.min(200, size * 4) + (h > 0.05 ? 120 : 0) - b.rel * 15, click: {fly: b.id}});
  }
  // Files: the nearest buildings that are big enough in view, from a coarse grid around the eye.
  if (S_ < 3) {
    const files = [], gx = Math.floor(eye.x / 60), gz = Math.floor(eye.z / 60), R = Math.ceil(LOD.fileMaxDist / 60) + 1;
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (const g of city.grid.get(`${gx + i},${gz + j}`) || []) {
      const D = dist(g.x, g.base + g.h, g.z);
      if (D > LOD.fileMaxDist) continue;
      // Only what is in front of you (within about 30° of where you look) competes for a name.
      if (fwd && ((g.x - eye.x) * fwd.x + (g.base + g.h - eye.y) * fwd.y + (g.z - eye.z) * fwd.z) / D < 0.87) continue;
      const size = Math.max(g.w, g.d) / D * 180 / Math.PI;
      if (size < LOD.fileMinDeg) continue;
      files.push({g, D, size});
    }
    files.sort((a, b) => b.size - a.size);
    for (const {g, size} of files.slice(0, LOD.maxFiles)) out.push({id: `file:${g.path}`, kind: 'file', text: g.file.name, sub: '', local: new THREE.Vector3(g.x, g.base + g.h + 0.4, g.z), deg: LOD.deg.file, prio: 100 + Math.min(150, size * 6), click: null});
  }
  return out;
}
const fcache = new WeakMap();
function countFiles(n) { if (fcache.has(n)) return fcache.get(n); let c = n.files.length; for (const d of n.dirs) c += countFiles(d); fcache.set(n, c); return c; }
