// Draws several small canvas panels (the dock, the navigation column and the composer) as ONE mesh with one atlas
// texture: one draw call per eye instead of three. Each Panel keeps its own mesh for hit-testing, placement and
// opacity (its material is made invisible, so the renderer skips it); every frame the batch copies each visible
// panel's vertices into world space and its canvas into the atlas when it changed.
import * as THREE from 'three';

export class PanelBatch {
  constructor(list, {renderOrder = 6, name = 'panel-batch'} = {}) {
    this.list = list;
    const W = list.reduce((a, p) => a + p.cw + 2, 0), H = Math.max(...list.map((p) => p.ch));
    this.canvas = document.createElement('canvas'); this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    let x = 0;
    this.rects = list.map((p) => { const r = {x, w: p.cw, h: p.ch}; x += p.cw + 2; return r; }); // 2 px gutters: no bleed
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = list[0].tex.anisotropy;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    const maxV = list.reduce((a, p) => a + p.mesh.geometry.attributes.position.count + 64, 0);
    this.pos = new THREE.BufferAttribute(new Float32Array(maxV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(maxV * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(maxV * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.idx = new THREE.BufferAttribute(new Uint16Array(maxV * 3), 1).setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.pos); g.setAttribute('uv', this.uv); g.setAttribute('color', this.col); g.setIndex(this.idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: this.tex, vertexColors: true, transparent: true, alphaTest: 0.02, toneMapped: false}));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.name = name;
    this.versions = list.map(() => -1);
    for (const p of list) { p.mat.visible = false; p.batch = this; }
  }
  /** Call once per frame after the panels were updated and placed (and before rendering). */
  sync() {
    let changed = false;
    this.list.forEach((p, i) => {
      if (p.tex.version === this.versions[i]) return;
      this.versions[i] = p.tex.version; changed = true;
      const r = this.rects[i];
      this.ctx.clearRect(r.x, 0, r.w, this.canvas.height);
      this.ctx.drawImage(p.canvas, r.x, 0);
    });
    if (changed) this.tex.needsUpdate = true;
    let nv = 0, ni = 0;
    const P = this.pos.array, U = this.uv.array, C = this.col.array, I = this.idx.array, v = new THREE.Vector3();
    const W = this.canvas.width, H = this.canvas.height;
    this.list.forEach((p, i) => {
      if (!p.visible || p.mat.opacity <= 0.001) return;
      p.mesh.updateWorldMatrix(true, false);
      const gp = p.mesh.geometry.attributes.position, gu = p.mesh.geometry.attributes.uv, gi = p.mesh.geometry.index, r = this.rects[i];
      for (let k = 0; k < gp.count; k++) {
        v.fromBufferAttribute(gp, k).applyMatrix4(p.mesh.matrixWorld);
        P.set([v.x, v.y, v.z], (nv + k) * 3);
        // Panel uv (0..1 over its canvas, v up) → atlas uv.
        U[(nv + k) * 2] = (r.x + gu.getX(k) * r.w) / W;
        U[(nv + k) * 2 + 1] = 1 - ((1 - gu.getY(k)) * r.h) / H;
        C.set([1, 1, 1, p.mat.opacity], (nv + k) * 4);
      }
      for (let k = 0; k < gi.count; k++) I[ni + k] = gi.getX(k) + nv;
      nv += gp.count; ni += gi.count;
    });
    this.mesh.geometry.setDrawRange(0, ni);
    this.mesh.visible = ni > 0;
    this.pos.needsUpdate = this.uv.needsUpdate = this.col.needsUpdate = this.idx.needsUpdate = true;
  }
}
