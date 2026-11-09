import { expect, test } from '@playwright/test';

const artifactText = `[Preview](/api/artifacts/one.html)\n\n${'Long artifact response remains open. '.repeat(70)}`;
const prose = (entryId: string, text: string) => ({ role: 'assistant', entryId, text, raw: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });

test('retained artifact owners replay response grouping, including changed predecessors', async ({ page }) => {
  await page.request.post('/api/mock/reset');
  const a = prose('artifact-a', artifactText), b = prose('assistant-b', 'Follow-up in the same response');
  let messages: unknown[] = [{ role: 'user', entryId: 'request', text: 'Request' }, a, { role: 'toolResult', toolName: 'read', toolCallId: 'read-result', text: 'A result' }, b];
  await page.route('**/api/messages?*', route => route.fulfill({ json: { messages } }));
  await page.route('**/api/session-artifacts/*/one.html', route => route.fulfill({ contentType: 'text/html', body: '<p>Live preview</p>' }));
  await page.goto('/');
  const owner = page.locator('.message.assistant[data-entry-id="artifact-a"]');
  const later = page.locator('.message.assistant[data-entry-id="assistant-b"]');
  const frame = await owner.locator('iframe').elementHandle();
  const refresh = async () => {
    const response = page.waitForResponse(r => r.url().includes('/api/messages?'));
    await page.request.post('/api/mock/event', { data: { type: 'state_changed', sessionId: 'mock-current' } });
    await response;
  };
  await refresh();
  await expect(owner).not.toHaveClass(/collapsed/);
  await expect(owner).toHaveAttribute('data-assistant-response-key', 'artifact-a');
  await expect(later).toHaveAttribute('data-assistant-response-key', 'artifact-a');
  expect(await frame!.evaluate(el => el.isConnected)).toBe(true);
  messages = [{ role: 'user', entryId: 'request', text: 'Request' }, prose('new-predecessor', 'Earlier response prefix'), a, b];
  await refresh();
  await expect(owner).toHaveAttribute('data-assistant-response-key', 'new-predecessor');
  await expect(later).toHaveAttribute('data-assistant-response-key', 'new-predecessor');
  await expect(owner).not.toHaveClass(/collapsed/);
  expect(await frame!.evaluate(el => el.isConnected)).toBe(true);
});

test('unchanged artifact plus tool-call DTO rebuilds pending toolcards when runtime becomes streaming', async ({ page }) => {
  await page.request.post('/api/mock/reset');
  const message = { role: 'assistant', entryId: 'mixed-owner', text: artifactText, raw: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: artifactText }, { type: 'toolCall', id: 'pending-read', name: 'read', arguments: { path: '/tmp/pending.txt' } }] } };
  await page.route('**/api/messages?*', route => route.fulfill({ json: { messages: [message] } }));
  await page.route('**/api/session-artifacts/*/one.html', route => route.fulfill({ contentType: 'text/html', body: '<p>Live preview</p>' }));
  await page.goto('/');
  const original = await page.locator('.artifactPreview iframe').elementHandle();
  await expect(page.locator('.toolCard--running')).toHaveCount(0);
  await page.request.post('/api/mock/event', { data: { type: 'session_runtime_changed', sessionId: 'mock-current', runtime: { loaded: true, isRunning: true, isStreaming: true, isRetrying: false, isCompacting: false, pendingMessageCount: 0 } } });
  const response = page.waitForResponse(r => r.url().includes('/api/messages?'));
  await page.request.post('/api/mock/event', { data: { type: 'state_changed', sessionId: 'mock-current' } });
  await response;
  await expect(page.locator('.toolCard--running[data-tool-name="read"]')).toHaveCount(1);
  expect(await original!.evaluate(el => el.isConnected)).toBe(false);
});
