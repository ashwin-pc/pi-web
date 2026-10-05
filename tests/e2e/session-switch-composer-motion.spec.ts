import { expect, test } from "@playwright/test";

test("pinned session draft restoration skips composer motion but input focus still animates", async ({ page }, testInfo) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/session-ui-state", {
    data: { pinnedSessions: [{ id: "mock-current" }, { id: "mock-older" }] },
  });
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
  const current = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
  const older = page.locator(".sessionBarTab").filter({ hasText: "Older mock session" });
  await current.click();
  await page.locator("#prompt").fill("Draft preserved across pinned sessions");
  await older.click();
  await expect(page.locator("#prompt")).toHaveValue("");
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(".composer")!;
    composer.dataset.restoreTransitions = "0";
    composer.addEventListener("transitionrun", (event) => {
      if (event.target === composer && ["height", "margin-right"].includes(event.propertyName)) {
        composer.dataset.restoreTransitions = String(Number(composer.dataset.restoreTransitions) + 1);
      }
    });
  });
  for (let index = 0; index < 6; index++) {
    await (index % 2 === 0 ? current : older).click();
    await expect(page.locator("#prompt")).toHaveValue(index % 2 === 0 ? "Draft preserved across pinned sessions" : "");
    // Let transitionrun dispatch if restoration accidentally starts a transition.
    await page.waitForTimeout(120);
    await expect(page.locator(".composer")).not.toHaveClass(/restoringSessionDraft/);
  }
  await expect(page.locator(".composer")).toHaveAttribute("data-restore-transitions", "0");
  await page.locator("#prompt").focus();
  if (testInfo.project.name === "mobile") {
    await expect.poll(() => page.locator(".composer").getAttribute("data-restore-transitions"))
      .not.toBe("0");
  }
});
