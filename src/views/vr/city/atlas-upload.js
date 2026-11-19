// pi-web (usability round 1): partial uploads for the city's label and card atlases. Changing one label used to
// re-upload the whole atlas (8-16 MB in one frame). Now the first upload is whole, and after that only the changed
// slots are copied into the GPU texture (texSubImage2D through three's copyTextureToTexture), a few per frame.
import * as THREE from 'three';
import {renderer} from './core.js';

export class AtlasUploader {
  /** tex: the atlas CanvasTexture; slotsPerFrame: how many changed slots to upload each frame. */
  constructor(tex, {slotsPerFrame = 8} = {}) {
    this.tex = tex; this.canvas = tex.image; this.per = slotsPerFrame;
    this.queue = new Map(); this.ready = false; this.pos = new THREE.Vector2();
    this.scratch = new Map(); // "w×h" -> {canvas, tex}
  }
  /** A region of the atlas canvas (canvas pixels, origin top left) changed. */
  mark(x, y, w, h) { this.queue.set(`${x},${y}`, {x, y, w, h}); }
  /** Each frame: the first time, upload the whole atlas; afterwards, copy up to `per` changed regions. */
  flush() {
    if (!this.ready) { this.tex.needsUpdate = true; renderer.initTexture(this.tex); this.ready = true; this.queue.clear(); return; }
    let n = 0;
    for (const [k, r] of this.queue) {
      if (n++ >= this.per) break;
      this.queue.delete(k);
      const key = `${r.w}x${r.h}`;
      let sc = this.scratch.get(key);
      if (!sc) { const c = document.createElement('canvas'); c.width = r.w; c.height = r.h; sc = {canvas: c, ctx: c.getContext('2d'), tex: new THREE.Texture(c)}; sc.tex.flipY = this.tex.flipY; this.scratch.set(key, sc); }
      sc.ctx.clearRect(0, 0, r.w, r.h);
      sc.ctx.drawImage(this.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      // GPU rows start at the bottom of a flipped texture.
      this.pos.set(r.x, this.tex.flipY ? this.canvas.height - r.y - r.h : r.y);
      renderer.copyTextureToTexture(sc.tex, this.tex, null, this.pos);
    }
  }
}
