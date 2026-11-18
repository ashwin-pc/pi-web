import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { isolatedAuthEnv } from '../../auth-isolation.js';

export async function isolatedStlEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  const env = isolatedAuthEnv();
  // isolatedAuthEnv allocates a home; fold it into this fixture's owned temp tree.
  await rm(env.PI_WEB_HOME!, { recursive: true, force: true });
  return { ...env, PI_WEB_HOME: join(dir, 'home'), PI_CODING_AGENT_DIR: join(dir, 'agent') };
}

/** Use the same literal address for reservation, bind and requests (no localhost DNS ambiguity). */
export async function reserveStlOrigin(): Promise<{ port: number; origin: string }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No STL test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

/** Bounded output, early exit detection and request deadlines, rather than swallowing fetch failures as 0. */
export function observeServer(child: ChildProcess) {
  let output = '', failure: Error | undefined;
  const append = (chunk: Buffer) => { output = (output + chunk.toString().replace(/(token=)[^\s&]+/gi, '$1[redacted]')).slice(-16_384); };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('error', error => { failure = error; });
  let exited = false;
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const diagnostics = () => `pid=${child.pid}, exit=${child.exitCode}, signal=${child.signalCode}\n${output.replace(/(token=)[^\s&]+/gi, '$1[redacted]')}`;
  return {
    async ready(origin: string, timeoutMs: number) {
      const started = Date.now();
      let last = 'not attempted';
      while (Date.now() - started < timeoutMs) {
        if (failure || exited) throw new Error(`STL server exited before readiness: ${failure?.message ?? ''}\n${diagnostics()}`);
        try {
          const response = await fetch(origin + '/api/state', { signal: AbortSignal.timeout(Math.min(1000, Math.max(1, timeoutMs - (Date.now() - started)))) });
          last = `HTTP ${response.status}`;
          await response.body?.cancel();
          if (response.status === 401) return;
          // A listening server with the wrong auth policy is not a startup delay.
          throw new Error(`STL server readiness expected HTTP 401, got ${last}\n${diagnostics()}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('STL server readiness')) throw error;
          last = error instanceof Error ? `${error.message}: ${String(error.cause ?? '')}` : String(error);
        }
        await Promise.race([delay(100), exit]);
      }
      throw new Error(`STL server not ready within ${timeoutMs}ms; last probe: ${last}\n${diagnostics()}`);
    },
    async stop() {
      const signal = (name: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      // Signal the group even if its leader already exited: descendants may still be alive.
      signal('SIGTERM');
      if (!exited && !failure) {
        await Promise.race([exit, delay(2000)]);
      }
      signal('SIGKILL');
      if (!exited && !failure) await exit;
    },
  };
}

export function startOwnedStlServer(env: NodeJS.ProcessEnv, dir: string, timeoutMs: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(), env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observed = observeServer(child);
  return {
    ready: () => observed.ready(env.PI_WEB_AUTH_ORIGIN!, timeoutMs),
    async close() { try { await observed.stop(); } finally { await rm(dir, { recursive: true, force: true }); } },
  };
}

export async function bootstrapStlPage(page: Page, origin: string, token: string, password: string) {
  await page.goto(origin + '/api/auth/bootstrap?token=' + encodeURIComponent(token));
  await page.getByLabel('New password (12+ characters)').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
}
