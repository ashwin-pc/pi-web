// WebXR: session start/end and recentring, controllers and hands (rays, joints, thumbstick flicks, buttons),
// and the desktop chrome (Enter VR button, the iframe / no-headset fallback message). Adapted from vr-breeze.
import * as THREE from 'three';
import {S} from './state.js';
import * as V from './views.js';
import {A, renderer, scene, uiRoot, nowMs, clamp, EYE} from './core.js';
import {hint, dock, switchBy, openReader, closeReader, goHome} from './app.js';
import {Pointer, pointers, pressStart, pressEnd, haptic, logInput} from './input.js';
import {desk} from './desktop.js';

const UI = V.UI;
const tmpV = new THREE.Vector3();
// ------------------------------------------------------------------ XR session + input
export const xrStatus = {supported: false, summary: 'not checked'};
export const xrPointers = new Map();
const xrVisuals = new THREE.Group();
scene.add(xrVisuals);
const rayGeo = new THREE.CylinderGeometry(0.0006, 0.0013, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
const reticleGeo = new THREE.RingGeometry(0.005, 0.0085, 28);
// Rays, reticles and controller stubs for every pointer are drawn as ONE mesh (one draw call per eye, not six):
// each frame their template geometry is transformed on the CPU into a shared vertex buffer with RGBA vertex colours.
const BATCH_MAX = 4096;
const batchPos = new THREE.BufferAttribute(new Float32Array(BATCH_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
const batchCol = new THREE.BufferAttribute(new Float32Array(BATCH_MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
const batchGeo = new THREE.BufferGeometry(); batchGeo.setAttribute('position', batchPos); batchGeo.setAttribute('color', batchCol);
const batch = new THREE.Mesh(batchGeo, new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, depthTest: false, depthWrite: false, toneMapped: false}));
batch.frustumCulled = false; batch.renderOrder = 20; batch.name = 'xr-batch';
scene.add(batch);
const tpl = (g, rgba) => ({p: (g.index ? g.toNonIndexed() : g).attributes.position.array, rgba});
const TPL = {ray: tpl(rayGeo, [1, 1, 1, 0.35]), reticle: tpl(reticleGeo, [1, 1, 1, 0.9]), stub: tpl(new THREE.BoxGeometry(0.03, 0.024, 0.1), [0.025, 0.025, 0.025, 1])};
const jointGeo = new THREE.SphereGeometry(1, 10, 8);
const jointMat = new THREE.MeshBasicMaterial({color: 0xd6d3cd, transparent: true, opacity: 0.85, toneMapped: false});
function visualsFor(p) {
  if (p.vis) return p.vis;
  const ray = new THREE.Object3D(), reticle = new THREE.Object3D(), stub = new THREE.Object3D(); // transforms only
  const joints = new THREE.InstancedMesh(jointGeo, jointMat, 25); joints.frustumCulled = false;
  xrVisuals.add(ray, reticle, stub, joints);
  p.vis = {ray, reticle, stub, joints};
  return p.vis;
}
function pointerFor(src) {
  let p = xrPointers.get(src);
  if (!p) {
    const kind = src.targetRayMode === 'transient-pointer' ? 'transient' : src.hand ? 'hand' : 'controller';
    p = new Pointer(kind, src);
    xrPointers.set(src, p);
  }
  return p;
}
const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3();
function setRayFromPose(p, pose) {
  if (!pose) { p.valid = false; return; }
  m4.fromArray(pose.transform.matrix); m4.decompose(p4, q4, s4);
  p.ray.origin.copy(p4); p.ray.direction.set(0, 0, -1).applyQuaternion(q4); p.valid = true;
}
function poseNow(e, p) { try { setRayFromPose(p, e.frame.getPose(e.inputSource.targetRaySpace, renderer.xr.getReferenceSpace())); } catch { /* last pose */ } }
function onSelectStart(e) { const p = pointerFor(e.inputSource); poseNow(e, p); pressStart(p); }
function onSelectEnd(e) { const p = pointerFor(e.inputSource); poseNow(e, p); pressEnd(p); }
function onSourcesChange(e) { for (const src of e.removed || []) { const p = xrPointers.get(src); if (p) { if (p.vis) for (const o of Object.values(p.vis)) xrVisuals.remove(o); pointers.delete(p); xrPointers.delete(src); } } }
const QX = new URLSearchParams(location.search);
// Render scale 0.8 by default (measured: the biggest single gain after the far level of detail); MSAA stays on.
export const XR_SCALE = +(QX.get('xrscale') || 0.8), XR_AA = QX.get('xraa') !== '0';
let xrSession = null, needRecenter = false;
export async function enterVR() {
  if (xrSession) { await xrSession.end(); return; }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {optionalFeatures: ['local-floor', 'hand-tracking', 'layers']});
    xrSession = session;
    renderer.xr.setFoveation(0.2);
    // Headset render cost: ?xrscale= sets the framebuffer scale (XR_SCALE by default), and ?xraa=0 turns off MSAA
    // for the headset only (three reads the context's antialias attribute when the session starts).
    renderer.xr.setFramebufferScaleFactor(XR_SCALE);
    if (!XR_AA) { const gl = renderer.getContext(), get = gl.getContextAttributes.bind(gl); gl.getContextAttributes = () => ({...get(), antialias: false}); }
    await renderer.xr.setSession(session);
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('selectend', onSelectEnd);
    session.addEventListener('inputsourceschange', onSourcesChange);
    session.addEventListener('end', () => {
      xrSession = null;
      for (const p of [...xrPointers.values()]) { if (p.vis) for (const o of Object.values(p.vis)) xrVisuals.remove(o); pointers.delete(p); }
      xrPointers.clear();
      uiRoot.position.set(0, 0, 0); uiRoot.rotation.set(0, 0, 0);
      UI.xr = false; hint.invalidate(); dock.invalidate();
      setStatus(); document.body.classList.remove('presenting');
    });
    needRecenter = true; UI.xr = true; hint.invalidate(); dock.invalidate();
    document.body.classList.add('presenting');
    setStatus();
  } catch (err) { showMsg(`Could not start VR: ${err?.message || err}`); }
}
function recenterTo(pose) {
  m4.fromArray(pose.transform.matrix); m4.decompose(p4, q4, s4);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q4);
  uiRoot.position.set(p4.x, p4.y - EYE, p4.z);
  uiRoot.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
}
/** What the controllers ask for this frame: flight (left stick), altitude (right stick y, city view), grabs (grips). */
export const xrInput = {fwd: 0, strafe: 0, climb: 0, grabs: []};
/** Left stick: fly horizontally in the head's yaw direction (constant speed while held, no ramps). */
function leftStick(p, gp) {
  const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0, ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
  const dz = (v) => (Math.abs(v) < 0.18 ? 0 : Math.sign(v) * Math.min(1, (Math.abs(v) - 0.18) / 0.62));
  xrInput.fwd = -dz(ay); xrInput.strafe = dz(ax);
  if (xrInput.fwd || xrInput.strafe) logInput('stick:fly');
  buttons(p, gp, 'left');
}
/** A, X, stick clicks: what needs me. B: back to the city while reading, else Home. Y: Home. */
function buttons(p, gp, side) {
  const st = p.btn ||= {};
  const click = !!gp.buttons?.[3]?.pressed, b4 = !!gp.buttons?.[4]?.pressed, b5 = !!gp.buttons?.[5]?.pressed;
  if (click && !st.click) { UI.needsYou(); haptic(p, 0.4, 25); logInput(`stick:click:${side}`); }
  if (b4 && !st.b4) { UI.needsYou(); logInput(side === 'left' ? 'button:x' : 'button:a'); }
  if (b5 && !st.b5) { if (side === 'right' && S.reading) closeReader(); else goHome(); logInput(side === 'left' ? 'button:y' : 'button:b'); }
  st.click = click; st.b4 = b4; st.b5 = b5;
}
/** Right stick: a flick = one session (x), from anywhere, with the ray anywhere; holding x repeats with acceleration.
 * y: altitude in the city view; while reading, a flick is one turn and holding scrolls smoothly. */
