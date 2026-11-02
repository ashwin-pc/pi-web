// The city's data model: one file tree rooted at the home directory, read through the client (src/client.js:
// files.tree). Workspace roots become districts, the folders that only lead to roots are avenues, every other folder
// is a block and every file a building. Which data is real and which is synthetic is the client's business: the tree
// says so per node (synthetic: true), and the README lists it.
import {client} from './client.js';
import {typeOf, TYPES} from './file-types.js';

export const HOME = client.files.home;
export {typeOf, TYPES};

/** Raw client nodes → city nodes: {name, path, parent, depth, dirs, files: [{name, path, type, bytes, lines, mtime, synthetic, dir}], kind}. */
function build(raw, path, parent, depth) {
  const n = {name: raw.name, path, parent, depth, dirs: [], files: [], synthetic: !!raw.synthetic, kind: raw.root ? 'district' : 'dir', root: !!raw.root};
  n.files = (raw.files || []).map((f) => ({name: f.name, path: `${path}/${f.name}`, type: typeOf(`${path}/${f.name}`), bytes: f.bytes, lines: f.lines, mtime: f.mtime ?? null, synthetic: !!f.synthetic, dir: n}));
  n.dirs = (raw.dirs || []).map((d) => build(d, `${path}/${d.name}`, n, depth + 1));
  return n;
}
export function total(n) { return n.files.length + n.dirs.reduce((s, d) => s + total(d), 0); }
export function* walk(n) { yield n; for (const d of n.dirs) yield* walk(d); }
export function* allFiles(n) { for (const d of walk(n)) yield* d.files; }
const hasRoot = (n) => n.root || n.dirs.some(hasRoot);

/** The whole city's tree, from the client. Returns {root, byPath (dirs), files (path -> file)}. */
export function buildLand() {
  const root = build(client.files.tree(HOME), HOME, null, 0);
  root.kind = 'home'; root.synthetic = false;
  // Folders under home that are not roots but lead to roots are avenues; their roots are districts.
  for (const lane of root.dirs.filter((d) => !d.root && hasRoot(d))) {
    lane.kind = 'avenue';
    for (const e of lane.dirs.filter((d) => d.root)) { e.kind = 'district'; e.district = e.name; for (const d of walk(e)) d.district = e.name; }
  }
  for (const d of root.dirs.filter((x) => x.kind === 'dir')) for (const x of walk(d)) x.district = '~';
  return index(root);
}
function index(root) {
  const byPath = new Map(), files = new Map();
  for (const d of walk(root)) { byPath.set(d.path, d); for (const f of d.files) files.set(f.path, f); }
  return {root, byPath, files};
}

/** A file a session touches that the tree does not list (it was just created): added with an unknown, small size. */
export function ensureFile(land, absPath) {
  if (land.files.has(absPath)) return land.files.get(absPath);
  const parts = absPath.slice(HOME.length + 1).split('/');
  let n = land.root, path = HOME;
  for (const p of parts.slice(0, -1)) {
    path += '/' + p;
    let c = n.dirs.find((d) => d.name === p);
    if (!c) { c = {name: p, path, parent: n, depth: n.depth + 1, dirs: [], files: [], synthetic: true, kind: 'dir', district: n.district, added: true}; n.dirs.push(c); land.byPath.set(path, c); }
    n = c;
  }
  const f = {name: parts[parts.length - 1], path: absPath, type: typeOf(absPath), bytes: 1500, lines: 40, mtime: null, synthetic: true, added: true, dir: n};
  n.files.push(f); land.files.set(absPath, f);
  (land.added ||= []).push(absPath);
  return f;
}
/** The district (workspace root) a path belongs to, or null for the home directory itself. */
export function districtOf(land, absPath) {
  for (const d of land.root.dirs) for (const e of d.dirs) if (e.kind === 'district' && (absPath === e.path || absPath.startsWith(e.path + '/'))) return e;
  return null;
}
