// pi-web only (not in the mock): a real 3D artifact (STL, glTF / GLB, OBJ or PLY) as ONE geometry for the pedestal.
// Every mesh is baked into a single position + normal geometry, centred on the pedestal, standing on it, and scaled
// to about 0.2 m, so the pedestal keeps its one-mesh model (one raycast target, one draw call, the gold matcap).
// The loaders are imported only when a model is shown.
import * as THREE from 'three';

const SIZE = 0.2;

async function geometriesOf(bytes, format) {
  if (format === 'stl') { const {STLLoader} = await import('three/examples/jsm/loaders/STLLoader.js'); return [new STLLoader().parse(bytes)]; }
  if (format === 'ply') { const {PLYLoader} = await import('three/examples/jsm/loaders/PLYLoader.js'); return [new PLYLoader().parse(bytes)]; }
  let root;
  if (format === 'obj') { const {OBJLoader} = await import('three/examples/jsm/loaders/OBJLoader.js'); root = new OBJLoader().parse(new TextDecoder().decode(bytes)); }
  else {
    // glTF / GLB: self-contained files only (an external .bin or texture would need its own authorised fetch).
    const {GLTFLoader} = await import('three/examples/jsm/loaders/GLTFLoader.js');
    root = (await new GLTFLoader().parseAsync(bytes, '')).scene;
  }
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes.position) out.push(o.geometry.clone().applyMatrix4(o.matrixWorld)); });
  return out;
}

/** Bytes of a model file → one BufferGeometry, normalised for the pedestal (throws if there is nothing to show). */
export async function modelGeometry(bytes, format) {
  const parts = (await geometriesOf(bytes, format)).map((g) => {
    const n = g.index ? g.toNonIndexed() : g, b = new THREE.BufferGeometry();
    b.setAttribute('position', n.attributes.position);
    if (n.attributes.normal) b.setAttribute('normal', n.attributes.normal);
    return b;
  });
  if (!parts.length) throw new Error('The model has no meshes.');
  const {mergeGeometries} = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
  const g = parts.length === 1 ? parts[0] : mergeGeometries(parts.every((p) => p.attributes.normal) ? parts : parts.map((p) => { p.deleteAttribute('normal'); return p; }));
  if (!g.attributes.normal) g.computeVertexNormals();
  // STL comes from CAD and 3D printing, which are Z-up: stand it upright (the pedestal is Y-up, like glTF).
  if (format === 'stl') g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  const s = new THREE.Vector3(); g.boundingBox.getSize(s);
  const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
  g.translate(-c.x, -g.boundingBox.min.y, -c.z);
  const k = SIZE / Math.max(s.x, s.y, s.z, 1e-6);
  g.scale(k, k, k);
  g.computeBoundingSphere();
  return g;
}
