import { expect, test } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const artifactPath = resolve(".pi/web/artifacts/activity-progress-tab-switch.webm");

test.skip(process.env.PI_WEB_CAPTURE_VIDEO !== "1", "Opt-in capture test; set PI_WEB_CAPTURE_VIDEO=1 to record the demo video.");
test.use({ video: { mode: "on", size: { width: 1280, height: 800 } } });

test("records activity and tool timers after switching session tabs", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/session-ui-state", {
    data: {
      pinnedSessions: [
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      ],
      sessionMarkers: [],
    },
  });

  await page.goto("/");
  await expect(page.locator("#sessionBar")).toBeVisible();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

  await page.locator("#prompt").fill("progress demo");
  await page.locator("#primaryButton").click();

  const liveCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
  await expect(liveCard).toBeVisible();
  await expect(liveCard.locator(".toolCardPartialBody")).toContainText("Opening /some/file");

  await page.waitForTimeout(2300);
  await expect(page.locator("#runtimeStatus")).toContainText(/Running [2-9]s|Running \d+m/);
  await expect(liveCard.locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);

  await page.reload();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await expect(page.locator("#runtimeStatus")).toContainText(/Running [2-9]s|Running \d+m/);
  await expect(page.locator(".toolCard.toolCard--running", { hasText: "read" }).last().locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);
  await page.waitForTimeout(600);

  await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
  await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
  await page.waitForTimeout(600);

  await page.locator(".sessionBarTab").filter({ hasText: "Current mock session" }).click();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

  const restoredCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
  await expect(page.locator("#runtimeStatus")).toContainText(/Running [2-9]s|Running \d+m/);
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard.locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);
  await page.waitForTimeout(1200);

  const video = page.video();
  await page.close();
  if (!video) throw new Error("Playwright video capture was not enabled");
  await mkdir(dirname(artifactPath), { recursive: true });
  await copyFile(await video.path(), artifactPath);
});
