import { test, expect } from '@playwright/test';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, hashSecret, randomSecret } from '../../server/auth/kernel.js';
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from './helpers/owned-stl-server.js';
import { stlContribution } from '../../examples/pi-web-extensions/3d-modeling/stl.js';

test('streamed STL becomes touch interactive only when ready and remains active across releases', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(120_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), 'pi-stl-touch-'));
  const authPath = join(dir, 'auth.json'), token = randomSecret();
  await new AuthStore(authPath).update(state => { state.config = { policy: 'authenticated', methods: [] }; state.bootstrap = { hash: hashSecret(token), expiresAt: Date.now() + 120_000 }; });
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const server = startOwnedStlServer({ ...await isolatedStlEnv(dir), PI_WEB_AUTH_STORE: authPath, PI_WEB_AUTH_POLICY: 'authenticated', PI_WEB_AUTH_ORIGIN: origin, PI_WEB_MOCK: '1', PI_WEB_CWD: process.cwd(), PI_WEB_DEV: '0', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PI_WEB_SETTINGS_FILE: join(dir, 'settings.json'), PI_WEB_SESSION_UI_STATE_FILE: join(dir, 'sessions.json') }, dir, Math.min(30_000, info.timeout / 3));
  try {
    await server.ready();
    const page = await context.newPage();
    await bootstrapStlPage(page, origin, token, 'isolated STL test password');
    await expect(page.locator('#prompt')).toBeVisible();
    await page.request.post(`${origin}/api/mock/state`, { headers: { 'x-pi-web-test-client-intent': 'playwright-test' }, data: { webContributions: [{ version: 1, key: 'stl-touch', slot: 'artifact-preview', kind: 'rendered', title: 'STL', match: { kinds: ['file'], extensions: ['.gcode'] } }] } });
    const html = (await stlContribution(() => { throw Error('no server source read'); }).render({ context: { name: 'mesh.stl', path: '/api/artifacts/mesh.stl' } })).html;
    await page.route('**/api/web-contributions/invoke', route => route.fulfill({ json: { ok: true, html, artifactBytes: true } }));
    // A real binary tetrahedron, not a synthetic pointer-only viewer.
    let bytes: Buffer;
    const realSize = process.env.STL_INLINE_LARGE_MODEL ? (await stat('.pi/web/artifacts/model.stl')).size : 0;
    if (realSize) bytes = Buffer.alloc(0);
    else {
      bytes = Buffer.alloc(84 + 4 * 50); bytes.writeUInt32LE(4, 80);
      const faces = [[0,0,0, 1,0,0, 0,1,0], [0,0,0, 0,0,1, 1,0,0], [0,0,0, 0,1,0, 0,0,1], [1,0,0, 0,0,1, 0,1,0]];
      faces.forEach((f, i) => f.forEach((v, j) => bytes.writeFloatLE(v, 84 + i * 50 + 12 + j * 4)));
    }
    let probes = 0, full = 0, consentSize = 0;
    await page.route('**/api/session-artifacts/mock-current/e2e-toolpath.gcode', async route => {
      if (realSize) {
        if (route.request().headers().range) probes++; else full++;
        await route.continue({ url: `${origin}/api/session-artifacts/mock-current/model.stl` }); return;
      }
      if (route.request().headers().range) { probes++; await route.fulfill({ status: 206, headers: { 'content-range': `bytes 0-0/${consentSize || bytes.length}` }, body: bytes.subarray(0, 1) }); }
      else { full++; await route.fulfill({ headers: { 'content-length': String(bytes.length) }, body: bytes }); }
    });
    await page.reload();
    await page.locator('#prompt').fill('show gcode artifact');
    await page.locator('#promptForm').evaluate((f: HTMLFormElement) => f.requestSubmit());
    const card = page.locator('.artifactPreview--file').last();
    if ((realSize || bytes.length) > 20 * 1024 * 1024) { await card.getByRole('button', { name: 'Load full model', exact: true }).click(); }
    await expect(card.getByText('Exact source mesh · no simplification')).toBeVisible({ timeout: 90_000 });
    const shield = card.locator('.artifactPreviewShield');
    await expect(shield).toBeVisible();
    await expect(shield.locator('span')).toHaveCSS('opacity', '1');
    await shield.tap();
    const frame = card.locator('iframe');
    await expect(frame).toHaveCSS('pointer-events', 'auto');
    await expect(shield.locator('span')).toHaveCSS('opacity', '0');
    await frame.scrollIntoViewIfNeeded();
    const viewer = frame.contentFrame();
    const canvas = viewer.locator('canvas');
    await expect(viewer.locator('.gesture-hint')).toBeHidden();
    const before = await canvas.screenshot();
    const infoMenu = frame.contentFrame().locator('.info-menu');
    await infoMenu.locator('summary').tap();
    const upAxis = infoMenu.getByLabel('Model up axis');
    await expect(upAxis).toHaveValue('z');
    await expect(upAxis).toBeInViewport();
    await upAxis.selectOption('y');
    await infoMenu.locator('summary').tap();
    const yUp = await canvas.screenshot();
    expect(yUp).not.toEqual(before);
    await infoMenu.locator('summary').tap();
    await upAxis.selectOption('z');
    await page.screenshot({ path: '.pi/web/artifacts/stl-inline-mobile-axis-info.png' });
    await infoMenu.locator('summary').tap();
    expect(await canvas.screenshot()).not.toEqual(yUp);
    await expect(upAxis).toHaveValue('z');
    expect(full).toBe(1); // Axis changes rebuild only the bounded scene, never reload source.
    const box = await frame.boundingBox();
    if (!box) throw Error('frame missing');
    const cdp = await context.newCDPSession(page);
    for (let gesture = 0; gesture < 2; gesture++) {
      const y = Math.max(100, box.y + 180), x = box.x + box.width / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 5; n++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + n * 12, y: y + n * 4 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(card).toHaveClass(/artifactPreview--interactive/);
    }
    expect(await canvas.screenshot({ path: `.pi/web/artifacts/stl-inline-${realSize ? 'large' : 'small'}-touch.png` })).not.toEqual(before);
    expect(probes).toBe(1); expect(full).toBe(1);
    await page.locator('#prompt').tap();
    await expect(card).not.toHaveClass(/artifactPreview--interactive/);
    await shield.tap();
    await expect(frame).toHaveCSS('pointer-events', 'auto');
    await card.locator('.artifactPreviewTitle').tap();
    await expect(card).not.toHaveClass(/artifactPreview--interactive/);
    await card.locator('.artifactPreviewTitle').tap();
    await expect(shield).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.pi/web/artifacts/stl-inline-${realSize ? 'large' : 'small'}-page.png` });
    // Open in Artifacts is intentionally a separate mount today, not a cache.
    await card.getByRole('button', { name: 'Open in Artifacts panel' }).evaluate((button: HTMLButtonElement) => button.click());
    const panel = page.locator('#artifactBrowserPreviewBody');
    if (realSize) {
      await expect(panel.getByRole('button', { name: 'Load full model', exact: true })).toBeVisible();
      expect(full).toBe(1); // A second mount must still ask consent.
    } else {
      await expect(panel.getByText('Exact source mesh · no simplification')).toBeVisible();
      expect(full).toBe(2);
    }
    expect(probes).toBe(2);
    await panel.getByRole('button', { name: 'Unload model', exact: true }).click();
    await expect(panel.locator('iframe')).toHaveCount(0);
    await expect(panel.getByText('Model closed', { exact: true })).toBeVisible();
    for (const width of [393, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.pi/web/artifacts/stl-panel-${width}-closed.png` });
      const geometry = await panel.evaluate(el => {
        const host = el.getBoundingClientRect(), shell = el.querySelector('.artifact-stream')!.getBoundingClientRect();
        const card = el.querySelector('.artifact-stream-card > div')!.getBoundingClientRect();
        return { gap: Math.abs(host.height-shell.height), center: Math.abs((host.left+host.right)/2-(card.left+card.right)/2) };
      });
      expect(geometry.gap).toBeLessThan(2); expect(geometry.center).toBeLessThan(2);
    }
    await panel.getByRole('button', {name:'Open again',exact:true}).click();
    await expect(panel.locator('iframe')).toBeVisible();
    await page.screenshot({path:'.pi/web/artifacts/stl-panel-desktop-ready.png'});
    await page.setViewportSize({width:393,height:900}); await page.screenshot({path:'.pi/web/artifacts/stl-panel-mobile-ready.png'});
    await panel.getByRole('button',{name:'Unload model',exact:true}).click();
    consentSize=207000000;
    await panel.getByRole('button',{name:'Open again',exact:true}).click();
    await expect(panel.getByText('Open full-detail 3D preview',{exact:true})).toBeVisible();
    for(const width of [393,1440]) { await page.setViewportSize({width,height:900}); await page.screenshot({path:`.pi/web/artifacts/stl-panel-${width}-consent.png`}); const boxes=await panel.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('.artifact-stream-card > div')!.getBoundingClientRect();return Math.abs((a.left+a.right-b.left-b.right)/2);});expect(boxes).toBeLessThan(2); }


  } finally { try { await context.close(); } finally { await server.close(); } }
});
