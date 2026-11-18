import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, hashSecret, randomSecret } from '../../server/auth/kernel.js';
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from './helpers/owned-stl-server.js';

test('mixed thinking and artifact text retains its live document during real outline derivation', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(120_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-mixed-outline-'));
  const workspace = join(dir, 'workspace'), home = join(dir, 'home'), authPath = join(dir, 'auth.json');
  const agent = join(dir, 'agent'), sessionId = '01a1bf40-1000-7000-8000-000000000001';
  const fixture = join(process.cwd(), 'tests/fixtures/stl-outline-reset');
  await mkdir(join(home, 'extensions'), { recursive: true });
  await symlink(join(process.cwd(), 'examples/pi-web-extensions/3d-modeling'), join(home, 'extensions/3d-modeling'), 'dir');
  await mkdir(join(workspace, '.pi/web/artifacts'), { recursive: true });
  await copyFile(join(fixture, 'hook-cover.stl'), join(workspace, '.pi/web/artifacts/hook-cover.stl'));
  const sessionDir = join(agent, 'sessions', `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  await mkdir(sessionDir, { recursive: true });
  const entries = JSON.parse(await readFile(join(fixture, 'messages.json'), 'utf8'));
  entries.find((entry: { id: string }) => entry.id === 'artifact-owner').message.content.unshift({ type: 'thinking', thinking: 'Fixture ordinary thinking before artifact' });
  await writeFile(join(sessionDir, `2026-11-09T02-00-00-000Z_${sessionId}.jsonl`), [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-11-09T02:00:00.000Z', cwd: workspace }, ...entries,
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const settings = join(dir, 'settings.json');
  await writeFile(settings, JSON.stringify({ appearance: { density: 'minimal' } }));
  const token = randomSecret();
  await new AuthStore(authPath).update(state => {
    state.config = { policy: 'authenticated', methods: [] };
    state.bootstrap = { hash: hashSecret(token), expiresAt: Date.now() + 120_000 };
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, serviceWorkers: 'block' });
  const server = startOwnedStlServer({ ...await isolatedStlEnv(dir), PI_WEB_HOME: home, PI_CODING_AGENT_DIR: agent,
    PI_WEB_AUTH_STORE: authPath, PI_WEB_AUTH_POLICY: 'authenticated', PI_WEB_AUTH_ORIGIN: origin,
    PI_WEB_CWD: workspace, PI_WEB_DEV: '0', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
    PI_WEB_SETTINGS_FILE: settings, PI_WEB_SESSION_UI_STATE_FILE: join(dir, 'sessions.json') }, dir, 30_000);
  try {
    await server.ready();
    const page = await context.newPage();
    let sources = 0, derivatives = 0, refreshes = 0, pagehides = 0, contextLosses = 0;
    page.on('request', request => {
      if (request.url().endsWith('/hook-cover.stl') && !request.headers().range) sources++;
      if (request.url().endsWith('/api/web-contributions/artifact-derived')) derivatives++;
      if (request.url().includes('/api/messages?')) refreshes++;
    });
    await bootstrapStlPage(page, origin, token, 'isolated mixed outline fixture password');
    await expect(page.locator('#prompt')).toBeVisible();
    await page.goto(origin + '/?sessionId=' + sessionId);
    const owner = page.locator('.message.assistant[data-entry-id="artifact-owner"]');
    const card = owner.locator('.artifactPreview'), iframe = card.locator('iframe'), runtime = iframe.contentFrame();
    await card.locator('.artifactPreviewShield').click();
    await runtime.getByRole('button', { name: 'Load 3D preview', exact: true }).click();
    await page.locator('#prompt').click();
    await expect(runtime.locator('#status')).toHaveText('Full detail · 108 triangles');
    const identity = await iframe.elementHandle();
    await page.exposeFunction('recordPreviewLifecycle', (event: string) => {
      if (event === 'pagehide') pagehides++;
      if (event === 'webglcontextlost') contextLosses++;
    });
    await page.evaluate(() => window.addEventListener('message', event => {
      if (event.data?.retentionProbe) (window as unknown as { recordPreviewLifecycle(event: string): void }).recordPreviewLifecycle(event.data.retentionProbe);
    }));
    await runtime.locator('body').evaluate(body => {
      body.dataset.documentNonce = 'original-mixed-document';
      window.addEventListener('pagehide', () => parent.postMessage({ retentionProbe: 'pagehide' }, '*'));
      body.querySelector('canvas')!.addEventListener('webglcontextlost', () => parent.postMessage({ retentionProbe: 'webglcontextlost' }, '*'));
    });
    await card.locator('.artifactPreviewShield').click();
    const canvas = runtime.locator('canvas');
    await canvas.hover(); await page.mouse.wheel(0, -200);
    const cameraState = () => canvas.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
      return ['r', 'scale', 'pan'].map(name => {
        const value = gl.getUniform(program, gl.getUniformLocation(program, name)!);
        return typeof value === 'number' ? value : Array.from(value);
      });
    });
    const camera = await cameraState(), refreshesBefore = refreshes;
    await runtime.getByRole('checkbox', { name: 'Feature outlines' }).check();
    await expect.poll(() => refreshes).toBeGreaterThan(refreshesBefore);
    await expect(runtime.locator('#edge-status')).toHaveText(/^\d+ true feature edges · 35° source-face crease threshold$/);
    // Runtime notifications may be coalesced into one transcript refresh.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await identity!.evaluate(element => element.isConnected && element === document.querySelector('[data-entry-id="artifact-owner"] iframe'))).toBe(true);
    await expect(runtime.locator('body')).toHaveAttribute('data-document-nonce', 'original-mixed-document');
    await expect(runtime.getByRole('checkbox', { name: 'Feature outlines' })).toBeChecked();
    await runtime.getByRole('checkbox', { name: 'Feature outlines' }).uncheck();
    expect(await cameraState()).toEqual(camera);
    expect({ sources, derivatives, pagehides, contextLosses }).toEqual({ sources: 1, derivatives: 1, pagehides: 0, contextLosses: 0 });
    await expect(page.locator('.toolCard').filter({ hasText: 'Fixture ordinary thinking before artifact' })).toHaveCount(1);
    console.log('mixed-outline-retention', JSON.stringify({ sources, derivatives, pagehides, contextLosses, refreshes }));

    // Synthetic lifecycle coverage, not evidence of real-device BFCache behavior.
    // Restored documents must offer a neutral reopen, not mislabel our own
    // pagehide GPU disposal as an unsolicited graphics failure.
    await runtime.locator('body').evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(iframe).toHaveCount(0);
    await expect(card.getByText('Preview closed', { exact: true })).toBeVisible();
    await expect(card.getByText(/GPU context lost/)).toHaveCount(0);
    await card.getByRole('button', { name: 'Open again', exact: true }).click();
    await card.locator('.artifactPreviewShield').click();
    await runtime.getByRole('button', { name: 'Load 3D preview', exact: true }).click();
    await page.locator('#prompt').click();
    await expect(runtime.locator('#status')).toHaveText('Full detail · 108 triangles');
    expect(sources).toBe(2);

    // Loss not initiated by runtime disposal must still reach visible recovery.
    await runtime.locator('canvas').evaluate(canvas => {
      const gl = (canvas as HTMLCanvasElement).getContext('webgl2')!;
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw Error('WEBGL_lose_context unavailable for loss injection');
      extension.loseContext();
    });
    await expect(iframe).toHaveCount(0);
    await expect(card.getByText('Preview could not be opened', { exact: true })).toBeVisible();
    await expect(card.getByText('GPU context lost. Try opening the preview again, or download the original.', { exact: true })).toBeVisible();
  } finally {
    try { await context.close(); } finally { await server.close(); }
  }
});
