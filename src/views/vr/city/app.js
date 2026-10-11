// The City's app logic: the city view (fly around, glance at the bar) vs reading (a session's conversation on the
// panel), switching, "what needs me", the panel open/close/switch motion, the composer, flying to places and the
// tabletop. Switching sessions never moves you; only flight input, Home and "fly to" do.
import * as THREE from 'three';
import {Panel, panels} from './panel.js';
import {S, on, emit, get, indicator, sendPrompt, nextNeedingYou, openSession} from './state.js';
import {host} from './host.js';
import * as V from './views.js';
import {City} from './city.js';
import * as N from './city-nav.js';
import {Bar, UIB, PAGE, pages} from './bar.js';
import {BarPops} from './bar-pops.js';
import {PanelBatch} from './panel-batch.js';
import {readers, sets, setFor, VIEW_PX} from './reader.js';
import {A, world, uiRoot, renderer, scene, camera, nowMs, animMs, clamp, easeOut, applyStatus, READER_POS, RH, DEG} from './core.js';

const UI = V.UI;
export const city = new City({scene, parent: uiRoot});
N.setHome(city.L); N.set(N.homeView()); N.apply(city.root);
export const comfort = N.buildComfort(camera);
export const bar = new Bar(uiRoot);
export const pops = new BarPops(bar);
Object.assign(A, {city, bar, nav: N.nav, active: readers[0]});
S.vignette = true;

// The composer is a column to the right of the reading panel; the navigation column (back to the city, what needs
// me, fly there) to its left. Both are drawn by one batched mesh (see panel-batch.js).
export const composer = new Panel('composer', {w: V.COMPOSER.w, h: V.COMPOSER.h, ppm: V.COMPOSER.ppm, draw: V.drawComposer, renderOrder: 5});
world.add(composer.mesh);
export const nav = new Panel('nav', {w: V.NAV.w, h: V.NAV.h, ppm: V.NAV.ppm, draw: V.drawNav, renderOrder: 5});
world.add(nav.mesh);
export const sideBatch = new PanelBatch([nav, composer]);
scene.add(sideBatch.mesh);
export const hint = {invalidate() { for (const r of readers) r.header.invalidate(); nav.invalidate(); bar.invalidate(); }};
export const dock = {invalidate() { bar.invalidate(); }};

// ------------------------------------------------------------------ reader poses (open, close, switch)
const tmp = new THREE.Vector3();
const restPose = () => ({pos: READER_POS.clone(), scale: 1, alpha: 1});
function poseNowOf(r) { return r.pose ? {pos: r.g.position.clone(), scale: r.g.scale.x, alpha: r.alpha} : {pos: READER_POS.clone(), scale: 1, alpha: 0}; }
function animate(r, to, dur = 260) {
  const from = poseNowOf(r);
  if (S.reduceMotion) { r.pose = {from: {...to, alpha: to.alpha > 0 ? 0 : from.alpha}, to, t0: animMs(), dur: 150}; return; }
  r.pose = {from, to, t0: animMs(), dur};
}
/** The panel opens from the avatar you chose (a little below, where the bar is). */
function avatarAnchor(id) { const w = bar.cellWorld(id); if (!w) return READER_POS.clone().add(tmp.set(0, -0.6, 0.5)); return world.worldToLocal(w); }
export const panelLog = [];
export function tickReaders() {
  for (const r of readers) {
    if (!r.pose) { r.setAlpha(0); continue; }
    const {from, to, t0, dur} = r.pose;
    const u = clamp((animMs() - t0) / dur, 0, 1), e = easeOut(u);
    r.g.position.lerpVectors(from.pos, to.pos, e);
    r.g.scale.setScalar(from.scale + (to.scale - from.scale) * e);
    const a = from.alpha + (to.alpha - from.alpha) * (S.reduceMotion ? u : e);
    r.setAlpha(a);
    if (r === A.active && u < 1) { panelLog.push({t: Math.round(animMs()), x: +r.g.position.x.toFixed(4), s: +r.g.scale.x.toFixed(4), a: +a.toFixed(3)}); if (panelLog.length > 400) panelLog.shift(); }
    const k = indicator(get(r.sid) || {});
    applyStatus(r.frame, k === 'running' || k === 'waiting' ? k : 'current', nowMs() / 1000, 0.55);
    r.syncFrameGeo();
  }
}
/** Opening from the city view turns the reading rig (panel and side columns) to face where your head is facing. */
function faceHead() {
  const yaw = A.headYaw ?? 0;
  world.rotation.set(0, yaw, 0); world.updateMatrixWorld(true);
}

