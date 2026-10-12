// Round 3, the pedestal: a 3D artifact (the real STL, glTF, OBJ or PLY file, loaded by model-load.js; the mock's
// procedural dial is only the stand-in while it loads) sits on a pedestal in front of you, a little below eye level, beside the cockpit. Drag it (pointer, trigger, pinch) to turn it; the wheel, or the
// − / + buttons, scale it; "Put back" returns it to the rail. Lit by a gold matcap, so it needs no scene lights.
import * as THREE from 'three';
import {Panel} from './panel.js';
import {C, fillRR, icon, text} from './draw.js';
import {room, placeRel, relDir} from './focus.js';
import {sideSlotYaw, WIDE, closeArtifact} from './artifacts.js';
import {A, world, clamp, DEG} from './core.js';
import {host} from './host.js';
import {modelGeometry} from './model-load.js';

const PED = {dist: 1.2, below: 9, r: 0.13, h: 0.06};
function matcap() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createRadialGradient(96, 80, 10, 128, 128, 128);
  gr.addColorStop(0, '#fff2cf'); gr.addColorStop(0.25, '#f0c27a'); gr.addColorStop(0.6, '#a87a34'); gr.addColorStop(0.9, '#3a2810'); gr.addColorStop(1, '#120c04');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** A knurled dial with a centre bore and a pointer notch: lathe profile plus ridges, about 0.2 m across. */
function dialGeometry() {
  const prof = [[0.03, 0], [0.1, 0], [0.104, 0.006], [0.104, 0.05], [0.096, 0.058], [0.07, 0.062], [0.06, 0.075], [0.035, 0.075], [0.03, 0.06]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(prof, 96);
  const pos = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.hypot(v.x, v.z), a = Math.atan2(v.z, v.x);
    if (r > 0.095 && v.y > 0.008 && v.y < 0.05) { const k = 1 + 0.035 * Math.max(0, Math.cos(a * 24)); v.x *= k; v.z *= k; }
    if (r > 0.06 && v.y > 0.055 && Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.08) v.y -= 0.01; // the notch
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
export class Pedestal {
  constructor() {
    this.g = new THREE.Group(); this.g.name = 'pedestal'; this.g.visible = false; world.add(this.g);
    const gold = new THREE.MeshMatcapMaterial({matcap: matcap()});
    const stone = new THREE.MeshMatcapMaterial({matcap: matcap(), color: 0x2a2a2a});
    this.base = new THREE.Mesh(new THREE.CylinderGeometry(PED.r, PED.r * 1.1, PED.h, 48), stone); this.base.position.y = -PED.h / 2;
    this.rim = new THREE.Mesh(new THREE.TorusGeometry(PED.r, 0.004, 8, 64), gold); this.rim.rotation.x = Math.PI / 2;
    this.pivot = new THREE.Group(); this.pivot.position.y = 0.01;
    this.placeholder = dialGeometry(); this.gold = gold;
    this.model = new THREE.Mesh(this.placeholder, new THREE.MeshBasicMaterial({color: 0x5a4a2a, wireframe: true})); this.model.name = 'model'; this.model.position.y = 0; this.pivot.add(this.model);
    this.g.add(this.base, this.rim, this.pivot);
    this.yaw = 0.6; this.tilt = -0.35; this.scale = 1; this.art = null; this.turned = 0;
    this.model.userData.hit = () => ({region: {id: 'model', drag: this.drag(), click: null}});
    this.ctl = new Panel('pedestal-ctl', {w: 0.34, h: 0.075, ppm: 1600, draw: (ctx, p) => this.drawCtl(ctx, p), renderOrder: 6});
    this.g.add(this.ctl.mesh); this.ctl.mesh.position.set(0, -PED.h - 0.06, 0.06);
  }
  drag() {
    let last = null;
    return {
      start: (p) => { last = p.ray.direction.clone(); },
      move: (p) => {
        const d = p.ray.direction, dy = Math.atan2(d.x, -d.z) - Math.atan2(last.x, -last.z), dx = Math.asin(clamp(d.y, -1, 1)) - Math.asin(clamp(last.y, -1, 1));
        this.yaw += dy * 6; this.tilt = clamp(this.tilt - dx * 6, -1.2, 1.2); this.turned += Math.abs(dy) + Math.abs(dx); last = d.clone();
      },
      end: () => { last = null; },
    };
  }
  drawCtl(ctx, p) {
    const W = p.cw, H = p.ch, bw = (W - 40) / 3;
    [['ped:smaller', 'minimize-2', 'Smaller', () => this.zoom(1 / 1.25)], ['ped:bigger', 'maximize-2', 'Bigger', () => this.zoom(1.25)], ['ped:back', 'undo-2', 'Put back', () => this.putBack()]].forEach(([id, ic, label, click], i) => {
      const x = 10 + i * (bw + 10);
      fillRR(ctx, x, 6, bw, H - 12, 22, p.isHover(id) ? '#2a2a2a' : '#141414', '#2c2c2c', 2);
      icon(ctx, ic, x + 36, H / 2, 30, C.accent, 2.4); text(ctx, label, x + 64, H / 2 + 1, {size: 30, weight: 700});
      p.region(id, x, 0, bw, H, {click});
    });
  }
  zoom(f) { this.scale = clamp(this.scale * f, 0.5, 2.5); }
  show(a) {
    this.art = a; this.g.visible = true; room.shiftTo = 0; this.yaw = 0.6; this.tilt = -0.35; this.scale = 1;
    this.setGeometry(this.placeholder, false); this.status = 'loading';
    // The real file: a wireframe stand-in until it loads (or if it cannot be shown).
    const want = a.id;
    host.loadArtifact?.(a).then(async (c) => {
      if (this.art?.id !== want) return;
      if (c.kind !== 'model') { this.status = c.reason || 'unavailable'; return; }
      const g = await modelGeometry(c.bytes, c.format);
      if (this.art?.id !== want) { g.dispose(); return; }
      this.setGeometry(g, true); this.status = 'ready';
    }).catch((err) => { if (this.art?.id === want) this.status = String(err?.message || err); });
  }
  setGeometry(g, real) {
    if (this.model.geometry !== this.placeholder && this.model.geometry !== g) this.model.geometry.dispose();
    this.model.geometry = g;
    this.model.material = real ? this.gold : new THREE.MeshBasicMaterial({color: 0x5a4a2a, wireframe: true});
  }
  hide() { this.art = null; this.g.visible = false; }
  putBack() { this.hide(); A.r3?.railChanged(); }
  /** Each frame (focus layout): beside the cockpit, a little below eye level, turned toward you. */
  tick(show) {
    this.g.visible = show && !!this.art;
    if (!this.g.visible) return;
    const dy = sideSlotYaw(WIDE.model), de = room.gaze - PED.below - room.pitch;
    placeRel(this.g, dy, de, PED.dist);
    // Keep the pedestal upright: it faces you in yaw only.
    const d = relDir(dy, de); this.g.rotation.set(0, -Math.atan2(d.x, -d.z), 0);
    this.pivot.rotation.set(this.tilt, this.yaw, 0, 'XYZ'); this.pivot.scale.setScalar(this.scale);
  }
  /** Its surfaces, for the bar, the city's labels and the overlap tests. */
  meshes() { return [this.base, this.model, this.ctl.mesh]; }
}
export const pedestal = new Pedestal();
A.pedestal = pedestal;
export {closeArtifact, DEG};
