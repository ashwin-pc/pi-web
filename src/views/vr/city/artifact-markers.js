// Round 3, artifact markers in the city: each artifact's file building carries a small gold marker (a slowly turning
// diamond above its roof, one InstancedMesh for all). Pointing within about 2° of one and selecting it opens the
// artifact: its session's cockpit, with the artifact pulled out (or on the pedestal).
import * as THREE from 'three';
import {client} from './client.js';
import {S} from './state.js';
import {A, DEG} from './core.js';

export class Markers {
  constructor(city) {
    this.city = city; this.list = []; this.L = null;
    const mat = new THREE.MeshBasicMaterial({color: 0xf0c27a, toneMapped: false, transparent: true, opacity: 0.95}); // depth-tested: panels in front hide them
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), mat, 64);
    this.mesh.name = 'artifact-markers'; this.mesh.renderOrder = 22; this.mesh.frustumCulled = false; this.mesh.count = 0;
    city.root.add(this.mesh);
  }
  /** Rebuild the marker list when the city's layout changes, or (pi-web) when a session's artifacts change. */
  sync() {
    const v = client.artifactsVersion?.() ?? 0;
    if (this.L === this.city.L && this.v === v) return;
    this.L = this.city.L; this.v = v; this.list = [];
    for (const id of S.sessions.keys()) for (const a of client.artifacts(id)) { const g = this.L.byFile.get(a.path); if (g) this.list.push({a, g}); }
  }
  /** Size the markers to stay about 1.1° wide at any distance, above their roofs. */
  tick(eyeWorld, visible) {
    this.sync();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const eye = this.city.root.worldToLocal(eyeWorld.clone()), t = performance.now() / 1000;
    this.mesh.visible = visible;
    this.list.forEach(({g}, i) => {
      p.set(g.x, g.base + g.h, g.z);
      const d = Math.max(1, p.distanceTo(eye)), r = d * Math.tan(0.55 * DEG);
      p.y += r * 2.2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 0.8 + i);
      m.compose(p, q, sc.set(r * 0.7, r, r * 0.7)); this.mesh.setMatrixAt(i, m);
    });
    this.mesh.count = this.list.length; this.mesh.instanceMatrix.needsUpdate = true;
  }
  /** The marker a ray points at (within 2°, nearest first): {region, point, distance}. */
  pick(ray) {
    if (!this.mesh.visible) return null;
    let best = null; const p = new THREE.Vector3(), m = new THREE.Matrix4();
    this.list.forEach(({a}, i) => {
      this.mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m); this.city.root.localToWorld(p);
      const v = p.clone().sub(ray.origin), d = v.length(), ang = v.angleTo(ray.direction) / DEG;
      if (ang < 2 && (!best || d < best.distance)) best = {distance: d, point: p.clone(), region: {id: `marker:${a.id}`, click: () => A.r3?.openArtifact(a)}};
    });
    return best;
  }
  /** Screen data for tests: each marker's artifact and world position. */
  snapshot() { const m = new THREE.Matrix4(), p = new THREE.Vector3(); return this.list.map(({a}, i) => { this.mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m); this.city.root.localToWorld(p); return {id: a.id, kind: a.kind, path: a.path, world: p.toArray()}; }); }
}