// ------------------------------------------------------------------ selection, opening, switching
export const switchLog = [];
let lastSwitch = {at: 0, from: null, to: null};
const mod = (i, n) => ((i % n) + n) % n;
function makeCurrent(id) {
  const prev = get(S.currentId);
  if (!prev || id === prev.id) return null;
  prev.savedScroll = A.active.sid === prev.id ? A.active.dest : prev.savedScroll;
  const prevReader = A.active;
  openSession(id); // emits 'sessions' and 'current'; the "new since you looked" mark; read after a 2 s dwell
  const ps = sets.get(prev.id); if (ps) ps.stale = true;
  const r = readers.find((x) => x !== prevReader);
  r.setSession(id);
  A.active = r;
  lastSwitch = {at: nowMs(), from: prev.id, to: id};
  switchLog.push({t: Math.round(nowMs()), from: prev.id, to: id, nav: N.snapshot()}); if (switchLog.length > 200) switchLog.shift();
  return prevReader;
}
export function openReader(id = S.selectedId) {
  if (!id) return;
  if (!S.reading) faceHead();
  const fromAnchor = avatarAnchor(id);
  if (id !== S.currentId) { const prevReader = makeCurrent(id); if (prevReader && S.reading) animate(prevReader, {pos: READER_POS.clone(), scale: 1, alpha: 0}, 180); }
  else if (A.active.sid !== id) A.active.setSession(id);
  else if (!S.reading) { const set = sets.get(id); if (set?.stale) A.active.setSession(id); }
  S.selectedId = id;
  const r = A.active;
  if (!S.reading) { r.g.position.copy(fromAnchor); r.g.scale.setScalar(0.18); r.pose = {from: {pos: fromAnchor, scale: 0.18, alpha: 0}, to: restPose(), t0: animMs(), dur: S.reduceMotion ? 150 : 280}; if (S.reduceMotion) r.pose.from = {pos: READER_POS.clone(), scale: 1, alpha: 0}; }
  else animate(r, restPose(), 260);
  S.reading = true;
  city.retarget(); hint.invalidate(); composer.invalidate();
  prefetchAround(id);
}
export function closeReader() {
  if (!S.reading) return;
  const r = A.active;
  get(r.sid).savedScroll = r.dest;
  S.reading = false;
  if (S.composer.focused) { S.composer.focused = false; composer.invalidate(); }
  animate(r, {pos: avatarAnchor(r.sid), scale: 0.18, alpha: 0}, 240);
  city.retarget(); hint.invalidate();
}
/** One flick = one session, in the bar's pinned order. From the city view it opens the panel on that session. */
export function switchBy(dir) {
  if (!dir || !S.pinned.length) return;
  S.order = [...S.pinned];
  const base = S.pinned.indexOf(S.currentId);
  const id = S.pinned[mod((base < 0 ? 0 : base) + dir, S.pinned.length)];
  if (!S.reading) { openReader(id); return; }
  switchTo(id, dir);
}
function switchTo(id, dir = 1) {
  const prevReader = makeCurrent(id);
  if (!prevReader) return;
  const off = 0.32 * Math.sign(dir || 1);
  animate(prevReader, {pos: READER_POS.clone().add(tmp.set(-off, 0, 0)), scale: 1, alpha: 0}, 240);
  const r = A.active;
  r.g.position.copy(READER_POS).add(tmp.set(off, 0, 0)); r.g.scale.setScalar(1);
  r.pose = {from: {pos: r.g.position.clone(), scale: 1, alpha: 0}, to: restPose(), t0: animMs(), dur: 260};
  if (S.reduceMotion) { r.pose = {from: {pos: READER_POS.clone(), scale: 1, alpha: 0}, to: restPose(), t0: animMs(), dur: 150}; prevReader.pose = {from: {pos: READER_POS.clone(), scale: 1, alpha: 1}, to: {pos: READER_POS.clone(), scale: 1, alpha: 0}, t0: animMs(), dur: 150}; }
  city.retarget(); hint.invalidate();
  prefetchAround(id);
}
/** Pick a specific session: the city view opens it; while reading it switches to it. */
export function choose(id) {
  if (!id || !get(id)) return;
  if (S.reading) { if (id !== S.currentId) { const d = S.pinned.indexOf(id) - S.pinned.indexOf(S.currentId); switchTo(id, d >= 0 ? 1 : -1); } return; }
  openReader(id);
}
UI.needsYou = () => {
  const s = nextNeedingYou();
  if (!s) { hint.invalidate(); return null; }
  if (S.reading) switchTo(s.id, 1); else openReader(s.id);
  return s.id;
};
UI.closeReader = closeReader;

let prefetchQ = [];
function prefetchAround(id) { const i = S.pinned.indexOf(id), n = S.pinned.length; prefetchQ = [0, 1, -1, 2].map((d) => S.pinned[mod(i + d, n)]).filter((sid) => sid && !(sid === A.active.sid && S.reading)); }
export function prefetchStep() {
  for (const sid of prefetchQ) {
    const set = setFor(sid);
    const t = set.turns.find((x) => x.panel.dirty);
    if (t) { t.panel.update(true); renderer.initTexture(t.panel.tex); return; }
    prefetchQ = prefetchQ.filter((x) => x !== sid);
    return;
  }
}

