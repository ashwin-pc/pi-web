// Where work is happening, readable from altitude: a gold light beam from the sky onto the building (file) each
// running session's tool touches, an impact glow, bash pulse rings on the cwd's block, search searchlights sweeping
// a block, and the lineage arcs from a waiting parent's thick column to its workers' beams. All additive, all batched:
// beams are one InstancedMesh, decals (glows, rings, searchlights) another, and the arcs one LineSegments.
import * as THREE from 'three';
import {U} from './city-shade.js';

const MAX = 64;
const GOLD = new THREE.Color(0xe2b15f);
function beamGeo() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
  return g;
}
const beamMat = () => new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: `attribute vec4 aB; // intensity, highlight, kind (0 running, 1 waiting), seed
    varying vec3 vN, vV; varying float vY; varying vec4 vB;
    void main() { vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix * instanceMatrix) * normal); vV = normalize(cameraPosition - w.xyz); vY = position.y; vB = aB; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float uTime, uDim; varying vec3 vN, vV; varying float vY; varying vec4 vB;
    void main() {
      float rim = abs(dot(normalize(vN), vV));
      float core = pow(rim, 2.5);
      float fall = exp(-vY * 3.2) * 0.85 + 0.15 * (1.0 - vY);
      float shimmer = 0.85 + 0.15 * sin(vY * 60.0 - uTime * 3.0 + vB.w * 20.0);
      float a = (0.25 + 0.75 * core) * fall * shimmer * vB.x * 0.85 * (1.0 + vB.y * 1.2) * (1.0 - 0.45 * uDim);
      vec3 c = mix(vec3(0.886, 0.62, 0.26), vec3(1.0, 0.86, 0.58), core * 0.35 + vB.y * 0.4);
      gl_FragColor = vec4(c * a, 1.0);
      /* colours are display-space (pi-web hex), written as they are */
    }`,
});
const decalMat = () => new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: `attribute vec4 aD; // mode (0 glow, 1 pulse ring, 2 searchlight, 3 hover ring), phase seed, intensity, aspect
    varying vec2 vP; varying vec4 vD;
    void main() { vP = position.xy * 2.0; vD = aD; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float uTime, uDim; varying vec2 vP; varying vec4 vD;
    void main() {
      float r = length(vP), m = vD.x, a = 0.0;
      vec3 c = vec3(0.886, 0.694, 0.373);
      if (m < 0.5) a = exp(-r * r * 6.0) * 0.9;
      else if (m < 1.5) { float t = fract(uTime / 1.6 + vD.y); a = (1.0 - smoothstep(0.0, 0.05, abs(r - t))) * (1.0 - t) * 1.2 + (1.0 - smoothstep(0.0, 0.03, abs(r - 0.98))) * 0.25; }
      else if (m < 2.5) {
        float ang = atan(vP.y, vP.x), sw = uTime * 1.3 + vD.y * 6.28;
        float d = abs(mod(ang - sw + 3.14159, 6.28318) - 3.14159);
        a = (1.0 - smoothstep(0.0, 0.32, d)) * (1.0 - smoothstep(0.7, 1.0, r)) * 0.8 + (1.0 - smoothstep(0.0, 0.02, abs(r - 0.97))) * 0.2;
        c = mix(c, vec3(0.95, 0.95, 1.0), 0.45);
      } else a = (1.0 - smoothstep(0.0, 0.05, abs(r - 0.85))) * 0.9;
      a *= step(r, 1.0) * vD.z * (1.0 - 0.45 * uDim);
      gl_FragColor = vec4(c * a, 1.0);
      /* colours are display-space (pi-web hex), written as they are */
    }`,
});

export class Beams {
  constructor(parent) {
    this.beams = new THREE.InstancedMesh(beamGeo(), beamMat(), MAX);
    this.bAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.beams.geometry.setAttribute('aB', this.bAttr);
    this.beams.count = 0; this.beams.frustumCulled = false; this.beams.renderOrder = 9; this.beams.name = 'beams';
    const dg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // Plane local xy after rotation: x stays x, y becomes -z; the shader reads position.xy, so keep an unrotated copy.
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), decalMat(), MAX * 2);
    this.dAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 8), 4).setUsage(THREE.DynamicDrawUsage);
    this.decals.geometry.setAttribute('aD', this.dAttr);
    this.decals.count = 0; this.decals.frustumCulled = false; this.decals.renderOrder = 8; this.decals.name = 'decals';
    dg.dispose();
    parent.add(this.beams, this.decals);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  }
  /** list: [{x, y, z, r, intensity, hi, kind, seed}] beams; decals: [{x, y, z, size, mode, seed, intensity}] */
  set(list, decals) {
    const m = this.m, s = new THREE.Vector3(), p = new THREE.Vector3();
    list.slice(0, MAX).forEach((b, i) => {
      const top = 460;
      m.compose(p.set(b.x, b.y, b.z), new THREE.Quaternion(), s.set(b.r, top - b.y, b.r));
      this.beams.setMatrixAt(i, m);
      this.bAttr.array.set([b.intensity, b.hi || 0, b.kind || 0, b.seed || 0], i * 4);
    });
    this.beams.count = Math.min(MAX, list.length);
    this.beams.instanceMatrix.needsUpdate = true; this.bAttr.needsUpdate = true;
    decals.slice(0, MAX * 2).forEach((d, i) => {
      m.compose(p.set(d.x, d.y + 0.15 + i * 0.002, d.z), this.q, s.set(d.size, d.size, 1));
      this.decals.setMatrixAt(i, m);
      this.dAttr.array.set([d.mode, d.seed || 0, d.intensity ?? 1, 1], i * 4);
    });
    this.decals.count = Math.min(MAX * 2, decals.length);
    this.decals.instanceMatrix.needsUpdate = true; this.dAttr.needsUpdate = true;
  }
}

/** Thin gold lines in world space: lineage arcs between beams, and the thread from a hovered avatar to its beam. */
export class Lines {
  constructor(scene) {
    this.max = 4000;
    this.pos = new THREE.BufferAttribute(new Float32Array(this.max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(this.max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', this.pos); g.setAttribute('color', this.col);
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, depthWrite: false, depthTest: false, toneMapped: false}));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 25; this.mesh.name = 'lines';
    scene.add(this.mesh);
    this.n = 0;
  }
  begin() { this.n = 0; }
  seg(a, b, alpha = 0.8, c = GOLD) {
    if (this.n + 2 > this.max) return;
    for (const v of [a, b]) { this.pos.setXYZ(this.n, v.x, v.y, v.z); this.col.setXYZW(this.n, c.r, c.g, c.b, alpha); this.n++; }
  }
  /** A quadratic arc from a to b bulging up by `lift`, as n segments. */
  arc(a, b, lift, n = 18, alpha = 0.7) {
    const p = new THREE.Vector3(), q = new THREE.Vector3(), mid = a.clone().add(b).multiplyScalar(0.5); mid.y += lift;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      bez(a, mid, b, t0, p); bez(a, mid, b, t1, q);
      this.seg(p, q, alpha);
    }
  }
  end() { this.mesh.geometry.setDrawRange(0, this.n); this.pos.needsUpdate = true; this.col.needsUpdate = true; this.mesh.visible = this.n > 0; }
}
function bez(a, m, b, t, out) { const u = 1 - t; return out.set(u * u * a.x + 2 * u * t * m.x + t * t * b.x, u * u * a.y + 2 * u * t * m.y + t * t * b.y, u * u * a.z + 2 * u * t * m.z + t * t * b.z); }
