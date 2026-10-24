// A UI panel = a 2D canvas drawn into a CanvasTexture on a flat or cylindrically curved mesh, plus hit regions.
import * as THREE from 'three';

export const panels = [];
export const PanelConfig = {anisotropy: 4};

export class Panel {
  /**
   * @param {string} name
   * @param {object} o w/h metres; ppm canvas px per metre; R curve radius (0 = flat, centre of curvature at +z R);
   *   anchorX/anchorY: where the local origin sits on the panel (0..1, 0 = left/bottom); draw(ctx, panel).
   */
  constructor(name, o) {
    this.name = name;
    this.w = o.w; this.h = o.h; this.R = o.R || 0;
    this.anchorX = o.anchorX ?? 0.5; this.anchorY = o.anchorY ?? 0.5;
    this.ppm = o.ppm || 1280;
    this.cw = o.canvasW || Math.round(this.w * this.ppm);
    this.ch = o.canvasH || Math.round(this.h * this.ppm);
    this.drawFn = o.draw;
    this.hoverRedraw = o.hoverRedraw !== false;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cw; this.canvas.height = this.ch;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = PanelConfig.anisotropy;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = o.mipmaps !== false;
    if (o.mipmaps === false) this.tex.minFilter = THREE.LinearFilter;
    this.mat = new THREE.MeshBasicMaterial({map: this.tex, transparent: true, alphaTest: 0.02, toneMapped: false, depthWrite: o.depthWrite ?? true, opacity: 1});
    this.u0 = 0; this.v0 = 0; // visible crop: u in [u0, 1], v in [v0, 1]
    this.mesh = new THREE.Mesh(this.geometry(), this.mat);
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = o.renderOrder || 0;
    this.regions = [];
    this.hoverIds = new Set();
    this.interactive = o.interactive !== false;
    this.dirty = true;
    panels.push(this);
  }
  get visible() { return this.mesh.visible && this.parentsVisible(); }
  parentsVisible() { let o = this.mesh; while (o) { if (!o.visible) return false; o = o.parent; } return true; }
  show(v) { if (this.mesh.visible === v) return; this.mesh.visible = v; if (v) this.dirty = true; }
  uvToLocal(u, v, out = new THREE.Vector3()) {
    const x = (u - this.anchorX) * this.w;
    const y = (v - this.anchorY) * this.h;
    if (!this.R) return out.set(x, y, 0);
    const t = x / this.R;
    return out.set(this.R * Math.sin(t), y, this.R * (1 - Math.cos(t)));
  }
  geometry() {
    const segX = this.R ? Math.max(2, Math.ceil(((1 - this.u0) * this.w) / 0.03)) : 1;
    const pos = [], uv = [], idx = [];
    const v3 = new THREE.Vector3();
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= segX; i++) {
        const u = this.u0 + ((1 - this.u0) * i) / segX;
        const v = this.v0 + (1 - this.v0) * j;
        this.uvToLocal(u, v, v3);
        pos.push(v3.x, v3.y, v3.z);
        uv.push(u, v);
      }
    }
    for (let i = 0; i < segX; i++) {
      const a = i, b = i + 1, c = segX + 1 + i, d = segX + 2 + i;
      idx.push(a, b, d, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
  setCrop(u0, v0 = this.v0) {
    u0 = Math.max(0, Math.min(1, u0)); v0 = Math.max(0, Math.min(1, v0));
    if (Math.abs(u0 - this.u0) < 1e-4 && Math.abs(v0 - this.v0) < 1e-4) return;
    this.u0 = u0; this.v0 = v0;
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.geometry();
  }
  invalidate() { this.dirty = true; }
  dispose() {
    const i = panels.indexOf(this);
    if (i >= 0) panels.splice(i, 1);
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose(); this.tex.dispose(); this.mat.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
  update(force = false) {
    if (!this.dirty || (!force && !this.mesh.visible)) return false;
    this.dirty = false;
    this.regions = [];
    this.ctx.clearRect(0, 0, this.cw, this.ch);
    this.drawFn(this.ctx, this);
    this.tex.needsUpdate = true;
    return true;
  }
  /** Register a hit region in canvas pixels. opts: {click, secondary, scroll, data, hover}. */
  region(id, x, y, w, h, opts = {}) { this.regions.push({id, x, y, w, h, panel: this, ...opts}); }
  isHover(id) { return this.hoverIds.has(id); }
  /** Canvas pixel for a mesh uv. Overridden by scrolling panels. */
  toCanvas(uv) { return {x: uv.x * this.cw, y: (1 - uv.y) * this.ch}; }
  fromCanvas(x, y) { return {u: x / this.cw, v: 1 - y / this.ch}; }
  regionAt(uv) {
    if (uv.x < this.u0 - 1e-3 || uv.y < this.v0 - 1e-3) return null;
    const p = this.toCanvas(uv);
    const inside = (r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    for (let i = this.regions.length - 1; i >= 0; i--) { const r = this.regions[i]; if (!r.under && inside(r)) return r; }
    for (let i = this.regions.length - 1; i >= 0; i--) { const r = this.regions[i]; if (r.under && inside(r)) return r; }
    return null;
  }
  regionWorld(id, out = new THREE.Vector3()) {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return null;
    const {u, v} = this.fromCanvas(r.x + r.w / 2, r.y + r.h / 2);
    this.uvToLocal(u, v, out);
    this.mesh.updateWorldMatrix(true, false);
    return out.applyMatrix4(this.mesh.matrixWorld);
  }
}
