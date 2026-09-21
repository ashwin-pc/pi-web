import { expect, test, type Page, type Route } from "@playwright/test";

// Frontend integration coverage: contribution render/invoke responses are mocked at
// the E2E HTTP boundary. This exercises the real host mount, opaque iframe bridge,
// native review dialog, and composer; it is not a real extension-server test.
const registrationId = "review-registration-1";
const descriptor = {
  version: 1,
  key: "review.viewer",
  slot: "artifact-preview",
  kind: "rendered",
  title: "Review fixture",
  match: { kinds: ["file"], extensions: [".gcode"] },
  interaction: { registrationId, actions: ["review-edit"] },
};
const context = {
  type: "reference",
  id: "artifact:e2e-toolpath:selection",
  label: "Toolpath selection",
  title: "Frozen toolpath source",
  reference: {
    provider: "artifact",
    path: "e2e-toolpath.gcode",
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    snapshot: { label: "E2E snapshot", revision: "7" },
    ranges: [{ start: 0, end: 12, unit: "utf16", label: "lines 1–2" }],
  },
};
const proposal = (text = "Review the frozen toolpath selection.") => ({
  status: "review",
  review: {
    title: "Review proposed chat addition",
    summary: "Confirm the exact text and frozen source reference.",
    effects: [
      { type: "insert-composer-text", text, placement: "end" },
      { type: "add-composer-context", context },
    ],
  },
});
const viewer = `<!doctype html><meta name="viewport" content="width=device-width"><body>
<button id="review">Request review</button><button id="bad">Bad action</button><button id="large">Large payload</button>
<output id="result">idle</output><script>
const out=document.querySelector('#result');
async function ask(request){const result=await piWebPreview.requestReview(request);out.textContent=result.status+(result.message?':'+result.message:'')}
review.onclick=()=>ask({action:'review-edit',payload:{revision:7,selection:[0,12]}});
bad.onclick=()=>ask({action:'not-allowed',payload:{}});
large.onclick=()=>ask({action:'review-edit',payload:{text:'x'.repeat(33000)}});
piWebPreview.onViewportChange(viewport=>parent.postMessage({viewportFixture:viewport},'*'));
</script>`;

async function mount(page: Page, responder: (route: Route, invocation: number) => Promise<void> | void = (route) => route.fulfill({ json: { ok: true, ...proposal() } }), activate = true) {
  await page.request.post("/api/mock/reset");
  let invocation = 0;
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.event?.context).toEqual({
      name: "e2e-toolpath.gcode",
      // The route mock observes the browser request before the real server
      // canonicalizes this accepted host input to an owning-session URL.
      path: "/api/artifacts/e2e-toolpath.gcode",
      kind: "file",
    });
    if (!body.event?.action) return route.fulfill({ json: { ok: true, html: viewer, assets: [] } });
    expect(body.event.registrationId).toBe(registrationId);
    invocation++;
    return responder(route, invocation);
  });
  await page.request.post("/api/mock/state", { data: { webContributions: [descriptor] } });
  await page.goto("/");
  await page.evaluate(() => {
    (window as any).__viewportFixtureEvents = [];
    addEventListener("message", (event) => { if (event.data?.viewportFixture) (window as any).__viewportFixtureEvents.push(event.data.viewportFixture); });
  });
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#prompt").fill("show gcode artifact");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  const frame = page.locator(".artifactPreview--file iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(frame.contentFrame().getByRole("button", { name: "Request review" })).toBeVisible();
  // Activate the real preview interaction shield before addressing iframe UI.
  if (activate) await page.getByRole("button", { name: "Click to interact with e2e-toolpath.gcode" }).click();
  return frame;
}

async function requestReview(page: Page) {
  const frame = page.locator(".artifactPreview--file iframe");
  const preview = page.locator(".artifactPreview--file");
  if (!(await preview.evaluate((element) => element.classList.contains("artifactPreview--interactive")))) {
    await page.getByRole("button", { name: "Click to interact with e2e-toolpath.gcode" }).click();
  }
  await frame.contentFrame().getByRole("button", { name: "Request review" }).click();
  const dialog = page.getByRole("dialog", { name: "Review proposed chat addition" });
  await expect(dialog).toBeVisible();
  return { frame, dialog };
}

