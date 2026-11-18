import { test, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, hashSecret, randomSecret } from '../../server/auth/kernel.js';
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from './helpers/owned-stl-server.js';

test('text-block retention preserves canonical thinking, tool results, suffixes and transcript ordering', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(90_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-text-blocks-'));
  const authPath = join(dir, 'auth.json'), token = randomSecret();
  await new AuthStore(authPath).update(state => {
    state.config = { policy: 'authenticated', methods: [] };
    state.bootstrap = { hash: hashSecret(token), expiresAt: Date.now() + 120_000 };
  });
  const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'x-pi-web-test-client-intent': 'playwright-test' } });
  const server = startOwnedStlServer({ ...await isolatedStlEnv(dir), PI_WEB_AUTH_STORE: authPath,
    PI_WEB_AUTH_POLICY: 'authenticated', PI_WEB_AUTH_ORIGIN: origin, PI_WEB_MOCK: '1', PI_WEB_DEV: '0', NODE_ENV: 'test',
    HOST: '127.0.0.1', PORT: String(port), PI_WEB_CWD: dir, PI_WEB_SETTINGS_FILE: join(dir, 'settings.json'),
    PI_WEB_SESSION_UI_STATE_FILE: join(dir, 'sessions.json') }, dir, 30_000);
  try {
    await server.ready();
    const page = await context.newPage();
    const text = (name: string) => `[${name}](/api/artifacts/${name}.html)`;
    const first = text('first'), second = text('second');
    const parts = [
      { type: 'thinking', thinking: 'Canonical thinking survives refresh' },
      { type: 'text', text: first },
      { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: '/tmp/fixture.txt' } },
      { type: 'text', text: second },
    ];
    const assistant = (entryId = 'mixed', content = parts, suffix = 'Visible suffix') => ({
      role: 'assistant', entryId, text: [first, second].join('\n') + '\n' + suffix,
      raw: { role: 'assistant', stopReason: 'toolUse', content },
    });
    const result = (value: string) => ({ role: 'toolResult', entryId: 'result', toolName: 'read', toolCallId: 'read-call', text: value, raw: { content: [{ type: 'text', text: value }] } });
    let messages: unknown[] = [assistant(), result('Original completed result')];
    await page.route('**/api/messages?*', route => route.fulfill({ json: { messages } }));
    await page.route('**/api/session-artifacts/*/*.html', route => route.fulfill({ contentType: 'text/html', body: '<p>Live text block</p>' }));
    await bootstrapStlPage(page, origin, token, 'isolated text block fixture password');
    await expect(page.locator('#prompt')).toBeVisible();
    const frames = page.locator('.artifactPreview iframe');
    await expect(frames).toHaveCount(2);
    const original = await frames.elementHandles();
    for (const [index, frame] of original.entries()) {
      await frame.contentFrame().then(frame => frame!.evaluate(index => { document.body.dataset.nonce = `block-${index}`; }, index));
    }
    const refresh = async () => {
      const response = page.waitForResponse(r => r.url().includes('/api/messages?'));
      const event = await page.request.post(origin + '/api/mock/event', { data: { type: 'state_changed', sessionId: 'mock-current' } });
      expect(event.ok()).toBe(true);
      await response;
    };
    const assertRetained = async () => {
      await expect(frames).toHaveCount(2);
      for (const [index, frame] of original.entries()) {
        expect(await frame.evaluate((el, index) => el.isConnected && el === document.querySelectorAll('.artifactPreview iframe')[index], index)).toBe(true);
        await expect(frames.nth(index).contentFrame().locator('body')).toHaveAttribute('data-nonce', `block-${index}`);
      }
      await expect(page.locator('.toolCard').filter({ hasText: 'Canonical thinking survives refresh' })).toHaveCount(1);
      await expect(page.locator('.message.assistant').filter({ hasText: 'Visible suffix' })).toHaveCount(1);
      const layout = await page.locator('#messages > .message, #messages > .toolCard').allTextContents();
      expect(layout.findIndex(text => text.includes('Canonical thinking survives refresh'))).toBeLessThan(layout.findIndex(text => text.includes('first')));
      expect(layout.findIndex(text => text.includes('first'))).toBeLessThan(layout.findIndex(text => text.includes('second')));
      expect(layout.findIndex(text => text.includes('second'))).toBeLessThan(layout.findIndex(text => text.includes('Visible suffix')));
    };
    messages = [assistant(), result('Updated completed result'), { role: 'assistant', entryId: 'following', text: 'Following new content' }];
    await refresh();
    await expect(page.locator('.toolCard').filter({ hasText: 'Updated completed result' })).toHaveCount(1);
    await expect(page.locator('.toolCard').filter({ hasText: 'Original completed result' })).toHaveCount(0);
    await expect(page.locator('.message.assistant').filter({ hasText: 'Following new content' })).toHaveCount(1);
    await assertRetained();
    // Remove the result and make the same call pending; its card must be rebuilt.
    messages = [assistant()];
    const running = await page.request.post(origin + '/api/mock/event', { data: {
      type: 'session_runtime_changed', sessionId: 'mock-current', runtime: { loaded: true, isRunning: true, isStreaming: true, isRetrying: false, isCompacting: false, pendingMessageCount: 0 },
    } });
    expect(running.ok()).toBe(true);
    await refresh();
    await expect(page.locator('.toolCard--running[data-tool-name="read"]')).toHaveCount(1);
    await expect(page.locator('.toolCard').filter({ hasText: 'Updated completed result' })).toHaveCount(0);
    await assertRetained();
    messages = [assistant(), result('Final completed result')];
    await refresh();
    await expect(page.locator('.toolCard--running[data-tool-name="read"]')).toHaveCount(0);
    await expect(page.locator('.toolCard').filter({ hasText: 'Final completed result' })).toHaveCount(1);
    await assertRetained();
    // Identical text in a different entry must not alias either original block.
    messages = [assistant(), result('Final completed result'), assistant('distinct-entry')];
    await refresh();
    await expect(frames).toHaveCount(4);
    expect(await original[0].evaluate(el => el.isConnected)).toBe(true);
    expect(await original[1].evaluate(el => el.isConnected)).toBe(true);
    // Reordering stable text blocks invalidates rather than reparenting live frames.
    messages = [assistant('distinct-entry'), assistant(), result('Final completed result')];
    await refresh();
    await expect.poll(() => original[0].evaluate(el => el.isConnected)).toBe(false);
    await expect.poll(() => original[1].evaluate(el => el.isConnected)).toBe(false);
    await expect(frames).toHaveCount(4);
    const beforeEdit = await frames.first().elementHandle();
    messages = [assistant('distinct-entry', parts.map((part, index) => index === 1 ? { type: 'text', text: text('changed') } : part)), assistant(), result('Final completed result')];
    await refresh();
    await expect.poll(() => beforeEdit!.evaluate(el => el.isConnected)).toBe(false);
    await expect(frames).toHaveCount(4);
    const beforeSwitch = await frames.elementHandles();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByText('Older mock session', { exact: true }).click();
    await expect(page.locator('#statusTitle')).toHaveText('Older mock session');
    await expect(frames).toHaveCount(4);
    for (const frame of beforeSwitch) expect(await frame.evaluate(el => el.isConnected)).toBe(false);
  } finally {
    try { await context.close(); } finally { await server.close(); }
  }
});