// ------------------------------------------------------------------ flying to places (only when asked)
export function flyToSession(id) { const p = city.placeOf(id); if (!p) return false; return N.flyTo(N.overlook(p, A.headYaw ?? 0, A.headLocal), `session:${id}`); }
export function flyToPath(path) {
  const b = city.L.byPath.get(path); if (!b) return false;
  if (b.kind === 'home') return N.goHome(A.headYaw ?? 0);
  return N.flyTo(N.overlook(city.placeOfBlock(b), A.headYaw ?? 0, A.headLocal), `block:${path}`);
}
export function goHome() { return N.goHome(A.headYaw ?? 0); }
/** Tabletop ("god mode"): the whole city as a model about 1.3 m across, 0.6 m in front of you at table height. */
let table = false;
export function setTable(onT) {
  table = onT;
  if (!onT) return goHome();
  const b = city.L.bounds, size = Math.max(b.x1 - b.x0, b.z1 - b.z0), scale = size / 1.3, yaw = N.homeView().yaw - (A.headYaw ?? 0);
  const c = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const u = new THREE.Vector3(-Math.sin(A.headYaw ?? 0) * 1.05, 0.85, -Math.cos(A.headYaw ?? 0) * 1.05); // the model's centre, in your space
  return N.flyTo({pos: c.clone().sub(u.multiplyScalar(scale).applyQuaternion(q)), yaw, scale}, 'tabletop');
}
export const isTable = () => table && N.nav.scale > 5;
Object.assign(UIB, {choose, home: goHome, flyToSession, toggleMore: () => { bar.moreOpen = !bar.moreOpen; bar.invalidate(); }, setReduceMotion: (v) => UI.setReduceMotion(v),
  setVignette: (v) => { S.vignette = v; }, toggleTable: () => setTable(!isTable()), isTable, exit: () => host.exit(), page: () => bar.page,
  turnPage: (d) => { bar.page = mod(bar.page + d, pages()); bar.pagePinned = true; bar.invalidate(); }});
Object.assign(A, {flyToSession, flyToPath, goHome, setTable});
UI.goHome = goHome; UI.flyCurrent = () => flyToSession(S.currentId);

// ------------------------------------------------------------------ composer, dictation, settings
UI.toLatest = () => { A.active.to(A.active.maxScroll, 300); A.active.newOutput = false; };
UI.toggleChip = (sid, msg) => { const set = sets.get(sid); if (!set) return; set.expanded.has(msg) ? set.expanded.delete(msg) : set.expanded.add(msg); set.build(); for (const t of set.turns) t.panel.update(true); set.reader?.strip.invalidate(); };
UI.setReduceMotion = (v) => { S.reduceMotion = v; bar.invalidate(); emit('motion'); };
UI.focusComposer = () => { S.composer.focused = true; if (renderer.xr.isPresenting && !S.composer.text) UI.toggleDictation(); composer.invalidate(); };
// Dictation uses the browser's speech recognition where it exists; elsewhere the composer takes typed text (desktop).
let recognition = null;
UI.toggleDictation = () => {
  const c = S.composer;
  if (c.dictating) { recognition?.stop(); c.dictating = false; composer.invalidate(); return; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { c.focused = true; c.unavailable = true; composer.invalidate(); return; }
  recognition = new Recognition();
  recognition.interimResults = true; recognition.continuous = false;
  const base = c.text ? `${c.text} ` : '';
  recognition.onresult = (e) => { c.text = base + [...e.results].map((r) => r[0].transcript).join(''); composer.invalidate(); };
  recognition.onend = () => { c.dictating = false; composer.invalidate(); };
  recognition.onerror = () => { c.dictating = false; composer.invalidate(); };
  c.dictating = true; c.focused = true;
  try { recognition.start(); } catch { c.dictating = false; }
  composer.invalidate();
};
UI.send = () => { if (S.composer.dictating) { recognition?.stop(); S.composer.dictating = false; } A.active.follow = true; if (!sendPrompt()) return false; S.composer.focused = false; composer.invalidate(); return true; };

// ------------------------------------------------------------------ state -> view
on((topic, detail) => {
  if (topic === 'transcript') {
    const set = sets.get(detail);
    if (set) { if (set.reader && set.reader.sid === detail && set.reader.alpha > 0.01) set.reader.relayout(); else set.stale = true; }
    city.retarget();
  } else if (topic === 'sessions' || topic === 'current') { city.retarget(); hint.invalidate(); for (const r of readers) r.header.invalidate(); }
  else if (topic === 'tick') { for (const r of readers) if (r.sid && indicator(get(r.sid)) === 'running') r.header.invalidate(); }
  else if (topic === 'composer') composer.invalidate();
});
export const getLastSwitch = () => lastSwitch;
export {VIEW_PX, RH, panels, PAGE, DEG};