test("touch activation remains active across consecutive iframe taps", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "touch-specific interaction guard");
  const frame = await mount(page, undefined, false);
  const preview = page.locator(".artifactPreview--file");
  await page.getByRole("button", { name: "Click to interact with e2e-toolpath.gcode" }).tap();
  await expect(preview).toHaveClass(/artifactPreview--interactive/);
  await frame.contentFrame().getByRole("button", { name: "Bad action" }).tap();
  await expect(frame.contentFrame().locator("#result")).toContainText("unsupported");
  await expect(preview).toHaveClass(/artifactPreview--interactive/);
  await frame.contentFrame().getByRole("button", { name: "Request review" }).tap();
  await expect(page.getByRole("dialog", { name: "Review proposed chat addition" })).toBeVisible();
});

test("review is inert until approval; cancel preserves the complete draft", async ({ page }) => {
  const frame = await mount(page);
  await page.locator("#prompt").fill("Existing draft");
  const { dialog } = await requestReview(page);
  await expect(page.locator("#prompt")).toHaveValue("Existing draft");
  await expect(page.locator(".attachmentChip")).toHaveCount(0);
  await expect(page.locator(".message.user", { hasText: "Review the frozen" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#prompt")).toHaveValue("Existing draft");
  await expect(frame.contentFrame().locator("#result")).toHaveText("cancelled");

  // The host-owned Review dialog belongs to this preview. Its Cancel click must
  // not count as an outside click that re-enables the iframe shield.
  await expect(page.locator(".artifactPreview--file")).toHaveClass(/artifactPreview--interactive/);
  await frame.contentFrame().getByRole("button", { name: "Request review" }).click();
  const secondDialog = page.getByRole("dialog", { name: "Review proposed chat addition" });
  await expect(secondDialog).toBeVisible();
  await secondDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(frame.contentFrame().locator("#result")).toHaveText("cancelled");
});

test("Add to chat appends without sending and upserts colliding context ids", async ({ page }) => {
  const frame = await mount(page);
  await page.locator("#prompt").fill("Existing draft");
  await page.locator("#imageInput").setInputFiles({ name: "existing.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  await expect(page.locator(".attachmentChip")).toContainText("existing.png");
  let before = await page.locator(".message.user").count();
  let { dialog } = await requestReview(page);
  await dialog.getByRole("button", { name: "Add to chat" }).click();
  await expect(frame.contentFrame().locator("#result")).toHaveText("added");
  await expect(page.locator("#prompt")).toHaveValue("Existing draft\n\nReview the frozen toolpath selection.");
  await expect(page.locator(".attachmentChip")).toHaveCount(2);
  await expect(page.locator(".attachmentChip", { hasText: "existing.png" })).toHaveCount(1);
  await expect(page.locator(".attachmentChip", { hasText: "Toolpath selection" })).toHaveCount(1);
  expect(await page.locator(".message.user").count()).toBe(before);

  ({ dialog } = await requestReview(page));
  await dialog.getByRole("button", { name: "Add to chat" }).click();
  await expect(frame.contentFrame().locator("#result")).toHaveText("added");
  await expect(page.locator(".attachmentChip")).toHaveCount(2);
  await expect(page.locator(".attachmentChip", { hasText: "existing.png" })).toHaveCount(1);
  await expect(page.locator(".attachmentChip", { hasText: "Toolpath selection" })).toHaveCount(1);
});

test("changed revalidation and stale draft reject atomically", async ({ page }) => {
  let mode: "changed" | "stable" = "changed";
  const frame = await mount(page, (route, invocation) => route.fulfill({ json: { ok: true, ...proposal(mode === "changed" && invocation === 2 ? "Changed after review" : undefined) } }));
  await page.locator("#prompt").fill("Keep me");
  let { dialog } = await requestReview(page);
  await dialog.getByRole("button", { name: "Add to chat" }).click();
  await expect(frame.contentFrame().locator("#result")).toContainText("stale");
  await expect(page.locator("#prompt")).toHaveValue("Keep me");
  await expect(page.locator(".attachmentChip")).toHaveCount(0);

  mode = "stable";
  ({ dialog } = await requestReview(page));
  await page.locator("#prompt").evaluate((element: HTMLTextAreaElement) => {
    element.value = "Draft changed while reviewing";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Draft changed while reviewing" }));
  });
  await dialog.getByRole("button", { name: "Add to chat" }).click();
  await expect(frame.contentFrame().locator("#result")).toContainText("stale");
  await expect(page.locator("#prompt")).toHaveValue("Draft changed while reviewing");
  await expect(page.locator(".attachmentChip")).toHaveCount(0);
});

test("allow-list and payload bounds fail closed without opening host review", async ({ page }) => {
  const frame = await mount(page);
  await frame.contentFrame().getByRole("button", { name: "Bad action" }).click();
  await expect(frame.contentFrame().locator("#result")).toContainText("unsupported");
  await expect(page.locator(".artifactReviewDialog")).toHaveCount(0);
  await frame.contentFrame().getByRole("button", { name: "Large payload" }).click();
  await expect(frame.contentFrame().locator("#result")).toContainText("unsupported");
  await expect(page.locator(".artifactReviewDialog")).toHaveCount(0);
});

test("visible viewport follows host clipping and stops after preview detach", async ({ page }) => {
  await mount(page);
  await expect.poll(() => page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1)?.visible?.bottom || 0)).toBeGreaterThan(0);
  await page.locator("#imageInput").setInputFiles({ name: "occluding.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  await expect(page.locator("#attachments")).toContainText("occluding.png");
  const expectedOccludedBottom = await page.evaluate(() => {
    const attachment = document.querySelector<HTMLElement>("#attachments")!;
    const frame = document.querySelector<HTMLIFrameElement>(".artifactPreview--file iframe")!;
    const attachmentRect = attachment.getBoundingClientRect();
    frame.style.position = "fixed";
    frame.style.left = `${attachmentRect.left}px`;
    frame.style.top = `${attachmentRect.top - 200}px`;
    frame.style.width = `${Math.max(200, attachmentRect.width)}px`;
    frame.style.height = "400px";
    const frameRect = frame.getBoundingClientRect();
    const scaleY = frameRect.height / frame.offsetHeight;
    return Math.max(0, Math.min(frame.clientHeight, (attachmentRect.top - frameRect.top - frame.clientTop * scaleY) / scaleY));
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect.poll(() => page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1)?.visible?.bottom || 0)).toBeCloseTo(expectedOccludedBottom, 0);
  const safeViewport = await page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1));
  expect(safeViewport.visible.top).toBeGreaterThanOrEqual(0);
  expect(safeViewport.visible.bottom).toBeLessThanOrEqual(safeViewport.height);
  expect(safeViewport.visible.bottom).toBeGreaterThanOrEqual(safeViewport.visible.top);
  await page.locator(".artifactPreview--file iframe").evaluate((frame: HTMLIFrameElement) => frame.removeAttribute("style"));
  await page.getByRole("button", { name: "Remove occluding.png" }).click();
  const clip = page.locator(".artifactPreview--file .artifactPreviewContent");
  await clip.evaluate((element: HTMLElement) => {
    element.style.height = "180px";
    element.style.overflow = "hidden";
    element.style.padding = "0";
    const frame = element.querySelector("iframe")!;
    frame.style.height = "400px";
    frame.style.minHeight = "400px";
  });
  await clip.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1)?.height || 0)).toBe(400);
  await expect.poll(() => page.evaluate(() => {
    const viewport = (window as any).__viewportFixtureEvents.at(-1);
    return viewport?.visible?.bottom > 0 && viewport.visible.bottom <= 180;
  })).toBe(true);
  const beforeClipResize = await page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1).visible.bottom);
  await clip.evaluate((element: HTMLElement) => { element.style.height = "90px"; });
  await expect.poll(() => page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1)?.visible?.bottom || 0)).toBeLessThan(beforeClipResize);
  expect(await page.evaluate(() => (window as any).__viewportFixtureEvents.at(-1).visible.bottom)).toBeLessThanOrEqual(90);
  const countBeforeDetach = await page.evaluate(() => (window as any).__viewportFixtureEvents.length);
  await page.locator(".artifactPreview--file").evaluate((element) => element.remove());
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__viewportFixtureEvents.length)).toBe(countBeforeDetach);
});

test("review dialog remains usable without horizontal overflow at 320 and 390 CSS pixels", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    if (width === 320) await mount(page);
    const { dialog } = await requestReview(page);
    const metrics = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add to chat" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
});
