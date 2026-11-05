import { readFileSync } from "node:fs";
import { stlEnvironment, stlFloorFactor } from "./stl-environment.js";
import { readFile } from "node:fs/promises";
import { artifactFile, errorView, esc } from "./shared.js";

const KEY = "stl-viewer.preview";
const MAX_HTML = 990_000;
type Triangle = [number, number, number, number, number, number, number, number, number];
type Model = { positions: Float32Array; normals: Float32Array; indices: Uint16Array | Uint32Array; sourceTriangles: number; bounds: [number, number, number, number, number, number] };

function triangles(buffer: Buffer): Triangle[] {
  const count = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
  const binary = count > 0 && 84 + count * 50 <= buffer.length;
  const out: Triangle[] = [];
  if (binary) {
    for (let i = 0, o = 84; i < count && o + 50 <= buffer.length; i++, o += 50) {
      const t: number[] = [];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) t.push(buffer.readFloatLE(o + 12 + v * 12 + k * 4));
      if (t.every(Number.isFinite)) out.push(t as Triangle);
    }
  } else {
    const vs = Array.from(buffer.toString("utf8").matchAll(/\bvertex\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)/gi), m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (let i = 0; i + 2 < vs.length; i += 3) { const t = [...vs[i], ...vs[i + 1], ...vs[i + 2]]; if (t.every(Number.isFinite)) out.push(t as Triangle); }
  }
  if (!out.length) throw new Error("No triangles were found in this STL.");
  return out;
}

