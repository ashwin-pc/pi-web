import { expect, test } from "@playwright/test";

const long = (label: string) => `${label}\n\n${"A deliberately long assistant response remains readable. ".repeat(45)}`;
const prose = (text: string, entryId: string) => ({
  role: "assistant", entryId, text,
  raw: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

for (const density of ["comfortable", "compact", "minimal"] as const) {
  test(`latest assistant prose stays open in ${density} history despite trailing non-prose entries`, async ({ page }) => {
    await page.request.post("/api/mock/reset");
    await page.route("**/api/settings", route => route.request().method() === "GET"
      ? route.fulfill({ json: { settings: { appearance: { density } } } })
      : route.continue());
    await page.route("**/api/messages?*", route => route.fulfill({ json: { messages: [
      { role: "user", text: "first request" },
      prose(long("older prose"), "assistant-old"),
      { role: "user", text: "latest request" },
      prose(long("latest prose"), "assistant-latest"),
      { role: "toolResult", toolName: "read", text: "trailing activity", raw: { id: "tool-tail" } },
      { role: "custom", customType: "worker_report", text: "trailing custom report", entryId: "custom-tail" },
    ] } }));

    await page.goto("/");
    const older = page.locator('.message.assistant[data-entry-id="assistant-old"]');
    const latest = page.locator('.message.assistant[data-entry-id="assistant-latest"]');
    await expect(older).toHaveClass(/collapsed/);
    await expect(latest).not.toHaveClass(/collapsed/);
    await expect(latest.locator(".messageToggle")).toHaveText("Show less");

    // An explicit choice is stable across unrelated activity reconciliation.
    await latest.locator(".messageToggle").click();
    await expect(latest).toHaveClass(/collapsed/);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(latest).toHaveClass(/collapsed/);

    await page.reload();
    await expect(older).toHaveClass(/collapsed/);
    await expect(latest).not.toHaveClass(/collapsed/);
  });
}

test("long streaming assistant prose stays open live and after settlement", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await page.locator("#prompt").fill("streaming markdown benchmark paced");
  await page.locator("#primaryButton").click();

  const latest = page.locator("#messages > .message.assistant").last();
  await expect(latest).toHaveClass(/collapsible/, { timeout: 15_000 });
  await expect(latest).not.toHaveClass(/collapsed/);
  await expect(latest.locator(".messageToggle")).toHaveText("Show less");
  await expect(page.locator("#stopButton")).toBeHidden({ timeout: 20_000 });
  await expect(latest).not.toHaveClass(/collapsed/);

  await latest.locator(".messageToggle").click();
  await expect(latest).toHaveClass(/collapsed/);
});
