import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

// Faithful tmux command/target distinction, persistent sessions, and duplicate
// creation failure. HTTP readiness is delayed independently of session creation.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-launcher-")); roots.push(root);
  const bin = join(root, "bin"); await mkdir(bin);
  const shim = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const args = process.argv.slice(2), root = process.env.SHIM_ROOT;
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
const state = path.join(root, 'session');
if (args[0] === '-V') { console.log('tmux test shim'); process.exit(0); }
if (args[0] === 'show-environment') { console.log('PI_WEB_TOKEN=stale-tmux-token\\nPI_WEB_CHILD_PORT=1'); process.exit(0); }
if (args[0] === 'has-session') { if (!args[2].startsWith('=')) process.exit(2); process.exit(fs.existsSync(state) ? 0 : 1); }
if (args[0] === 'kill-session') { if (!args[2].startsWith('=')) process.exit(2); if (fs.existsSync(state)) { const s = JSON.parse(fs.readFileSync(state)); if (s.pid) try { process.kill(s.pid); } catch {} fs.unlinkSync(state); } process.exit(0); }
if (args[0] === 'new-session') {
 if (args[3].startsWith('=') || fs.existsSync(state) || process.env.SHIM_RACE === '1') process.exit(1);
 const command = args[4]; fs.writeFileSync(path.join(root, 'command'), command);
 if (process.env.SHIM_EXIT === '1') process.exit(0);
 const port = Number(command.match(/PORT='(\\d+)'/)[1]);
 const code = "setTimeout(() => require('node:http').createServer((req,res) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sessionId:'shim'}));}).listen(" + port + ", '127.0.0.1'), 600)";
 const child = cp.spawn(process.execPath, ['-e', code], { detached:true, stdio:'ignore' }); child.unref();
 fs.writeFileSync(state, JSON.stringify({pid:child.pid})); process.exit(0);
}
process.exit(2);
`;
  await writeFile(join(bin, "tmux"), shim); await chmod(join(bin, "tmux"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, SHIM_ROOT: root,
    PI_WEB_TOKEN: "inherited-secret", PI_WEB_AUTH_STORE: "/do-not-touch/auth.json", PI_WEB_SETTINGS_FILE: "/do-not-touch/settings.json", PI_WEB_CHILD_PORT: "1", PI_WEB_CWD: "/wrong", PI_WEB_AUTH_POLICY: "open" };
  const launch = (...args: string[]) => exec(process.execPath, [resolve("scripts/instance.mjs"), "regression", ...args], { env, cwd: env.SHIM_CWD || process.cwd(), timeout: 20_000 });
  return { root, env, launch };
}

describe("isolated instance launcher", () => {
  it("mints a stored token, clears inherited overrides, waits for HTTP, and preserves a duplicate session", async () => {
    const { root, launch } = await fixture();
    try {
      const start = Date.now();
      const { stdout } = await launch("--mock");
      expect(Date.now() - start).toBeGreaterThanOrEqual(600);
      const token = stdout.match(/Token: (\S+)/)?.[1]; expect(token).toMatch(/^piw_/);
      const store = JSON.parse(await readFile(join(root, ".pi/web-instances/regression/web/web/auth.json"), "utf8"));
      expect(store.apiTokens).toHaveLength(1); expect(JSON.stringify(store)).not.toContain(token);
      const command = await readFile(join(root, "command"), "utf8");
      expect(command).toContain("unset"); expect(command).toContain("PI_WEB_TOKEN");
      expect(command).not.toContain("PI_WEB_TOKEN="); expect(command).not.toContain("inherited-secret");
      expect(command).toContain("PI_WEB_AUTH_POLICY='authenticated'");
      expect(command).not.toContain("/do-not-touch"); expect(command).not.toContain("PI_WEB_CHILD_PORT=");
      expect(command).toContain(`PI_CODING_AGENT_DIR='${root}/.pi/web-instances/regression/pi'`);
      const before = await readFile(join(root, "session"), "utf8");
      await expect(launch("--mock")).rejects.toThrow(/already running/);
      expect(await readFile(join(root, "session"), "utf8")).toBe(before);
      const calls = await readFile(join(root, "calls"), "utf8"); expect(calls).not.toContain('"kill-session"');
    } finally { await launch("--stop").catch(() => {}); }
  }, 30_000);

  it("does not kill a session when new-session loses a duplicate launch race", async () => {
    const { root, env, launch } = await fixture(); env.SHIM_RACE = "1";
    await expect(launch("--mock")).rejects.toThrow(/status 1/);
    expect(await readFile(join(root, "calls"), "utf8")).not.toContain('"kill-session"');
  }, 30_000);

  it("reports early startup failure instead of printing a ready URL", async () => {
    const { env, launch } = await fixture(); env.SHIM_EXIT = "1";
    await expect(launch("--mock")).rejects.toThrow(/Instance exited/);
  }, 30_000);

  it("creates and reuses an actual detached worktree, and copies only agent credentials/models outside mock mode", async () => {
    const { root, env, launch } = await fixture();
    const repo = join(root, "repo"), credentials = join(root, "credentials");
    await mkdir(join(repo, "server/auth"), { recursive: true }); await mkdir(credentials);
    await symlink(resolve("node_modules"), join(repo, "node_modules"), "dir");
    await writeFile(join(repo, "server/auth/cli.ts"), "console.log('API token (shown once): piw_test');");
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "add", "server/auth/cli.ts"]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    for (const file of ["auth.json", "models.json", "settings.json"]) await writeFile(join(credentials, file), file);
    env.SHIM_CWD = repo; env.PI_CODING_AGENT_DIR = credentials;
    const instance = join(root, ".pi/web-instances/regression");
    try {
      await launch("--worktree");
      expect(await readFile(join(instance, "pi/auth.json"), "utf8")).toBe("auth.json");
      expect(await readFile(join(instance, "pi/models.json"), "utf8")).toBe("models.json");
      await expect(readFile(join(instance, "pi/settings.json"))).rejects.toThrow();
      expect((await exec("git", ["-C", join(instance, "worktree"), "rev-parse", "--show-toplevel"])).stdout.trim()).toBe(join(instance, "worktree"));
      expect(await readFile(join(root, "command"), "utf8")).toContain(`PI_WEB_CWD='${instance}/worktree'`);
      await launch("--stop");
      await launch("--mock", "--worktree"); // Reuse without attempting another worktree add.
    } finally { await launch("--stop").catch(() => {}); }
  }, 30_000);

  it("rejects unsafe names and conflicting flags before touching tmux", async () => {
    await expect(exec(process.execPath, [resolve("scripts/instance.mjs"), "../unsafe", "--mock"])).rejects.toThrow(/Usage/);
    await expect(exec(process.execPath, [resolve("scripts/instance.mjs"), "safe", "--stop", "--mock"])).rejects.toThrow(/Usage/);
  });
});
