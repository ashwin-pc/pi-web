import { expect, test } from '@playwright/test';

test('transcript reconciliation retains unchanged connected artifact owners, invalidates changed/deleted owners and sessions', async ({ page }) => {
  await page.request.post('/api/mock/reset');
  const owner = (path = 'one.html', extra = {}) => ({ role: 'assistant', entryId: 'artifact-owner', text: `[Preview](/api/artifacts/${path})`, ...extra });
  let messages: Record<string, unknown>[] = [owner()];
  await page.route('**/api/messages?*', route => route.fulfill({ json: { messages } }));
  await page.route('**/api/session-artifacts/*/*.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Live preview</p>' }));
  await page.goto('/');
  const frame = page.locator('.artifactPreview iframe');
  await expect(frame).toHaveCount(1);
  const original = await frame.elementHandle();
  const refresh = async () => {
    const request = page.waitForResponse(r => r.url().includes('/api/messages?'));
    await page.request.post('/api/mock/event', { data: { type: 'state_changed', sessionId: 'mock-current' } });
    await request;
  };
  messages = [{ role: 'user', entryId: 'incoming', text: 'A new incoming message' }, owner()];
  await refresh();
  await expect(page.locator('.message.user')).toContainText('A new incoming message');
  expect(await original!.evaluate(el => el === document.querySelector('.artifactPreview iframe') && el.isConnected)).toBe(true);
  await expect(page.locator('#messages > .message').first()).toHaveClass(/user/);
  // Complete DTO fingerprint, not text alone: a timestamp edit invalidates.
  messages = [owner('one.html', { timestamp: 123 })];
  await refresh();
  await expect.poll(() => original!.evaluate(el => el.isConnected)).toBe(false);
  const changed = await frame.elementHandle();
  messages = [owner('two.html')];
  await refresh();
  await expect.poll(() => changed!.evaluate(el => el.isConnected)).toBe(false);
  const selected = await frame.elementHandle();
  messages = [];
  await refresh();
  await expect(frame).toHaveCount(0);
  expect(await selected!.evaluate(el => el.isConnected)).toBe(false);
  messages = [owner()];
  await refresh();
  await expect(frame).toHaveCount(1);
  const beforeSwitch = await frame.elementHandle();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByText('Older mock session', { exact: true }).click();
  await expect(page.locator('#statusTitle')).toHaveText('Older mock session');
  await expect(frame).toHaveCount(1);
  expect(await beforeSwitch!.evaluate(el => el.isConnected).catch(() => false)).toBe(false);
});
