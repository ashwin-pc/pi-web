// Shaders for the night city, in pi-web's palette (src/styles/base.css): --bg #030303, --panel #0a0a0a, --panel-2
// #131313, --border #242424, --text #f2f2f2, --muted #a3a3a3, --accent #e2b15f (gold), --danger #fb7185.
// Buildings are one InstancedMesh: dark glass towers whose windows are drawn procedurally here (no textures).
import * as THREE from 'three';

export const PAL = {bg: 0x030303, panel: 0x0a0a0a, panel2: 0x131313, border: 0x242424, text: 0xf2f2f2, muted: 0xa3a3a3, accent: 0xe2b15f, danger: 0xfb7185};
/** Shared uniforms: time, the eye (for fog), the reading dim, and how much detail to draw. */
export const U = {uTime: {value: 0}, uEye: {value: new THREE.Vector3()}, uDim: {value: 0}, uFogK: {value: 1 / 900}, uScale: {value: 1}};

const FOG = `
  vec3 cityFog(vec3 col, vec3 wp) {
    float d = length(wp - uEye) / uScale;
    float f = 1.0 - exp(-d * uFogK);
    // Far away the city sinks into a warm haze that matches the sky's glow at the horizon.
    vec3 haze = mix(vec3(0.016, 0.013, 0.010), vec3(0.075, 0.050, 0.026), clamp(f * 1.3, 0.0, 1.0));
    return mix(col, haze, clamp(f, 0.0, 0.94));
  }`;
const HASH = `float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`;

// Window colours per type: ts gold, css warm rose, md pale stone (warm small windows), config amber steel,
// tests blue-white, images cool teal glass, other dim gold; 7: city hall; 8: district tower.
const TYPE_GLSL = `
  void typeLook(float t, out vec3 glass, out vec3 win, out float lit, out vec2 cell) {
    glass = vec3(0.020, 0.021, 0.024); win = vec3(1.0, 0.70, 0.30); lit = 0.34; cell = vec2(2.6, 3.4);
    if (t < 0.5) { win = vec3(1.0, 0.70, 0.30); lit = 0.36; }
    else if (t < 1.5) { win = vec3(0.98, 0.62, 0.58); lit = 0.32; glass = vec3(0.028, 0.019, 0.021); }
    else if (t < 2.5) { glass = vec3(0.150, 0.138, 0.120); win = vec3(1.0, 0.82, 0.55); lit = 0.22; cell = vec2(3.2, 3.6); }
    else if (t < 3.5) { glass = vec3(0.030, 0.032, 0.036); win = vec3(0.95, 0.62, 0.26); lit = 0.20; cell = vec2(2.0, 3.0); }
    else if (t < 4.5) { glass = vec3(0.040, 0.050, 0.068); win = vec3(0.72, 0.85, 1.0); lit = 0.46; cell = vec2(2.2, 3.0); }
    else if (t < 5.5) { glass = vec3(0.016, 0.034, 0.038); win = vec3(0.45, 0.85, 0.85); lit = 0.16; cell = vec2(4.0, 2.4); }
    else if (t < 6.5) { glass = vec3(0.026, 0.024, 0.022); win = vec3(0.85, 0.66, 0.40); lit = 0.24; }
    else if (t < 7.5) { glass = vec3(0.060, 0.050, 0.036); win = vec3(1.0, 0.78, 0.42); lit = 0.75; cell = vec2(2.2, 3.0); }
    else { glass = vec3(0.020, 0.018, 0.016); win = vec3(1.0, 0.72, 0.34); lit = 0.55; cell = vec2(1.4, 2.0); }
  }`;