function stick(p, gp, dt) {
  const st = p.stick ||= {xDir: 0, xNext: 0, xCount: 0, yOn: false, y0: 0, yPeak: 0, ySign: 0, click: false, a: false};
  const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0, ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
  const t = nowMs();
  if (!S.reading) st.yOn = false;
  if (!S.reading && st.xDir === 0 && Math.abs(ay) > 0.2 && Math.abs(ay) > Math.abs(ax)) { xrInput.climb = -Math.sign(ay) * Math.min(1, (Math.abs(ay) - 0.2) / 0.6); logInput('stick:altitude'); }
  if (st.xDir === 0) {
    if (Math.abs(ax) > 0.6 && Math.abs(ax) > Math.abs(ay) && (!st.yOn || !S.reading)) { st.xDir = Math.sign(ax); switchBy(st.xDir); haptic(p, 0.4, 20); logInput('stick:flick-x'); st.xCount = 1; st.xNext = t + 420; }
  } else if (Math.abs(ax) < 0.3) st.xDir = 0;
  else if (t >= st.xNext) { switchBy(st.xDir); haptic(p, 0.25, 12); st.xCount++; st.xNext = t + Math.max(110, 300 * Math.pow(0.8, st.xCount - 2)); }
  const a = Math.abs(ay);
  if (st.xDir === 0 && S.reading) {
    if (!st.yOn && a > 0.15 && a >= Math.abs(ax)) { st.yOn = true; st.y0 = t; st.yPeak = a; st.ySign = Math.sign(ay); }
    if (st.yOn) {
      st.yPeak = Math.max(st.yPeak, a);
      if (a < 0.15) {
        st.yOn = false;
        // A sharp flick (full deflection, released quickly) snaps to the next / previous turn start.
        if (!S.reading) { /* town view: vertical does nothing */ }
        else if (t - st.y0 < 280 && st.yPeak > 0.7) { A.active.stepTurn(st.ySign); haptic(p, 0.3, 14); logInput('stick:flick-y'); }
        else A.active.drag = false; // inertia carries on
      } else if (S.reading && !(st.yPeak > 0.7 && t - st.y0 < 200)) {
        const r = A.active;
        r.anim = null; r.drag = false;
        r.vel = Math.sign(ay) * Math.pow(clamp((a - 0.15) / 0.85, 0, 1), 1.6) * 2600;
      }
    }
  }
  buttons(p, gp, 'right');
}
export function xrFrame(frame, dt) {
  const ref = renderer.xr.getReferenceSpace();
  xrInput.fwd = 0; xrInput.strafe = 0; xrInput.climb = 0; xrInput.grabs = [];
  // The head, from the viewer pose of this very frame (the XR camera object lags a frame and may hold one eye's pose).
  const vpose = frame.getViewerPose(ref);
  if (vpose) { m4.fromArray(vpose.transform.matrix); m4.decompose(p4, q4, s4); (A.viewer ||= {pos: new THREE.Vector3(), quat: new THREE.Quaternion()}).pos.copy(p4); A.viewer.quat.copy(q4); }
  if (needRecenter) { const vp = frame.getViewerPose(ref); if (vp) { recenterTo(vp); needRecenter = false; } }
  for (const src of frame.session.inputSources) {
    const p = pointerFor(src);
    const v = visualsFor(p);
    setRayFromPose(p, frame.getPose(src.targetRaySpace, ref));
    const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
    if (grip) { m4.fromArray(grip.transform.matrix); p.grip = (p.grip || new THREE.Vector3()).setFromMatrixPosition(m4); } else p.grip = null;
    v.stub.visible = p.kind === 'controller' && !!grip;
    if (v.stub.visible) { m4.decompose(v.stub.position, v.stub.quaternion, s4); }
    v.joints.visible = false;
    if (src.hand && frame.getJointPose) {
      let n = 0;
      for (const space of src.hand.values()) {
        const jp = frame.getJointPose(space, ref);
        if (!jp) continue;
        m4.fromArray(jp.transform.matrix); m4.decompose(p4, q4, s4);
        s4.setScalar(Math.max(0.004, (jp.radius || 0.008) * 0.9));
        m4.compose(p4, q4, s4); v.joints.setMatrixAt(n++, m4);
      }
      v.joints.count = n; v.joints.instanceMatrix.needsUpdate = true; v.joints.visible = n > 0;
    }
    if (src.gamepad && src.gamepad.axes && !src.hand) {
      if (src.handedness === 'left') leftStick(p, src.gamepad); else stick(p, src.gamepad, dt);
      // Grip: grab the world (one hand pans; both hands pan, rotate and scale).
      if (src.gamepad.buttons?.[1]?.pressed && grip) { xrInput.grabs.push({p: uiRoot.worldToLocal(p.grip.clone()), o: uiRoot.worldToLocal(p.ray.origin.clone()), d: p.ray.direction.clone().transformDirection(new THREE.Matrix4().copy(uiRoot.matrixWorld).invert()), side: src.handedness}); if (!p.gripping) logInput(`grip:${src.handedness}`); p.gripping = true; } else p.gripping = false;
    }
  }
  xrInput.grabs.sort((a, b) => (a.side < b.side ? -1 : 1));
}
export function updateXRVisuals() {
  for (const p of xrPointers.values()) {
    const v = visualsFor(p);
    const showRay = p.valid && (p.kind === 'controller' || p.kind === 'hand');
    const len = p.hit ? p.hit.distance : 1.2;
    v.ray.visible = showRay;
    if (showRay) { v.ray.position.copy(p.ray.origin); v.ray.lookAt(tmpV.copy(p.ray.origin).add(p.ray.direction)); v.ray.scale.set(1, 1, len); }
    const showRet = p.valid && !!p.hit && (p.kind !== 'transient' || !!p.press);
    v.reticle.visible = showRet;
    if (showRet) {
      v.reticle.position.copy(p.hit.point).addScaledVector(p.ray.direction, -0.003);
      v.reticle.lookAt(tmpV.copy(p.hit.point).sub(p.ray.direction));
      v.reticle.scale.setScalar(clamp(p.hit.distance, 0.3, 3) * (p.press ? 0.8 : 1));
    }
  }
  // Fill the shared batch.
  let n = 0;
  const put = (o, t) => {
    if (!o.visible) return;
    o.updateMatrixWorld(true);
    const e = o.matrixWorld.elements, P = batchPos.array, C = batchCol.array;
    for (let i = 0; i < t.p.length && n < BATCH_MAX; i += 3, n++) {
      const x = t.p[i], y = t.p[i + 1], z = t.p[i + 2];
      P[n * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[n * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[n * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      C.set(t.rgba, n * 4);
    }
  };
  for (const p of xrPointers.values()) if (p.vis) { put(p.vis.stub, TPL.stub); put(p.vis.ray, TPL.ray); put(p.vis.reticle, TPL.reticle); }
  batchGeo.setDrawRange(0, n); batch.visible = n > 0;
  batchPos.needsUpdate = true; batchCol.needsUpdate = true;
}
// ------------------------------------------------------------------ DOM chrome (desktop only)
const statusEl = document.getElementById('xrStatus');
const btn = document.getElementById('enterVR');
const msgEl = document.getElementById('xrMsg');
export const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
function fullPageUrl() { return location.href.split('#')[0]; }
let msgTimer = 0;
/** autoHideMs: a note that only explains the desktop preview fades after a while (Enter VR's tooltip keeps the reason). */
function showMsg(html, autoHideMs = 0) {
  clearTimeout(msgTimer);
  msgEl.innerHTML = html ? `<button class="close" type="button" aria-label="Dismiss">×</button>${html}` : '';
  msgEl.hidden = !html;
  msgEl.querySelector('.close')?.addEventListener('click', () => { msgEl.hidden = true; });
  if (html && autoHideMs) msgTimer = setTimeout(() => { msgEl.hidden = true; }, autoHideMs);
}
function setStatus() { btn.textContent = xrSession ? 'Exit VR' : 'Enter VR'; btn.disabled = !xrStatus.supported && !xrSession; btn.title = xrStatus.supported || xrSession ? '' : xrStatus.summary; }
/** Why Enter VR is unavailable, and the desktop preview message. WebXR needs a secure context (HTTPS or localhost) and
 * a top-level page; the desktop preview (mouse and keyboard) works everywhere. */
async function detectXR() {
  statusEl.textContent = 'Desktop preview';
  if (inIframe) {
    xrStatus.summary = 'inside an iframe: immersive sessions are blocked here';
    showMsg(`<b>VR can't start inside a frame.</b> The desktop preview runs instead. <a id="openFull" href="${fullPageUrl()}" target="_blank" rel="noopener">Open the full page to enter VR ↗</a>`);
    setStatus();
    return;
  }
  if (!window.isSecureContext) {
    xrStatus.summary = 'WebXR needs a secure context (HTTPS or localhost)';
    showMsg('<b>Enter VR needs HTTPS or localhost.</b> This page was opened over plain HTTP, so the browser hides WebXR. The desktop preview works with the keyboard and mouse. Open pi-web over HTTPS (for example through your tunnel) on the headset.');
    setStatus();
    return;
  }
  if (!('xr' in navigator) || !navigator.xr) {
    xrStatus.summary = 'WebXR is not available in this browser';
    showMsg('<b>WebXR isn\'t available in this browser.</b> The desktop preview works with the keyboard and mouse. Open this page in Meta Quest Browser or Safari on Apple Vision Pro to enter VR.');
    setStatus();
    return;
  }
  try { xrStatus.supported = await navigator.xr.isSessionSupported('immersive-vr'); } catch (err) { xrStatus.supported = false; xrStatus.error = String(err?.message || err); }
  xrStatus.summary = xrStatus.supported ? 'immersive-vr supported' : 'no immersive-vr device';
  if (xrStatus.supported) { showMsg(''); statusEl.textContent = 'Headset ready'; }
  else showMsg('<b>No VR headset detected.</b> This is the desktop preview. On Quest or Vision Pro, open this page and select Enter VR.', 8000);
  setStatus();
}
btn.addEventListener('click', () => { if (xrStatus.supported || xrSession) enterVR(); });
document.getElementById('overviewBtn')?.addEventListener('click', () => { desk.view = desk.view === 'wide' ? 'auto' : 'wide'; });
detectXR();

export {showMsg};
