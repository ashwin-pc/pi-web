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
