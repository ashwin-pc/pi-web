// The squarified treemap split (Farm's farm-treemap.js `squarify`, kept as it was, plus a `floor` option).
// Pure functions (no three.js), so node can test them.
//
// Split rect r = {x0, z0, x1, z1} among items with .w (weight); returns rects in item order. A balanced binary split
// (the heaviest items first; each cut halves the weight, across the rect's longer side) gives near-square cells and,
// unlike squarify's last row, never a sliver. Small items get a floor of `floor` × the total (Farm used 10%, so there
// was room to stand; the city passes a small floor for blocks and none for buildings, so sizes stay true).
export function squarify(items, r, floor = 0.1) {
  const out = new Array(items.length);
  const tot = items.reduce((s, it) => s + it.w, 0);
  const order = items.map((it, i) => ({i, w: Math.max(1e-6, it.w, tot * floor)})).sort((a, b) => b.w - a.w || a.i - b.i);
  const split = (list, rect) => {
    if (list.length === 1) { out[list[0].i] = rect; return; }
    const sum = list.reduce((s, o) => s + o.w, 0);
    let acc = 0, k = 1, best = Infinity;
    for (let j = 1; j < list.length; j++) { acc += list[j - 1].w; const d = Math.abs(sum / 2 - acc); if (d < best) { best = d; k = j; } }
    const a = list.slice(0, k), b = list.slice(k), fa = a.reduce((s, o) => s + o.w, 0) / sum;
    if (rect.x1 - rect.x0 >= rect.z1 - rect.z0) { const x = rect.x0 + (rect.x1 - rect.x0) * fa; split(a, {...rect, x1: x}); split(b, {...rect, x0: x}); }
    else { const z = rect.z1 - (rect.z1 - rect.z0) * fa; split(a, {...rect, z0: z}); split(b, {...rect, z1: z}); } // the heavier part nearest the front
  };
  if (order.length) split(order, r);
  return out;
}
export const rw = (r) => r.x1 - r.x0, rd = (r) => r.z1 - r.z0;
export const inset = (r, d) => { const dx = Math.min(d, rw(r) * 0.25), dz = Math.min(d, rd(r) * 0.25); return {x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 - dx, z1: r.z1 - dz}; };
/** Two rects overlap (with a tolerance in metres). */
export const overlaps = (a, b, eps = 1e-6) => a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.z0 < b.z1 - eps && b.z0 < a.z1 - eps;
export const inside = (a, b, eps = 1e-6) => a.x0 >= b.x0 - eps && a.x1 <= b.x1 + eps && a.z0 >= b.z0 - eps && a.z1 <= b.z1 + eps;
