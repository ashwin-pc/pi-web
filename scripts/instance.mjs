#!/usr/bin/env node
import { mkdir, copyFile, symlink, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const run = (command, argv, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', data => { stdout += data; });
  child.stderr?.on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolveRun(stdout) : reject(new Error(`${command} exited with status ${code}: ${stderr.trim()}`)));
});
const canListen = (port, host) => new Promise((done) => {
  const server = net.createServer();
  server.once('error', () => done(false));
  // Bind the wildcard address too: some environments allow a loopback
  // bind alongside an existing wildcard listener, which is not a usable pair.
  server.listen(port, host, () => server.close(() => done(true)));
});

async function main() {
  const args = process.argv.slice(2), name = args.shift();
  const allowed = new Set(['--mock', '--worktree', '--stop']);
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name) || args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length || (args.includes('--stop') && args.length !== 1)) {
    throw new Error('Usage: npm run instance -- <name> [--mock] [--worktree] | <name> --stop');
  }
  const session = `pi-web-${name}`, target = `=${session}`;
  if (args.includes('--stop')) { await run('tmux', ['kill-session', '-t', target]); return; }
  await run('tmux', ['-V']); // Fail before creating state if tmux is unavailable.
  const exists = () => run('tmux', ['has-session', '-t', target]).then(() => true, () => false);
  if (await exists()) throw new Error(`Instance ${name} is already running; stop it first.`);

  const root = join(homedir(), '.pi', 'web-instances', name);
  const webHome = join(root, 'web'), agentHome = join(root, 'pi');
  let cwd = resolve(process.cwd());
  await mkdir(webHome, { recursive: true, mode: 0o700 });
  await mkdir(agentHome, { recursive: true, mode: 0o700 });
  if (args.includes('--worktree')) {
    const worktree = join(root, 'worktree');
    try { await access(worktree); } catch {
      await run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd });
      // A linked checkout shares the current dependency installation, not state.
      await symlink(join(cwd, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    }
    cwd = worktree;
  }
  if (!args.includes('--mock')) {
    const source = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    for (const file of ['auth.json', 'models.json']) {
      try { await copyFile(join(source, file), join(agentHome, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  let port = 8787;
  while (port < 65000 && !(await canListen(port, '0.0.0.0') && await canListen(port, '127.0.0.1') && await canListen(port + 1, '0.0.0.0') && await canListen(port + 1, '127.0.0.1'))) port += 2;
  if (port >= 65000) throw new Error('No free port pair found');

  // Drop inherited routing/auth/file overrides, including the parent's token.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_WEB_')) delete env[key];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), PI_WEB_HOME: webHome,
    PI_CODING_AGENT_DIR: agentHome, PI_WEB_CWD: cwd, PI_WEB_DEV: '1',
    PI_WEB_MOCK: args.includes('--mock') ? '1' : '0', PI_WEB_AUTH_POLICY: 'authenticated',
  });
  // Mint a stored API token; never pass it as PI_WEB_TOKEN to the server.
  const output = await run(process.execPath, ['--import', 'tsx', 'server/auth/cli.ts', 'token-create', '--name', `instance-${name}`], { cwd, env });
  const token = output.match(/API token \(shown once\): (\S+)/)?.[1];
  if (!token) throw new Error('Token creation did not return a token');
  const unset = [...new Set(['PI_WEB_TOKEN', ...Object.keys(process.env).filter(key => key.startsWith('PI_WEB_'))])];
  // tmux's server may predate this launcher; clear its inherited variables too.
  const tmuxEnv = await run('tmux', ['show-environment', '-g']).catch(() => '');
  for (const line of tmuxEnv.split('\n')) {
    const key = line.split('=')[0].replace(/^-/, '');
    if (key.startsWith('PI_WEB_') && !unset.includes(key)) unset.push(key);
  }
  const assignments = Object.entries(env).filter(([key]) => key.startsWith('PI_WEB_') || ['HOST', 'PORT', 'PI_CODING_AGENT_DIR'].includes(key));
  const command = `cd ${quote(cwd)} && ${unset.length ? `unset ${unset.map(quote).join(' ')} && ` : ''}env ${assignments.map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${quote(process.execPath)} --import tsx supervisor.ts >${quote(join(root, 'server.log'))} 2>&1`;
  let started = false;
  try {
    await run('tmux', ['new-session', '-d', '-s', session, command]);
    started = true; // Only clean up a session this invocation successfully created.
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (!(await exists())) throw new Error(`Instance exited; inspect ${join(root, 'server.log')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
        if (res.ok && (await res.json()).sessionId !== undefined) { ready = true; break; }
      } catch { /* supervisor can listen before its child is ready */ }
      await new Promise(done => setTimeout(done, 200));
    }
    if (!ready) throw new Error(`Instance did not become ready; inspect ${join(root, 'server.log')}`);
  } catch (error) {
    if (started) await run('tmux', ['kill-session', '-t', target]).catch(() => {});
    throw error;
  }
  console.log(`Instance: ${name}\nURL: http://localhost:${port}\nToken: ${token}\nStop: npm run instance -- ${name} --stop`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
