// Flying: the viewpoint moves only on your own flight input (stick, grips, pinch-drag, WASD) or an explicit
// "fly to" / Home. Switching sessions never moves you. The rig is {pos, yaw, scale} in city metres: the city is drawn
// through the inverse of that transform, so flying, grabbing and the tabletop "god mode" are all one model. Yaw only:
// the horizon is always level, nothing rolls. A vignette narrows the view while you move (toggle in More).
import * as THREE from 'three';
import {S} from './state.js';
import {animMs, clamp} from './core.js';

export const nav = {pos: new THREE.Vector3(), yaw: 0, scale: 1, anim: null, log: [], speed: 0, moving: 0, vignette: true};
export const FLY_MS = 900, BLINK_MS = 150;
const EYE = 1.6, Y = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
let home = null;

/** The mayor's vantage: above city hall (just behind it), 150 m up, facing the middle between the districts. */
export function setHome(L) {
  const h = L.hall, eye = new THREE.Vector3(h.x - 30, 150, h.z + 48);
  // Face the middle between the districts' centres, so every workspace is in front of you.
  const ds = L.districts.filter((d) => !d.node.meta?.big), c = {x: ds.reduce((a, d) => a + (d.rect.x0 + d.rect.x1) / 2, 0) / ds.length, z: ds.reduce((a, d) => a + (d.rect.z0 + d.rect.z1) / 2, 0) / ds.length};
  const yaw = Math.atan2(-(c.x - eye.x), -(c.z - eye.z));
  home = {pos: eye.clone().sub(new THREE.Vector3(0, EYE, 0)), yaw, scale: 1};
  return home;
}
export const homeView = () => home;
/** City-space position of a user-space point (eye, hand). */
export function toCity(u, out = new THREE.Vector3()) { q.setFromAxisAngle(Y, nav.yaw); return out.copy(u).multiplyScalar(nav.scale).applyQuaternion(q).add(nav.pos); }
export function apply(root) {
  q.setFromAxisAngle(Y, -nav.yaw);
  root.quaternion.copy(q);
  root.scale.setScalar(1 / nav.scale);
  root.position.copy(nav.pos).applyQuaternion(q).multiplyScalar(-1 / nav.scale);
  root.updateMatrixWorld(true);
}
export function set(v) { nav.pos.copy(v.pos); nav.yaw = v.yaw; nav.scale = v.scale; }
export const snapshot = () => ({pos: nav.pos.clone(), yaw: nav.yaw, scale: nav.scale});
/** Eye altitude above the ground, in city metres. */
export function altitude(eyeU) { return toCity(eyeU || tmp.set(0, EYE, 0)).y; }

// ------------------------------------------------------------------ continuous flight (stick, keys)
/** Fly horizontally in the head's yaw direction: fwd/strafe in [-1, 1]. Speed scales with altitude: crossing the
 * city takes a few seconds from 120 m, and it is slow near rooftops. Constant speed while held (no ramps). */
export function fly(headYaw, fwd, strafe, climb, dt, eyeU) {
  if (nav.anim) return;
  const alt = Math.max(2, altitude(eyeU));
  const v = clamp(alt * 0.9, 4, 700) * (nav.scale > 3 ? 0.25 : 1);
  const yaw = headYaw + nav.yaw;
  const dx = (-Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) * v * dt, dz = (-Math.cos(yaw) * fwd - Math.sin(yaw) * strafe) * v * dt;
  nav.pos.x += dx; nav.pos.z += dz;
  if (climb) { const dy = climb * clamp(alt * 0.8, 3, 400) * dt; nav.pos.y = clamp(nav.pos.y + dy, 2.5 - EYE * nav.scale, 1400); }
  nav.speed = Math.max(nav.speed, Math.hypot(dx, dz, climb ? 1 : 0) > 0 ? 1 : 0);
}

// ------------------------------------------------------------------ grabbing the world (grips, pinch-drag)
/** grabs: [{p, o, d}] for each grabbing hand this frame (position, and its ray's origin and direction, in your
 * space). Starts / continues / ends the grab. One hand whose ray points at the ground drags that point of the ground
 * (so a pan works from any altitude, as in Google Earth VR); otherwise the city point at the hand follows the hand.
 * Two hands pan, rotate (about the vertical only) and scale. */
