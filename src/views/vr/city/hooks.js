// window.__vrCity: the test and measurement hook (state, projection of named targets, angular sizes, logs).
import * as THREE from 'three';
import {panels} from './panel.js';
import {S, get, indicator, needsYou, fenceLine, nextNeedingYou, DWELL_MS, unreadTurns} from './state.js';
import {client} from './client.js';
import {PPM} from './turns.js';
import {A, renderer, camera, scene, DEG, READER_POS, animMs, uiRoot} from './core.js';
import {readers, VIEW_PX} from './reader.js';
import {city, bar, pops, switchLog, panelLog, openReader, closeReader, getLastSwitch, switchBy, choose, flyToSession, flyToPath, goHome, setTable, isTable, comfort} from './app.js';
import {head, updateHead, intersect, inScene, raycaster, effortLog, pointers} from './input.js';
import {desk} from './desktop.js';
import {xrStatus, inIframe} from './xr.js';
import * as V from './views.js';
import * as N from './city-nav.js';
import {cityHooks} from './city-hooks.js';
import {plainOf} from './city-text.js';
import {contentOf} from './artifact-draw.js';

const el = renderer.domElement;
export function findRegion(id) {
  for (const p of panels) {
    if (p.reader && p.reader !== A.active) continue;
    if (!inScene(p.mesh) && !p.isTurn && !p.batch) continue;
    const r = p.regions.find((x) => x.id === id);
    if (r) return {panel: p, r};
  }
  return null;
}
/** World-space centre and edges of a named target: a panel region, a live card, or a sign. */
export function corners(id) {
  if (id.startsWith('card:') || id.startsWith('label:')) {
    const list = id.startsWith('card:') ? city.cards.placed.map((c) => ({...c, key: `card:${c.sid}`})) : city.labels.placed.map((c) => ({...c, key: `label:${c.id}`}));
    const b = list.find((x) => x.key === id), lv = id.startsWith('card:') ? city.cards.lastView : city.labels.lastView;
    if (!b || !lv) return null;
    const q = lv.inv.clone().invert();
    const P = (x, y) => new THREE.Vector3(x * b.D, y * b.D, -b.D).applyQuaternion(q).add(lv.eye);
    return {c: P(b.cx, b.cy), l: P(b.cx - b.w / 2, b.cy), r: P(b.cx + b.w / 2, b.cy), t: P(b.cx, b.cy + b.h / 2), b: P(b.cx, b.cy - b.h / 2)};
  }
  const f = findRegion(id);
  if (!f) return null;
  const {panel, r} = f;
  panel.mesh.updateWorldMatrix(true, false);
  const P = (x, y) => { const {u, v} = panel.fromCanvas(x, y); return panel.uvToLocal(u, v, new THREE.Vector3()).applyMatrix4(panel.mesh.matrixWorld); };
  return {c: P(r.x + r.w / 2, r.y + r.h / 2), l: P(r.x, r.y + r.h / 2), r: P(r.x + r.w, r.y + r.h / 2), t: P(r.x + r.w / 2, r.y), b: P(r.x + r.w / 2, r.y + r.h)};
}
const ang = (a, b) => a.clone().sub(head.pos).angleTo(b.clone().sub(head.pos)) / DEG;
// A log of the client's events (for tests and the README).
client.events.subscribe((e) => { const L = (window.__clientEvents ||= []); L.push({type: e.type, sessionId: e.sessionId, t: Math.round(performance.now())}); if (L.length > 400) L.shift(); });
window.__vrCity = {
  version: 'city-live-1',
  get frames() { return A.frames; },
  state() {
    const ind = {};
    for (const id of S.pinned) ind[id] = indicator(get(id));
    const r = A.active, set = r.set;
    return {
      currentId: S.currentId, selectedId: S.selectedId, reading: S.reading, title: get(S.currentId).title, readerSid: r.sid, pinned: [...S.pinned], indicators: ind,
      needs: needsYou().map((s) => s.id), fence: fenceLine().map((s) => s.id), next: nextNeedingYou()?.id || null, unreadTurns: Object.fromEntries(S.pinned.map((id) => [id, unreadTurns(get(id))])),
      dwell: S.dwell ? {id: S.dwell.id, done: !!S.dwell.done} : null, dwellMs: S.dwellMs ?? DWELL_MS, reduceMotion: S.reduceMotion, vignette: S.vignette !== false,
      scroll: r.scroll, dest: r.dest, vel: r.vel, anim: !!r.anim, max: r.maxScroll, viewPx: VIEW_PX, turnIdx: r.turnIdx, markY: set?.markY ?? null,
      snaps: set ? set.turns.map((_, i) => set.snapPos(i)) : [], newOutput: r.newOutput, messages: get(S.currentId).messages.length,
      composerText: S.composer.text, dictating: S.composer.dictating,
      panelSettled: readers.every((x) => !x.pose || animMs() - x.pose.t0 >= x.pose.dur),
      xrPresenting: renderer.xr.isPresenting, xr: {...xrStatus}, inIframe, lastSwitch: getLastSwitch(), table: isTable(),
      nav: {x: +N.nav.pos.x.toFixed(3), y: +N.nav.pos.y.toFixed(3), z: +N.nav.pos.z.toFixed(3), yaw: +N.nav.yaw.toFixed(5), scale: +N.nav.scale.toFixed(4), anim: !!N.nav.anim, altitude: +N.altitude(head.local).toFixed(2)},
      bar: {yaw: +(bar.yaw / DEG).toFixed(2), page: bar.page, start: bar.start, pages: Math.ceil(S.pinned.length / 10), moreOpen: bar.moreOpen, highlight: A.highlight || null, preview: pops.preview.mesh.visible ? pops.preview.sid : null},
      head: {yaw: +(head.yaw / DEG).toFixed(2), pitch: +(head.pitch / DEG).toFixed(2)}, hoverAvatar: A.hoverAvatar || null,
    };
  },
  fps() { const w = A.fpsWin.slice(-60); return w.length ? +(1000 / (w.reduce((a, b) => a + b, 0) / w.length)).toFixed(1) : 0; },
  stats() { const i = renderer.info; return {calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures}; },
  allRegions() { return panels.filter((p) => inScene(p.mesh) || p.batch).flatMap((p) => p.regions.map((r) => r.id)); },
  world(id) { const c = corners(id); return c && {x: c.c.x, y: c.c.y, z: c.c.z}; },
  project(id) {
    const c = corners(id);
    if (!c) return null;
    const v = c.c.clone().project(camera);
    const r = el.getBoundingClientRect();
    return {x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, visible: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1};
  },
  regionPx(id) {
    const c = corners(id); if (!c) return null;
    const r = el.getBoundingClientRect(), P = (v) => { const q = v.clone().project(camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; };
    const l = P(c.l), rr = P(c.r), t = P(c.t), b = P(c.b);
    return {w: Math.round(Math.hypot(rr[0] - l[0], rr[1] - l[1])), h: Math.round(Math.hypot(b[0] - t[0], b[1] - t[1]))};
  },
  targetDeg(id) {
    updateHead();
    const c = corners(id);
    if (!c) return null;
    const w = ang(c.l, c.r), h = ang(c.t, c.b);
    return {w: +w.toFixed(2), h: +h.toFixed(2), min: +Math.min(w, h).toFixed(2), distance: +c.c.clone().sub(head.pos).length().toFixed(3)};
  },
  textSize() { updateHead(); A.active.g.updateMatrixWorld(true); const p = A.active.g.localToWorld(new THREE.Vector3()); const d = p.distanceTo(head.pos); const em = (35 / PPM) * A.active.g.scale.x; return {emMetres: em, distance: +d.toFixed(3), emDeg: +(Math.atan(em / d) / DEG).toFixed(3), pxAt1m: +((em / d) * 1000).toFixed(1)}; },
  hitAt(x, y) {
    const r = el.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
    const h = intersect({valid: true, ray: raycaster.ray.clone(), kind: 'mouse'});
    return h ? h.region?.id ? (h.label ? `label:${h.label.id}` : h.region.id) : (h.reader ? 'reader' : h.panel?.name) : null;
  },
  open(id) { openReader(id); }, close() { closeReader(); }, choose(id) { choose(id); }, switchBy(d) { switchBy(d); }, needsYou() { return V.UI.needsYou(); },
  markReadNow(id) { client.actions.markRead(id); },
  /** The reader's transcript as the City sees it (type, text, streaming), for tests. */
  messages(id = S.currentId) { return (get(id)?.messages || []).map((m) => ({type: m.type, name: m.name, status: m.status, streaming: !!m.streaming, text: m.text || plainOf(m)})); },
  /** pi-web: an artifact's content state (loading | ready | error), without starting a load. */
  artifactState(id) { const a = client.artifacts(id.split(':')[0]).find((x) => x.id === id); return a ? contentOf(a, false)?.state || 'none' : null; },
  cityFiles() { return {files: city.land.files.size, dirs: city.land.byPath.size, home: client.files.home}; },
  clientEvents(n = 40) { return (window.__clientEvents || []).slice(-n); },
  header() { return A.active.header.drawn || null; },
  lastTool(id) { const s = get(id); const m = [...s.messages].reverse().find((x) => x.type === 'tool'); return m ? {name: m.name, status: m.status, sum: m.sum} : null; },
  flyToSession, flyToPath, goHome, setTable, isTable,
  reduceMotion(v) { V.UI.setReduceMotion(v); },
  debugCam(o) { A.debugCam = o; },
  effortLog: () => [...effortLog], switchLog: () => [...switchLog], panelLog: () => [...panelLog], navLog: () => [...N.nav.log], followLog: () => [...bar.follow],
  vignette() { return {visible: comfort.vig.visible, alpha: +comfort.vig.material.uniforms.uA.value.toFixed(3), blink: +comfort.fade.material.opacity.toFixed(3)}; },
  _ptrs() { return [...pointers].map((p) => ({kind: p.kind, valid: p.valid, hit: p.hit ? (p.hit.region?.id || (p.hit.reader ? 'reader' : p.hit.panel?.name) || null) : null, press: p.press?.mode || null})); },
  _three: {THREE, renderer, scene, camera, city, bar, uiRoot, head, N},
  ...cityHooks,
};
