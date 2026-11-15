import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, hashSecret, randomSecret } from '../../server/auth/kernel.js';
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from './helpers/owned-stl-server.js';
import { stlViewingRotation } from '../../examples/pi-web-extensions/3d-modeling/stl-environment.js';

test.use({ launchOptions: { args: ['--max-active-webgl-contexts=8'] } });

test('twelve on-demand previews and real outline derivation and activity regrouping retain the iframe document, camera and source', async ({ browser }, info) => {
  test.skip(!['desktop', 'mobile'].includes(info.project.name));
  test.setTimeout(120_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-outline-retention-'));
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
  await writeFile(join(sessionDir, `2026-11-09T02-00-00-000Z_${sessionId}.jsonl`), [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-11-09T02:00:00.000Z', cwd: workspace }, ...entries,
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const ownerEntry = entries.find((entry: any) => entry.id === 'artifact-owner');
  for (let i = 1; i < 12; i++) {
    await copyFile(join(fixture, 'hook-cover.stl'), join(workspace, `.pi/web/artifacts/idle-${i}.stl`));
    ownerEntry.message.content.push({ type: 'text', text: `[idle-${i}.stl](/api/artifacts/idle-${i}.stl)` });
  }
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
  const context = await browser.newContext({ viewport: { width: info.project.name === 'mobile' ? 393 : 1100, height: 1000 }, isMobile: info.project.name === 'mobile', hasTouch: info.project.name === 'mobile', serviceWorkers: 'block' });
  const server = startOwnedStlServer({ ...await isolatedStlEnv(dir), PI_WEB_HOME: home, PI_CODING_AGENT_DIR: agent,
      PI_WEB_AUTH_STORE: authPath, PI_WEB_AUTH_POLICY: 'authenticated', PI_WEB_AUTH_ORIGIN: origin,
      PI_WEB_CWD: workspace, PI_WEB_DEV: '0', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      PI_WEB_SETTINGS_FILE: settings, PI_WEB_SESSION_UI_STATE_FILE: join(dir, 'sessions.json') }, dir, Math.min(30_000, info.timeout / 3));
  try {
    await server.ready();
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      const contexts = new WeakSet<object>();
      HTMLCanvasElement.prototype.getContext = function (...args: any[]) {
        const result = (original as any).apply(this, args);
        if (result && String(args[0]).startsWith('webgl') && !contexts.has(result)) {
          contexts.add(result);
          parent.postMessage({ stlContextProbe: true }, '*');
          this.addEventListener('webglcontextlost', () => parent.postMessage({ stlContextLost: true }, '*'));
        }
        return result;
      } as typeof original;
      if (window === parent) {
        (window as any).stlContexts = 0;
        (window as any).stlContextLosses = 0;
        window.addEventListener('message', event => {
          if (event.data?.stlContextProbe) (window as any).stlContexts++;
          if (event.data?.stlContextLost) (window as any).stlContextLosses++;
        });
      }
    });
    const page = await context.newPage();
    let fullSources = 0, derivatives = 0, refreshes = 0;
    page.on('request', request => {
      if (request.url().endsWith('.stl') && !request.headers().range) fullSources++;
      if (request.url().endsWith('/api/web-contributions/artifact-derived')) derivatives++;
      if (request.url().includes('/api/messages?')) refreshes++;
    });
    await bootstrapStlPage(page, origin, token, 'isolated outline fixture password');
    await expect(page.locator('#prompt')).toBeVisible();
    await page.goto(origin + '/?sessionId=' + sessionId);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'minimal');
    const owner = page.locator('.message.assistant[data-entry-id="artifact-owner"]');
    await expect(owner.locator('.artifactPreview iframe')).toHaveCount(12);
    const card = owner.locator('.artifactPreview').first(), iframe = card.locator('iframe'), runtime = iframe.contentFrame();
    for (const preview of await owner.locator('.artifactPreview').all()) {
      await expect(preview.locator('iframe').contentFrame().getByRole('button', { name: 'Load 3D preview', exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => (window as any).stlContexts)).toBe(0);
    await mkdir('.pi/web/artifacts/mobile-on-demand', { recursive: true });
    const beforeLoadPath = info.outputPath('before-load.png');
    await card.screenshot({ path: beforeLoadPath });
    await info.attach('before-load', { path: beforeLoadPath, contentType: 'image/png' });
    await expect(runtime.getByRole('button', { name: 'Load 3D preview', exact: true })).toBeVisible();
    expect(fullSources).toBe(0);
    await card.locator('.artifactPreviewShield').click();
    await runtime.getByRole('button', { name: 'Load 3D preview', exact: true }).click();
    await page.locator('#prompt').click();
    await expect(runtime.locator('#status')).toHaveText('Full detail · 108 triangles');
    expect(await page.evaluate(() => (window as any).stlContexts)).toBe(1);
    const identity = await iframe.elementHandle();
    await identity!.evaluate(element => {
      (element as HTMLIFrameElement & { loads: number }).loads = 0;
      element.addEventListener('load', () => { (element as HTMLIFrameElement & { loads: number }).loads++; });
    });
    // A nonce in the sandbox distinguishes the live DOCUMENT from its stable iframe element.
    await runtime.locator('body').evaluate(element => { element.dataset.documentNonce = 'original-runtime'; });
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
    // Real shader uniforms, not a CSS-only selected-state assertion.
    const presets: Record<string, [number,number]> = { iso:[-.58,2.4],front:[0,0],back:[0,Math.PI],left:[0,-Math.PI/2],right:[0,Math.PI/2],top:[-Math.PI/2,0],bottom:[Math.PI/2,0] };
    for (const axis of ['y','z']) {
      await runtime.locator('.info-menu summary').click(); await runtime.getByLabel('Model up axis').selectOption(axis); await runtime.locator('.info-menu summary').click();
      for (const [name,[a,b]] of Object.entries(presets)) {
        await runtime.locator('#view-menu summary').click(); await runtime.locator(`[data-view="${name}"]`).click();
        await expect(runtime.locator(`[data-view="${name}"]`)).toHaveAttribute('aria-pressed','true');
        const rotation=[Math.cos(b),Math.sin(a)*Math.sin(b),-Math.cos(a)*Math.sin(b),0,Math.cos(a),Math.sin(a),Math.sin(b),-Math.sin(a)*Math.cos(b),Math.cos(a)*Math.cos(b)];
        const state=await cameraState(); expect(state[0]).toEqual(stlViewingRotation(rotation,axis==='z').map(Math.fround)); expect(state[2]).toEqual([0,0]);
      }
    }
    await runtime.getByRole('button',{name:'Fit model',exact:true}).click(); const fitted=await cameraState();
    await canvas.focus(); await canvas.press('ArrowRight'); await canvas.press('Shift+ArrowUp'); await canvas.press('+');
    expect(await cameraState()).not.toEqual(fitted); await expect(runtime.locator('[data-view][aria-pressed="true"]')).toHaveCount(0);
    await canvas.press('f'); expect(await cameraState()).toEqual(fitted); await expect(runtime.getByLabel('Model up axis')).toHaveValue('z');
    await canvas.hover(); await page.mouse.wheel(0,-200);
    const camera = await cameraState();
    const refreshesBefore = refreshes;
    await runtime.getByRole('checkbox', { name: 'Feature outlines' }).check();
    await expect(runtime.locator('#edge-status')).toHaveText(/^\d+ true feature edges · 35° source-face crease threshold$/);
    // Real derivation work leases emit runtime state and refresh the actual persisted transcript.
    await expect.poll(() => refreshes).toBeGreaterThan(refreshesBefore);
    const assertRetained = async () => {
      expect(await identity!.evaluate(element => element.isConnected && element === document.querySelector('[data-entry-id="artifact-owner"] iframe'))).toBe(true);
      expect(await identity!.evaluate(element => (element as HTMLIFrameElement & { loads: number }).loads)).toBe(0);
      await expect(runtime.locator('body')).toHaveAttribute('data-document-nonce', 'original-runtime');
      await expect(runtime.getByRole('checkbox', { name: 'Feature outlines' })).toBeChecked();
      await expect(runtime.locator('#waiting')).toBeHidden();
      expect(fullSources).toBe(1); expect(derivatives).toBe(1);
      expect(await page.evaluate(() => (window as any).stlContexts)).toBe(1);
      expect(await page.evaluate(() => (window as any).stlContextLosses)).toBe(0);
    };
    await assertRetained();
    await runtime.getByRole('checkbox', { name: 'Feature outlines' }).uncheck();
    expect(await cameraState()).toEqual(camera);
    await runtime.getByRole('checkbox', { name: 'Feature outlines' }).check();
    await page.locator('#settingsButton').evaluate((button: HTMLButtonElement) => button.click());
    for (const density of ['comfortable', 'compact', 'minimal', 'comfortable', 'minimal']) {
      await page.locator('#settingDensitySelect').evaluate((select: HTMLSelectElement, value) => {
        select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
      }, density);
      await expect(page.locator('html')).toHaveAttribute('data-density', density);
      await assertRetained();
      await expect(page.locator('.activitySummary')).toHaveCount(density === 'minimal' ? 1 : 0);
    }
    await page.locator('#settingsCloseButton').click();
    await expect(page.locator('#settingsCloseButton')).toBeHidden();
    await card.scrollIntoViewIfNeeded();
    await card.locator('.artifactPreviewShield').click();
    const loadedPath = info.outputPath('loaded-outlines.png');
    await card.screenshot({ path: loadedPath });
    await info.attach('loaded-outlines', { path: loadedPath, contentType: 'image/png' });
    await mkdir('.pi/web/artifacts/stl-outline-reset-followup', { recursive: true });
    await card.screenshot({ path: '.pi/web/artifacts/stl-outline-reset-followup/real-derive-after.png' });
  } finally {
    try { await context.close(); } finally { await server.close(); }
  }
});
