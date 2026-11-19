// What each session touches in the file tree: the files its tools read, edit and write, and where its current tool works.
// Pure (no three.js). Paths are absolute (cwd + the tool's relative path).
const SEARCH = /^(rg|grep|find|fd|ag)\b/;

/** Absolute path for a tool path relative to the session's cwd. */
export const absPath = (cwd, p) => (p.startsWith('/') ? p : `${cwd}/${p.replace(/^\.\//, '')}`).replace(/\/+$/, '');

/** The path a tool message refers to (file or folder), or null for a plain command. */
export function toolPath(s, m) {
  if (m.type === 'edit' && m.path) return {path: absPath(s.cwd, m.path), kind: 'edit'};
  if (m.type !== 'tool') return null;
  if (m.name === 'read' || m.name === 'write' || m.name === 'edit') {
    const p = m.args?.path || (m.sub || '').split(' · ')[0];
    return p ? {path: absPath(s.cwd, p), kind: m.name === 'read' ? 'read' : 'edit'} : null;
  }
  if (m.name === 'bash') {
    const cmd = (m.args?.command || m.sub || '').split(' · ')[0].trim();
    if (SEARCH.test(cmd)) {
      // The last bare argument that looks like a path is where the search walks.
      const toks = cmd.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/).slice(1).filter((t) => t && !t.startsWith('-') && /^[\w.~/-]+$/.test(t) && /[/.]|^(src|tests?|server|docs|scripts)$/.test(t));
      const p = toks[toks.length - 1];
      return {path: p ? absPath(s.cwd, p) : s.cwd, kind: 'search', dir: true};
    }
    return {path: s.cwd, kind: 'bash', dir: true};
  }
  return {path: s.cwd, kind: 'other', dir: true};
}

/** Every file path a session's tools touched (read, edit, write), oldest first, plus the edited ones. */
export function touchedFiles(s) {
  const files = [], edited = [];
  for (const m of s.messages) {
    const t = toolPath(s, m);
    if (!t || t.dir) continue;
    if (!files.includes(t.path)) files.push(t.path);
    if (t.kind === 'edit' && !edited.includes(t.path)) edited.push(t.path);
  }
  return {files, edited};
}

/** Where a running session's current tool works: {path, kind, act} (act: dig | plant | map | search). */
export function currentTarget(s) {
  if (!s.running) return null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.type === 'tool' && m.status === 'running') {
      const t = toolPath(s, m) || {path: s.cwd, kind: 'bash', dir: true};
      const act = t.kind === 'read' ? 'map' : t.kind === 'edit' ? 'plant' : t.kind === 'search' ? 'search' : 'dig';
      return {...t, act, tool: m.name, msg: m};
    }
  }
  return {path: s.cwd, kind: 'bash', dir: true, act: 'dig', tool: 'bash'};
}