// Vertex clustering is only used when the packed, fully indexed mesh cannot fit the
// preview response. Unlike face sampling, it remaps the complete mesh and removes
// only faces collapsed by an edge contraction, so the displayed surface stays joined.
function indexMesh(source: Triangle[], cellScale = 1e-7): Model {
  const bounds: Model["bounds"] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const t of source) for (let i = 0; i < 9; i += 3) for (let k = 0; k < 3; k++) { bounds[k] = Math.min(bounds[k], t[i + k]); bounds[k + 3] = Math.max(bounds[k + 3], t[i + k]); }
  const span = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2], 1);
  const cell = Math.max(span * cellScale, Number.EPSILON * span * 32), map = new Map<string, number>(), p: number[] = [], ix: number[] = [];
  for (const t of source) {
    const face: number[] = [];
    for (let i = 0; i < 9; i += 3) {
      const key = `${Math.round((t[i] - bounds[0]) / cell)},${Math.round((t[i + 1] - bounds[1]) / cell)},${Math.round((t[i + 2] - bounds[2]) / cell)}`;
      let n = map.get(key); if (n === undefined) { n = p.length / 3; map.set(key, n); p.push(t[i], t[i + 1], t[i + 2]); } face.push(n);
    }
    if (face[0] !== face[1] && face[1] !== face[2] && face[2] !== face[0]) ix.push(...face);
  }
  const normals = new Float32Array(p.length);
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) { const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1; normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l; }
  // STL exporters frequently reverse every face. Orient the mesh globally using
  // its bounds center while still rendering both sides for locally mixed files.
  const center = [(bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2];
  let orientation = 0;
  for (let i = 0; i < normals.length; i += 3) orientation += normals[i] * (p[i] - center[0]) + normals[i + 1] * (p[i + 1] - center[1]) + normals[i + 2] * (p[i + 2] - center[2]);
  if (orientation < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  const indices = p.length / 3 <= 65535 ? new Uint16Array(ix) : new Uint32Array(ix);
  return { positions: new Float32Array(p), normals, indices, sourceTriangles: source.length, bounds };
}
function b64(a: ArrayBufferView) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64"); }
function packed(m: Model) { return { p: b64(m.positions), n: b64(m.normals), i: b64(m.indices), u: m.indices.BYTES_PER_ELEMENT === 4 ? 32 : 16, s: m.sourceTriangles, d: m.indices.length / 3, b: m.bounds }; }

// Browser-only expansion: never duplicate the compact mesh in the response.
// 35-degree creases split normals and produce feature edges, not triangulation.
export function stlRenderGeometry(p: Float32Array, smooth: Float32Array, indices: Uint16Array | Uint32Array) {
  const faces: number[][] = [], adjacent: number[][] = Array.from({ length: p.length / 3 }, () => []);
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  const threshold = Math.cos(35 * Math.PI / 180);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const u = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const v = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n) || 1;
    faces.push(n.map(x => x / length));
    const face = i / 3;
    for (const vertex of [a, b, c]) adjacent[vertex].push(face);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(x, y)},${Math.max(x, y)}`;
      const edge = edges.get(key) ?? { a: x, b: y, faces: [] };
      edge.faces.push(face); edges.set(key, edge);
    }
  }
  const positions = new Float32Array(indices.length * 3), normals = new Float32Array(positions.length), smoothNormals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i], face = faces[Math.floor(i / 3)], sum = [0, 0, 0];
    for (const f of adjacent[vertex]) if (face[0] * faces[f][0] + face[1] * faces[f][1] + face[2] * faces[f][2] >= threshold) for (let k = 0; k < 3; k++) sum[k] += faces[f][k];
    const length = Math.hypot(...sum) || 1;
    for (let k = 0; k < 3; k++) { positions[i * 3 + k] = p[vertex * 3 + k]; normals[i * 3 + k] = sum[k] / length; smoothNormals[i * 3 + k] = smooth[vertex * 3 + k]; }
  }
  const lines: number[] = [];
  for (const edge of edges.values()) {
    const a = faces[edge.faces[0]], b = faces[edge.faces[1]];
    if (edge.faces.length === 2 && a[0] * b[0] + a[1] * b[1] + a[2] * b[2] >= threshold) continue;
    for (const vertex of [edge.a, edge.b]) for (let k = 0; k < 3; k++) lines.push(p[vertex * 3 + k]);
  }
  return { positions, normals, smoothNormals, lines: new Float32Array(lines) };
}

// Orthographic camera-space centroid sorting. Intersecting triangles remain an
// approximation, but ordinary front/back shells blend in the correct order.
export function stlTransparentOrder(positions: Float32Array, depth: number[]) {
  const triangles = Array.from({ length: positions.length / 9 }, (_, i) => i);
  const distances = triangles.map(i => {
    let z = 0;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) z += positions[i * 9 + v * 3 + k] * depth[k];
    return z;
  });
  triangles.sort((a, b) => distances[b] - distances[a] || a - b);
  const order = new Uint32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) for (let k = 0; k < 3; k++) order[i * 3 + k] = triangles[i] * 3 + k;
  return order;
}

const stylesheet = readFileSync(new URL("./stl.css", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./stl-runtime.js", import.meta.url), "utf8")
  .replace("__GEOMETRY__", () => stlRenderGeometry.toString())
  .replace("__ORDER__", () => stlTransparentOrder.toString())
  .replace("__ENVIRONMENT__", () => stlEnvironment.toString())
  .replace("__FLOOR_FACTOR__", () => stlFloorFactor.toString());

function viewer(name: string, source: Triangle[]) {
  let scale = 1e-7, model = indexMesh(source, scale), data = JSON.stringify(packed(model));
  while (data.length > MAX_HTML - Buffer.byteLength(runtime) - Buffer.byteLength(stylesheet) - 8_000 && scale < .1) { scale *= 1.7; model = indexMesh(source, scale); data = JSON.stringify(packed(model)); }
  if (data.length > MAX_HTML - Buffer.byteLength(runtime) - Buffer.byteLength(stylesheet) - 8_000) throw new Error("This mesh cannot be compacted safely enough for the preview response.");
  const size = model.bounds.slice(3).map((v, i) => v - model.bounds[i]);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="color-scheme" content="dark"><style>${stylesheet}</style></head><body><div class="stage"><canvas aria-label="Interactive 3D STL model"></canvas><div class="title" data-summary="${size.map(n => n.toFixed(1)).join(" × ")} mm / ${model.indices.length / 3} faces">${esc(name)}</div><div class="info"><button id="info" aria-label="Model information" aria-expanded="false" aria-controls="model-info">i</button><div class="tip" id="model-info"><div>Dimensions <b>${size.map(n => n.toFixed(1)).join(" × ")} mm</b></div><div>Triangles <b>${model.indices.length / 3 === model.sourceTriangles ? model.sourceTriangles.toLocaleString() : `${(model.indices.length / 3).toLocaleString()} / ${model.sourceTriangles.toLocaleString()}`}</b></div><div>Rendering <b>Indexed WebGL</b></div><p class="navigation-help">Drag to orbit · two-finger drag to pan · pinch to zoom.<br>Mouse: shift/right-drag to pan · wheel to zoom.</p><label class="box-option"><input id="bounds" type="checkbox" checked aria-label="Bounding box"> Bounding box</label><button id="reset">Reset view</button></div></div><div class="controls"><label><span class="control-name">Style</span> <select id="style" aria-label="Shading style"><option value="cad">CAD</option><option value="smooth">Smooth</option><option value="flat">Flat</option></select></label><label><input id="outlines" type="checkbox" checked aria-label="Feature outlines"><span><span class="feature-prefix">Feature </span>outlines</span></label><label class="opacity-control"><span class="control-name">Opacity</span> <input id="opacity" type="range" min="0.15" max="1" step="0.05" value="1" aria-label="Surface opacity"><output id="alpha">100%</output></label></div></div><script>${runtime.replace("__MODEL__", () => data)}</script></body></html>`;
  if (Buffer.byteLength(html, "utf8") > MAX_HTML) throw new Error("This mesh exceeds the preview response limit.");
  return { html };
}
export function stlContribution(getCwd: () => string) {
  return { slot: "artifact-preview", kind: "rendered", title: "STL viewer", label: "3D mesh", match: { extensions: [".stl"] }, async render(event: any) {
    try { const context = event?.context; if (!context || typeof context.path !== "string") return errorView("Cannot open STL", "The artifact context is missing."); const file = await artifactFile(getCwd(), context.path, 20 * 1024 * 1024, "STL", 20); return viewer(typeof context.name === "string" ? context.name : "STL model", triangles(await readFile(file))); }
    catch (error) { return errorView("Cannot open STL", error instanceof Error ? error.message : String(error)); }
  }};
}
