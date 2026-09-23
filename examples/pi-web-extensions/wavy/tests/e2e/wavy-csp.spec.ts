import { expect, test } from "@playwright/test";
import { renderWavyPreview } from "../../preview.js";
import type { LoadedProject } from "../../types.js";

function fixture(): LoadedProject {
  return {
    absolutePath: "/tmp/csp.wavy", artifactPath: "/api/artifacts/csp.wavy", warnings: [],
    head: {
      lyrics: "Offline preview", style: "Triangle oscillator",
      score: "X:1\nT:CSP\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC D E F|",
      settings: { precision: "bf16", planning: "full", maxSemanticTokens: 9000 },
    },
    index: {
      format: "wavy", version: 1, title: "CSP fixture", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
      revision: 1, revisions: [], sources: [], takes: [],
    },
  };
}

test("opaque preview denies outbound connections while notation and oscillator audition remain usable", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium run covers the CSP contract");
  let outboundRequests = 0;
  await page.route("https://wavy-csp.invalid/**", route => { outboundRequests++; return route.abort(); });
  const html = await renderWavyPreview(fixture());
  await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
  const iframe = page.locator("iframe");
  await iframe.evaluate((element, source) => { (element as HTMLIFrameElement).srcdoc = source; }, html);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const frame = iframe.contentFrame();

  await expect(frame.locator("#notation svg")).toBeVisible();
  const origin = await frame.locator("body").evaluate(() => location.origin);
  expect(origin).toBe("null");
  const fetchResult = await frame.locator("body").evaluate(async () => {
    try { await fetch("https://wavy-csp.invalid/probe"); return "allowed"; }
    catch (error) { return error instanceof TypeError ? "blocked" : `blocked:${String(error)}`; }
  });
  expect(fetchResult).toMatch(/^blocked/);
  expect(outboundRequests).toBe(0);

  await frame.getByRole("button", { name: "Play written music" }).click();
  await expect(frame.getByRole("button", { name: "Pause written music" })).toBeVisible();
  await expect.poll(() => frame.locator("#notation .active-note").count()).toBeGreaterThan(0);
  await frame.getByRole("button", { name: "Pause written music" }).click();
});
