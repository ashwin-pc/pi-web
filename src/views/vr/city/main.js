// City (the pi-web VR view, ported from the vr-city mock): you are the mayor, flying over a night city that is your file system. Directories are blocks,
// files are buildings, gold beams show where sessions are working, and a floating bar of pi-web avatars shows which
// sessions need you. This file wires the modules and runs the frame loop.
import * as THREE from 'three';
import {panels} from './panel.js';
import {S, emit, tickDwell} from './state.js';
import {A, renderer, scene, camera, world, nowMs, QS, tickAnim} from './core.js';
import {readers} from './reader.js';
import {city, bar, pops, comfort, composer, sideBatch, prefetchStep, openReader, tickReaders} from './app.js';
import {followFrame} from './follow.js';
import * as N from './city-nav.js';
import {avatarsReady} from './avatars.js';
import {mouse, pointers, updateHovers, updateHead, head, pressMove, panPoints} from './input.js';
import {updateDeskCamera, updateMouseRay, deskFlight} from './desktop.js';
import {xrFrame, updateXRVisuals, xrInput} from './xr.js';
import './hooks.js';
import {r3} from './r3.js'; // round 3: focus cockpit, layouts, artifacts
import './r3-hooks.js';

A.frames = 0; A.fpsWin = []; A.world = world; A.pops = pops;
avatarsReady.then(() => { bar.invalidate(); for (const r of readers) r.header.invalidate(); city.cards.sig.clear(); });
readers[0].setSession(S.currentId);
if (QS.get('read') === '1') openReader(S.currentId);
// Compile every material now (reading-mode ones included), so the first open does not stall on shader compilation.
{ const hidden = []; scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } }); renderer.compile(scene, camera); for (const o of hidden) o.visible = false; }
let last = nowMs(), lastBlink = 0;
renderer.setAnimationLoop((time, frame) => {
  const t = nowMs();
  tickAnim();
  tickDwell(S.reading);
  const dt = Math.min(0.05, (t - last) / 1000);
  A.fpsWin.push(t - last); if (A.fpsWin.length > 120) A.fpsWin.shift();
  last = t;
  A.frames++;
  if (frame) xrFrame(frame, dt);
  else if (A.debugCam) { camera.position.fromArray(A.debugCam.pos); camera.lookAt(new THREE.Vector3().fromArray(A.debugCam.at)); camera.fov = A.debugCam.fov || 50; camera.updateProjectionMatrix(); camera.updateMatrixWorld(); updateMouseRay(); }
  else { updateDeskCamera(dt); updateMouseRay(); }
  updateHead();
  // Flight: only your own input moves you (stick, grips, pinch-drag, keys), or an explicit fly-to / Home.
  if (frame) { if (xrInput.fwd || xrInput.strafe || xrInput.climb) N.fly(head.yaw, xrInput.fwd, xrInput.strafe, xrInput.climb, dt, head.local); }
  else deskFlight(dt);
  N.grab(r3.filterGrabs([...xrInput.grabs, ...panPoints()].slice(0, 2)));
  const blink = N.tick();
  N.apply(city.root);
  r3.afterNav(dt);
  comfort.update(blink);
  for (const r of readers) r.tick(dt);
  tickReaders();
  for (const r of readers) r.updateClip();
  r3.frame(dt);
  followFrame(dt);
  updateHovers();
  for (const p of pointers) if (p !== mouse && p.press) pressMove(p);
  if ((S.composer.dictating || S.composer.focused) && t - lastBlink > 120) { composer.invalidate(); lastBlink = t; }
  for (const p of panels) if (!p.isTurn) p.update();
  for (const r of readers) if (r.set?.reader === r) for (const tt of r.set.turns) if (tt.panel.dirty) tt.panel.update(true);
  prefetchStep();
  if (frame) updateXRVisuals();
  sideBatch.sync();
  renderer.render(scene, camera);
});
// Running timers in the bar and the header tick once a second; live data arrives through the client.
const tickTimer = setInterval(() => emit('tick'), 1000);

/** Stop the frame loop and release the GPU resources (the page navigates away afterwards). */
export function disposeCity() {
  clearInterval(tickTimer);
  renderer.setAnimationLoop(null);
  if (renderer.xr.isPresenting) void renderer.xr.getSession()?.end().catch(() => undefined);
  scene.traverse((o) => { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { for (const v of Object.values(m.uniforms || {})) v?.value?.isTexture && v.value.dispose(); m.map?.dispose?.(); m.dispose?.(); } });
  renderer.dispose();
  renderer.domElement.remove();
}
