// The city's static meshes: every building (one InstancedMesh, the landmarks included as the last instances), the
// block plinths with the avenues and the plaza (one merged mesh), the far ground, the sky and the rising embers.
import * as THREE from 'three';
import {groundMaterial, skyMaterial, farGroundMaterial, U} from './city-shade.js';
import {CIVIC} from './city-layout.js';

import {Buildings} from './city-buildings.js';
/** Every building (and the landmarks) as one level-of-detail InstancedMesh: see city-buildings.js. */
export function buildBuildings(L) { return new Buildings(L, landmarks(L)); }

/** City hall (stepped, with a crown) and each district's name tower: drawn as buildings of their own types. */
export function landmarks(L) {
  const h = L.hall, out = [];
  out.push({x: h.x, y: 0.25, z: h.z, w: h.w, h: 14, d: h.d, type: 7, id: 'hall'});
  out.push({x: h.x, y: 14.25, z: h.z, w: h.w * 0.66, h: 12, d: h.d * 0.66, type: 7, id: 'hall'});
  out.push({x: h.x, y: 26.25, z: h.z, w: h.w * 0.34, h: 18, d: h.d * 0.34, type: 7, id: 'hall'});
  out.push({x: h.x, y: 44.25, z: h.z, w: 2.2, h: 14, d: 2.2, type: 8, id: 'hall-spire'});
  for (const d of L.districts) out.push({x: d.tower.x, y: 0, z: d.tower.z, w: 6, h: d.tower.h, d: 6, type: 8, id: `tower:${d.id}`});
  return out;
}

/** Plinths (one box per block, from the ground to its top), avenues and the plaza, merged. */
export function buildGround(L) {
  const pos = [], blk = [], kind = [], idx = [];
  const quad = (p, b, k) => { const s = pos.length / 3; for (let i = 0; i < 4; i++) { pos.push(...p[i]); blk.push(...b[i]); kind.push(...k); } idx.push(s, s + 2, s + 1, s, s + 3, s + 2); };
  const box = (r, y0, y1, k, bi, depth, dir = 0) => {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, hw = (r.x1 - r.x0) / 2, hd = (r.z1 - r.z0) / 2;
    const B = (x, z) => [x - cx, z - cz, hw, hd];
    // Top (counter-clockwise seen from above).
    quad([[r.x0, y1, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1], [r.x0, y1, r.z1]].map((p) => p).reverse(), [B(r.x0, r.z1), B(r.x1, r.z1), B(r.x1, r.z0), B(r.x0, r.z0)], [k, bi, depth, dir]);
    if (y1 - y0 < 0.01) return;
    const side = [1, bi, depth, 0];
    quad([[r.x0, y0, r.z1], [r.x1, y0, r.z1], [r.x1, y1, r.z1], [r.x0, y1, r.z1]], [B(r.x0, r.z1), B(r.x1, r.z1), B(r.x1, r.z1), B(r.x0, r.z1)], side);
    quad([[r.x1, y0, r.z0], [r.x0, y0, r.z0], [r.x0, y1, r.z0], [r.x1, y1, r.z0]], [B(r.x1, r.z0), B(r.x0, r.z0), B(r.x0, r.z0), B(r.x1, r.z0)], side);
    quad([[r.x1, y0, r.z1], [r.x1, y0, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1]], [B(r.x1, r.z1), B(r.x1, r.z0), B(r.x1, r.z0), B(r.x1, r.z1)], side);
    quad([[r.x0, y0, r.z0], [r.x0, y0, r.z1], [r.x0, y1, r.z1], [r.x0, y1, r.z0]], [B(r.x0, r.z0), B(r.x0, r.z1), B(r.x0, r.z1), B(r.x0, r.z0)], side);
  };
  L.blocks.forEach((b, i) => { b.index = i; if (b.kind === 'home') box(b.rect, 0, b.y, 3, i, 0); else box(b.rect, b.rel === 0 ? 0 : L.byPath.get(b.node.parent.path)?.y ?? 0, b.y, 0, i, b.rel + 1); });
  for (const a of L.avenues) box({x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1}, 0, 0.12, 2, 0, 0, 0);
  const bv = CIVIC.boulevard; box(bv, 0, 0.12, 2, 0, 0, 1);
  // Streets in front of each district, from the avenue to its tower.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlk', new THREE.Float32BufferAttribute(blk, 4));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const n = L.blocks.length;
  const heat = new THREE.DataTexture(new Uint8Array(n * 4), n, 1, THREE.RGBAFormat);
  heat.needsUpdate = true;
  const mesh = new THREE.Mesh(g, groundMaterial(heat, n));
  mesh.name = 'ground'; mesh.renderOrder = -4;
  mesh.userData.heatTex = heat;
  return mesh;
}

export function buildFarGround() {
  const g = new THREE.CircleGeometry(6000, 48).rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, farGroundMaterial());
  m.position.y = -0.02; m.name = 'far-ground'; m.renderOrder = -3;
  return m;
}
export function buildSky() {
  const m = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMaterial());
  m.frustumCulled = false; m.renderOrder = 100; m.name = 'sky'; // last: only the pixels nothing else covered
  return m;
}

/** Rising gold embers over the city (pi-web's boot splash): points that rise, sway and fade, animated in the shader. */
export function buildEmbers(L, count = 520) {
  const b = L.bounds, pos = new Float32Array(count * 3), seed = new Float32Array(count);
  let s = 12345; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) { pos[i * 3] = b.x0 - 40 + r() * (b.x1 - b.x0 + 80); pos[i * 3 + 1] = 0; pos[i * 3 + 2] = b.z0 - 40 + r() * (b.z1 - b.z0 + 80); seed[i] = r(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {...U, uPx: {value: 900}}, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSeed; uniform float uTime, uPx, uScale; varying float vA;
      void main() {
        float t = fract(uTime / (14.0 + aSeed * 10.0) + aSeed);
        vec3 p = position + vec3(sin(t * 6.28 + aSeed * 40.0) * 6.0, 4.0 + t * 150.0, cos(t * 5.0 + aSeed * 20.0) * 5.0);
        vA = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(uPx * 0.9 * uScale / -mv.z, 1.5, 7.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uDim; varying float vA;
      void main() { vec2 q = gl_PointCoord - 0.5; float d = length(q); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vec3(0.886, 0.694, 0.373) * a * vA * (1.0 - 0.6 * uDim), 1.0);
        /* colours are display-space (pi-web hex), written as they are */
      }`,
  });
  const p = new THREE.Points(g, mat);
  p.name = 'embers'; p.frustumCulled = false; p.renderOrder = 8;
  return p;
}
export {U};
