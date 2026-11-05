import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the canonical typed implementation in a real DOM, without app globals.
const moduleSource = ts.transpileModule(readFileSync("src/components/toasts.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

test.beforeEach(async ({ page }) => {
  await page.route("**/toast-test-module.js", route => route.fulfill({ contentType: "text/javascript", body: moduleSource }));
  await page.route("**/toast-test", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><aside id="notices"></aside><button id="outside">Outside</button><script type="module">
    import { createToastCenter } from '/toast-test-module.js';
    window.notices = createToastCenter(document.querySelector('#notices'));
  </script>` }));
  await page.goto("/toast-test");
  await page.waitForFunction(() => Boolean((window as any).notices));
  await page.clock.install();
});

test("persistent notices deduplicate and survive hover, focus and time", async ({ page }) => {
  await page.evaluate(() => {
    const notices = (window as any).notices;
    notices.show({ id: "recovery", message: "Offline", persistent: true, actions: [{ label: "Retry", run() {} }] });
    notices.show({ id: "recovery", message: "Still offline", persistent: true, actions: [{ label: "Retry", run() {} }] });
  });
  await expect(page.getByRole("status")).toHaveText("Still offline");
  await expect(page.locator(".toast")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).focus();
  await page.evaluate(() => (window as any).notices.show({ id: "recovery", message: "Offline again", persistent: true, actions: [{ label: "Retry", run() {} }] }));
  await expect(page.getByRole("button", { name: "Retry" })).toBeFocused();
  await page.clock.runFor(60_000);
  await page.locator("#outside").focus();
  await page.mouse.move(800, 600);
  await page.clock.runFor(60_000);
  await expect(page.locator(".toast")).toBeVisible();
  await page.evaluate(() => (window as any).notices.dismiss("recovery"));
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("transient timers pause for focus and reset on replacement; messages are text", async ({ page }) => {
  await page.evaluate(() => (window as any).notices.show({ id: "copy", message: "<img src=x onerror=alert(1)>", durationMs: 2000 }));
  await expect(page.locator(".toast img")).toHaveCount(0);
  await page.getByRole("button", { name: "Dismiss" }).focus();
  await page.clock.runFor(5000);
  await expect(page.locator(".toast")).toHaveCount(1);
  await page.locator("#outside").focus();
  await page.mouse.move(800, 600);
  await page.clock.runFor(1000);
  await page.evaluate(() => (window as any).notices.show({ id: "copy", message: "Copied", durationMs: 3000 }));
  await page.clock.runFor(2000);
  await expect(page.getByRole("status")).toHaveText("Copied");
  await page.clock.runFor(1001);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("async actions prevent duplicate clicks and surface failures", async ({ page }) => {
  await page.evaluate(() => (window as any).notices.show({ id: "action", message: "Needs attention", persistent: true,
    actions: [{ label: "Retry", run: () => new Promise((_, reject) => setTimeout(() => reject(new Error("private details")), 1000)) }] }));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled();
  await page.clock.runFor(1001);
  await expect(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect(page.locator('[data-toast-id="action:action-error"]')).toContainText("Retry failed. Please try again.");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".toast")).toHaveCount(1);
});

test("replaced or dismissed async actions cannot mutate a newer notice", async ({ page }) => {
  await page.evaluate(() => (window as any).notices.show({ id: "action", message: "Old", persistent: true,
    actions: [{ label: "Retry", run: () => new Promise((_, reject) => { (window as any).rejectOld = reject; }) }] }));
  const retry = page.getByRole("button", { name: "Retry" });
  await retry.focus();
  await retry.press("Enter");
  await expect(retry).toBeFocused();
  await page.evaluate(() => (window as any).notices.show({ id: "action", message: "New", persistent: true,
    actions: [{ label: "Retry", run: () => new Promise((_, reject) => { (window as any).rejectNew = reject; }) }] }));
  await expect(retry).toBeEnabled();
  await retry.press("Enter");
  await page.evaluate(() => (window as any).rejectOld(new Error("stale")));
  await expect(retry).toBeDisabled();
  await expect(page.locator('[data-toast-id="action:action-error"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).notices.dismiss("action"); (window as any).rejectNew(new Error("dismissed")); });
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("stale successful actions cannot clear a replacement's failure", async ({ page }) => {
  await page.evaluate(() => (window as any).notices.show({ id: "action", message: "Old", persistent: true,
    actions: [{ label: "Retry", run: () => new Promise<void>(resolve => { (window as any).resolveOld = resolve; }) }] }));
  await page.getByRole("button", { name: "Retry" }).click();
  await page.evaluate(() => (window as any).notices.show({ id: "action", message: "New", persistent: true,
    actions: [{ label: "Retry", run: async () => { throw new Error("new failure"); } }] }));
  await page.getByRole("button", { name: "Retry" }).click();
  const failure = page.locator('[data-toast-id="action:action-error"]');
  await expect(failure).toBeVisible();
  await page.evaluate(async () => { (window as any).resolveOld(); await Promise.resolve(); });
  await expect(failure).toBeVisible();
});

test("pending transient actions retain focus and pause expiry until settled", async ({ page }) => {
  await page.evaluate(() => (window as any).notices.show({ id: "slow", message: "Working", durationMs: 1000,
    actions: [{ label: "Run", run: () => new Promise<void>(resolve => { (window as any).finish = resolve; }) }] }));
  const run = page.getByRole("button", { name: "Run", exact: true });
  await run.focus();
  await run.press("Enter");
  await expect(run).toBeFocused();
  await page.locator("#outside").focus();
  await page.mouse.move(800, 600);
  await page.clock.runFor(10_000);
  await expect(page.locator(".toast")).toHaveCount(1);
  await page.evaluate(() => (window as any).finish());
  await expect(run).toBeEnabled();
  await page.clock.runFor(1001);
  await expect(page.locator(".toast")).toHaveCount(0);
});