const G = {active: [], start: null};
const groundHit = (o, d, y) => { const oc = toCity(o.clone()), dc = d.clone().applyQuaternion(q.setFromAxisAngle(Y, nav.yaw)); if (dc.y > -0.05) return null; const t = (y - oc.y) / dc.y; return t > 0 ? oc.add(dc.multiplyScalar(t)) : null; };
export function grab(points) {
  if (nav.anim) { G.start = null; return; }
  const n = points.length;
  if (!n) { G.start = null; G.n = 0; return; }
  if (!G.start || G.n !== n) {
    G.n = n;
    const g = n === 1 && points[0].d ? groundHit(points[0].o, points[0].d, 0.6) : null;
    G.start = {cityPts: points.map((p) => toCity(p.p.clone())), ground: g, snap: snapshot()};
    return;
  }
  const A = G.start.cityPts;
  if (n === 1 && G.start.ground) {
    const h = groundHit(points[0].o, points[0].d, G.start.ground.y);
    if (h) { nav.pos.x += G.start.ground.x - h.x; nav.pos.z += G.start.ground.z - h.z; }
  } else if (n === 1) {
    q.setFromAxisAngle(Y, nav.yaw);
    nav.pos.copy(A[0]).sub(points[0].p.clone().multiplyScalar(nav.scale).applyQuaternion(q));
  } else {
    const a = points[0].p, b = points[1].p;
    const dU = Math.hypot(b.x - a.x, b.z - a.z), dC = Math.hypot(A[1].x - A[0].x, A[1].z - A[0].z);
    const s = clamp(dC / Math.max(1e-4, dU), 0.25, 1500);
    const angU = Math.atan2(b.x - a.x, b.z - a.z), angC = Math.atan2(A[1].x - A[0].x, A[1].z - A[0].z);
    nav.scale = s; nav.yaw = angC - angU;
    const mU = a.clone().add(b).multiplyScalar(0.5), mC = A[0].clone().add(A[1]).multiplyScalar(0.5);
    q.setFromAxisAngle(Y, nav.yaw);
    nav.pos.copy(mC).sub(mU.multiplyScalar(nav.scale).applyQuaternion(q));
  }
  nav.speed = 1;
}
export const grabbing = () => !!G.start;

// ------------------------------------------------------------------ fly to / home (≤ 1 s, or a blink)
/** An overlook of a place: keep your heading, come in from behind so it sits about 40° below your eye line. */
export function overlook(place, headYaw, eyeU) {
  const alt = Math.max(clamp(place.size * 0.8, 55, 220), (place.top || 0) + 32);
  const yaw = headYaw + nav.yaw, back = alt / Math.tan(40 * Math.PI / 180);
  const eye = new THREE.Vector3(place.x + Math.sin(yaw) * back, place.y + alt, place.z + Math.cos(yaw) * back);
  q.setFromAxisAngle(Y, nav.yaw);
  const pos = eye.sub((eyeU ? eyeU.clone() : new THREE.Vector3(0, EYE, 0)).applyQuaternion(q));
  return {pos, yaw: nav.yaw, scale: 1, place};
}
/** Animate to a view: a short arc in at most FLY_MS with the vignette, or a blink with reduce-motion. */
export function flyTo(view, key = 'fly') {
  const from = snapshot();
  const dist = from.pos.distanceTo(view.pos);
  nav.anim = {from, to: view, t0: animMs(), dur: S.reduceMotion ? 2 * BLINK_MS : FLY_MS, blink: S.reduceMotion, lift: Math.min(120, dist * 0.18), key, applied: false};
  nav.log.push({t: Math.round(animMs()), key, phase: 'start', dur: nav.anim.dur});
  return true;
}
export function goHome(headYaw = 0) { const h = home; return flyTo({pos: h.pos.clone(), yaw: h.yaw - headYaw, scale: 1}, 'home'); }
/** Per frame: advance the animation; returns the blink fade (0..1) for the fade sphere. */
let lastTick = 0;
function dtTick() { const t = performance.now(), d = lastTick ? Math.min(0.1, (t - lastTick) / 1000) : 0.016; lastTick = t; return d; }
export function tick() {
  const a = nav.anim; nav.moving = Math.max(nav.moving * Math.exp(-(dtTick()) / 0.1), nav.speed); nav.speed = 0;
  if (!a) return 0;
  const u = clamp((animMs() - a.t0) / a.dur, 0, 1);
  if (a.blink) {
    const fade = u < 0.5 ? u * 2 : 2 - u * 2;
    if (u >= 0.5 && !a.applied) { set(a.to); a.applied = true; nav.log.push({t: Math.round(animMs()), key: a.key, phase: 'applied'}); }
    if (u >= 1) { nav.anim = null; nav.log.push({t: Math.round(animMs()), key: a.key, phase: 'done'}); }
    return fade;
  }
  const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  nav.pos.lerpVectors(a.from.pos, a.to.pos, e); nav.pos.y += Math.sin(Math.PI * e) * a.lift;
  let dy = a.to.yaw - a.from.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  nav.yaw = a.from.yaw + dy * e;
  nav.scale = Math.exp(Math.log(a.from.scale) + (Math.log(a.to.scale) - Math.log(a.from.scale)) * e);
  nav.speed = 1;
  if (u >= 1) { set(a.to); nav.anim = null; nav.log.push({t: Math.round(animMs()), key: a.key, phase: 'done'}); }
  return 0;
}

// ------------------------------------------------------------------ comfort: the vignette and the blink fade
export function buildComfort(camera) {
  const vig = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: {uA: {value: 0}}, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uA; varying vec2 vP; void main(){ float r = length(vP); float a = smoothstep(0.13, 0.32, r) * uA * 0.9; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }',
  }));
  vig.position.z = -0.12; vig.scale.setScalar(0.6); vig.renderOrder = 1001; vig.frustumCulled = false; vig.visible = false; vig.name = 'vignette';
  const fade = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({color: 0, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false}));
  fade.renderOrder = 1002; fade.visible = false; fade.name = 'blink';
  camera.add(vig, fade);
  return {vig, fade, update(blink) {
    const want = S.vignette !== false ? clamp(nav.moving, 0, 1) : 0;
    vig.material.uniforms.uA.value = want; vig.visible = want > 0.03;
    fade.material.opacity = blink; fade.visible = blink > 0.001;
  }};
}