export function buildingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `
      attribute vec4 aInfo; // type, seed, heat (0..1), flare (0..1)
      attribute vec4 aFx;   // scan phase (-1 = none), highlight, current, beam
      uniform vec3 uEye; uniform float uScale;
      varying vec3 vW, vN, vL, vSize; varying vec4 vInfo, vFx;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vL = position * vSize; vN = normal; vInfo = aInfo; vFx = aFx;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime, uDim, uFogK, uScale; uniform vec3 uEye;
      varying vec3 vW, vN, vL, vSize; varying vec4 vInfo, vFx;
      ${HASH}
      ${TYPE_GLSL}
      ${FOG}
      void main() {
        vec3 glass, win; float lit; vec2 cell;
        typeLook(vInfo.x, glass, win, lit, cell);
        float heat = vInfo.z, flare = vInfo.w, seed = vInfo.y;
        vec3 col;
        if (vN.y > 0.5) {
          // Roof: dark, a faint gold rim at the parapet, warm when the file was edited today.
          vec2 e = min(vL.xz + vSize.xz * 0.5, vSize.xz * 0.5 - vL.xz);
          float rim = 1.0 - smoothstep(0.0, 0.35, min(e.x, e.y));
          col = glass * 1.6 + vec3(0.886, 0.694, 0.373) * (0.10 * rim + 0.85 * heat + 0.7 * flare) + vec3(1.0, 0.55, 0.2) * 0.35 * heat * heat;
        } else {
          float u = abs(vN.x) > 0.5 ? vL.z : vL.x;
          float v = vL.y;
          vec2 g = vec2(u + 50.0, v - 0.6) / cell;
          vec2 id = floor(g), f = fract(g);
          float r = h21(id + seed * 17.0), r2 = h21(id.yx + seed * 5.3);
          float litP = clamp(lit + heat * 0.65 + flare, 0.0, 1.0);
          float on = step(1.0 - litP, r);
          float flick = 0.55 + 0.45 * r2;
          // Anti-aliased window rectangles with a mullion, fading to their average once smaller than a pixel.
          vec2 fw = clamp(fwidth(g), vec2(1e-4), vec2(1.0));
          vec2 lo = smoothstep(vec2(0.16, 0.20) - fw, vec2(0.16, 0.20) + fw, f), hi = 1.0 - smoothstep(vec2(0.84, 0.80) - fw, vec2(0.84, 0.80) + fw, f);
          float mull = 1.0 - 0.7 * (1.0 - smoothstep(0.0, 0.03 + fw.x, abs(f.x - 0.5)));
          float box = lo.x * hi.x * lo.y * hi.y * mull * step(0.6, v) * step(v, vSize.y - 0.5);
          float inner = 0.75 + 0.25 * smoothstep(0.2, 0.8, f.y); // a soft ceiling light at the top of each window
          float fine = smoothstep(0.25, 0.6, max(fw.x, fw.y));
          float wlit = mix(box * on * flick * inner, litP * 0.62, fine);
          vec3 wc = mix(win, vec3(1.0, 0.80, 0.45), heat * 0.6);
          float sky = smoothstep(0.0, 1.0, v / max(vSize.y, 1.0));
          // Glass: dark, with a faint reflection of the warm sky that grows toward the top, and unlit windows a touch lighter.
          col = glass * (0.7 + 0.6 * sky) + vec3(0.03, 0.022, 0.014) * sky * (1.0 - fine) * box * (1.0 - on);
          col += wc * wlit * (0.78 + 0.6 * heat + 1.2 * flare);
          col += vec3(0.886, 0.694, 0.373) * flare * 0.25;
          // Heat (edited in the last hour): a warm amber uplight from the street, fading over the hour.
          col += vec3(1.0, 0.58, 0.22) * heat * 0.55 * (1.0 - smoothstep(0.0, 14.0, v));
          // Read: a cool white scan line moving down the facade.
          if (vFx.x >= 0.0) { float y = vSize.y * (1.0 - vFx.x); float b = exp(-abs(v - y) * 1.6); col += vec3(0.80, 0.90, 1.0) * b * 1.2; }
          // Ground floor lobby glow.
          col += win * 0.10 * (1.0 - smoothstep(0.0, 1.4, v));
        }
        // Landmarks (city hall, the district towers): gold light strips up the corners and a lit crown.
        if (vInfo.x > 6.5 && vN.y < 0.5) {
          float u2 = abs(vN.x) > 0.5 ? vL.z : vL.x, hw2 = abs(vN.x) > 0.5 ? vSize.z * 0.5 : vSize.x * 0.5;
          float strip = 1.0 - smoothstep(0.0, 0.45, hw2 - abs(u2));
          float crown = smoothstep(vSize.y - 3.0, vSize.y - 0.5, vL.y);
          col += vec3(0.886, 0.694, 0.373) * (strip * 0.9 + crown * 0.8) * (vInfo.x > 7.5 ? 1.0 : 0.45);
        }
        // Hovered or current: a gold edge light.
        vec2 ee = abs(vL.xz) - vSize.xz * 0.5 + 0.25;
        float edge = vN.y > 0.5 ? 0.0 : step(0.0, max(ee.x, ee.y)) * 0.0 + (1.0 - smoothstep(0.0, 0.5, vSize.y - vL.y));
        col += vec3(0.886, 0.694, 0.373) * (vFx.y * 0.9 + vFx.z * 0.35) * (0.35 + 0.65 * edge);
        col = cityFog(col, vW);
        col *= 1.0 - 0.55 * uDim;
        gl_FragColor = vec4(col, 1.0);
        /* colours are display-space (pi-web hex), written as they are */
      }`,
  });
}

/** Block plinths, the avenues and the plaza: one merged mesh. aBlk = (local x, local z, half w, half d);
 * aKind = (kind, block index, depth, 0): kind 0 block top, 1 block side, 2 road, 3 plaza. Heat comes from a
 * small data texture indexed by block. */
export function groundMaterial(heatTex, n) {
  return new THREE.ShaderMaterial({
    uniforms: {...U, uHeat: {value: heatTex}, uN: {value: n}}, side: THREE.DoubleSide,
    vertexShader: `
      attribute vec4 aBlk; attribute vec4 aKind;
      varying vec3 vW; varying vec4 vBlk, vKind;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vBlk = aBlk; vKind = aKind; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime, uDim, uFogK, uScale, uN; uniform vec3 uEye; uniform sampler2D uHeat;
      varying vec3 vW; varying vec4 vBlk, vKind;
      ${HASH}
      ${FOG}
      void main() {
        float k = vKind.x;
        vec3 gold = vec3(0.886, 0.694, 0.373);
        vec2 e = vBlk.zw - abs(vBlk.xy); float ed = min(e.x, e.y);
        vec3 col;
        if (k < 0.5) {
          float heat = texture2D(uHeat, vec2((vKind.y + 0.5) / uN, 0.5)).r;
          col = vec3(0.045, 0.043, 0.040) + vec3(0.006) * vKind.z;
          float kerb = 1.0 - smoothstep(0.0, 0.22 + 0.05 * vKind.z, ed);
          col += gold * kerb * (0.30 + 0.35 * heat);
          col += gold * heat * 0.45;
        } else if (k < 1.5) {
          col = vec3(0.016, 0.015, 0.014) + gold * 0.05 * smoothstep(0.0, 0.5, fract(vW.y / uScale));
        } else if (k < 2.5) {
          // Avenue: dark asphalt, a dashed gold centre line, warm street lamps along both kerbs.
          col = vec3(0.012);
          float along = vKind.w > 0.5 ? vBlk.y : vBlk.x, across = vKind.w > 0.5 ? vBlk.x : vBlk.y, hw = vKind.w > 0.5 ? vBlk.z : vBlk.w;
          col += gold * 0.55 * (1.0 - smoothstep(0.06, 0.16, abs(across))) * step(0.5, fract(along / 7.0));
          float lamp = exp(-pow((hw - abs(across)) * 0.9, 2.0)) * (0.5 + 0.5 * cos(along * 6.2831 / 18.0));
          col += gold * 0.18 * lamp;
        } else {
          // The civic plaza: polished dark stone with a gold inlay ring around city hall.
          col = vec3(0.034, 0.032, 0.030);
          float r = length(vBlk.xy + vec2(0.0, 4.0));
          col += gold * 0.35 * (1.0 - smoothstep(0.0, 0.25, abs(r - 30.0)));
          col += gold * 0.12 * (1.0 - smoothstep(0.0, 0.3, ed));
          col += vec3(0.01) * step(0.96, fract(vBlk.x / 6.0)) + vec3(0.01) * step(0.96, fract(vBlk.y / 6.0));
        }
        col = cityFog(col, vW);
        col *= 1.0 - 0.55 * uDim;
        gl_FragColor = vec4(col, 1.0);
        /* colours are display-space (pi-web hex), written as they are */
      }`,
  });
}

/** The night sky dome: near-black overhead, a warm ember glow low over the city (the boot splash's glow). */
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U, side: THREE.BackSide, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform float uDim; varying vec3 vD; ${HASH}
      void main() {
        float el = vD.y;
        vec3 col = mix(vec3(0.030, 0.022, 0.014), vec3(0.004, 0.004, 0.006), smoothstep(-0.05, 0.45, el));
        col += vec3(0.886, 0.55, 0.24) * 0.075 * exp(-abs(el) * 6.0);
        vec2 sp = vec2(atan(vD.x, vD.z) * 160.0, el * 320.0);
        float s = step(0.9965, h21(floor(sp))) * smoothstep(0.08, 0.5, el);
        col += vec3(0.8, 0.78, 0.7) * s * 0.55;
        col *= 1.0 - 0.5 * uDim;
        gl_FragColor = vec4(col, 1.0);
        /* colours are display-space (pi-web hex), written as they are */
      }`,
  });
}

/** The ground beyond the city: the bg colour with faint warm dust, fading into the haze. */
export function farGroundMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uDim, uFogK, uScale; uniform vec3 uEye; varying vec3 vW; ${HASH} ${FOG}
      void main() { vec3 col = vec3(0.014, 0.013, 0.012); col = cityFog(col, vW); col *= 1.0 - 0.55 * uDim; gl_FragColor = vec4(col, 1.0);
        /* colours are display-space (pi-web hex), written as they are */
      }`,
  });
}
