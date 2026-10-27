import { expect, test } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("remote markdown images stay inert until consent, then load without requiring CORS", async ({ context, page }, testInfo) => {
  let remoteRequests = 0;
  let remoteHeaders: Record<string, string> = {};
  await context.addCookies([{
    name: "private-session",
    value: "must-not-leak",
    domain: "images.example.test",
    path: "/",
    secure: true,
    sameSite: "None",
  }]);
  await page.route("https://images.example.test/**", (route) => {
    remoteRequests += 1;
    remoteHeaders = route.request().headers();
    return route.fulfill({
      body: png,
      contentType: "image/png",
    });
  });
  await page.route(/\/api\/(?:artifacts|session-artifacts|attachments|messages\/image)/, (route) => route.fulfill({
    body: png,
    contentType: "image/png",
  }));
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: [
        "Trusted local images:",
        "![artifact](/api/artifacts/chart.png)",
        "![session artifact](/api/session-artifacts/session/chart.png)",
        "![attachment](/api/attachments/file/name.png)",
        "![transcript](/api/messages/image?imageId=1.2.digest)",
        "![inline](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=)",
        "Remote:",
        "![remote report](https://images.example.test/private.png)",
        "![protocol relative](//images.example.test/bypass.png)",
        "![backslash](https:\\\\images.example.test\\\\bypass.png)",
      ].join("\n\n"),
    }],
  } }));

  await page.goto("/");
  const message = page.locator(".message.assistant");
  await expect(message.locator("img")).toHaveCount(5);
  const blocked = message.getByRole("group", { name: "Remote image blocked" });
  await expect(blocked).toContainText("images.example.test");
  await expect(blocked.getByRole("button", { name: "Load image" })).toBeVisible();
  await expect(message.getByAltText("protocol relative")).toHaveCount(0);
  await expect(message.getByAltText("backslash")).toHaveCount(0);
  expect(remoteRequests).toBe(0);
  await testInfo.attach("image-consent", { body: await page.screenshot({ path: testInfo.outputPath("image-consent.png") }), contentType: "image/png" });

  await blocked.getByRole("button", { name: "Load image" }).click();
  await expect(message.getByAltText("remote report")).toBeVisible();
  await expect(message.getByAltText("remote report")).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(message.getByAltText("remote report")).not.toHaveAttribute("crossorigin", /.*/);
  await expect.poll(() => remoteRequests).toBe(1);
  expect(remoteHeaders.authorization).toBeUndefined();
  expect(remoteHeaders.cookie).toContain("private-session=must-not-leak");
  expect(remoteHeaders.referer).toBeUndefined();
});

test("HTML preview source is visible and scripts mount only after Run preview", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "Preview:\n\n```html-preview\n<span id=\"ran\">x</span><script>document.querySelector('#ran').textContent='ok'</script>\n```",
    }],
  } }));

  const preview = page.locator(".message.assistant .htmlPreview");
  const expectChromeInsidePreview = async (contentSelector: string) => {
    const layout = await preview.evaluate((element, selector) => {
      const previewRect = element.getBoundingClientRect();
      const contentRect = element.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      const buttonRects = Array.from(element.querySelectorAll<HTMLElement>(".htmlPreviewActions button:not([hidden])"))
        .map((button) => button.getBoundingClientRect());
      return {
        preview: { left: previewRect.left, right: previewRect.right },
        contentTop: contentRect?.top,
        buttons: buttonRects.map((rect) => ({
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          height: rect.height,
        })),
      };
    }, contentSelector);
    expect(layout.buttons.length).toBeGreaterThan(0);
    for (const button of layout.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(layout.preview.left - 1);
      expect(button.right).toBeLessThanOrEqual(layout.preview.right + 1);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.bottom).toBeLessThanOrEqual((layout.contentTop ?? 0) + 1);
    }
  };

  await page.goto("/");
  await expect(preview.locator("pre code.language-html")).toBeVisible();
  await expect(preview.locator("iframe")).toHaveCount(0);
  await expectChromeInsidePreview(":scope > pre");
  await testInfo.attach("preview-before-consent", { body: await page.screenshot({ path: testInfo.outputPath("preview-before-consent.png") }), contentType: "image/png" });
  await preview.getByRole("button", { name: "Run preview" }).click();
  const frame = preview.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame.contentFrame().locator("#ran")).toHaveText("ok");
  await expect(preview.locator(".htmlPreviewNotice")).toContainText("HTML preview is active");
  await expect(preview).not.toHaveClass(/htmlPreview--unarmed/);
  await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(239);
  await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(300);
  await expectChromeInsidePreview(".htmlPreviewFrame");
  await testInfo.attach("preview-after-consent", { body: await page.screenshot({ path: testInfo.outputPath("preview-after-consent.png") }), contentType: "image/png" });
  await preview.getByRole("button", { name: "Show HTML source" }).click();
  await expect(preview.locator("pre code.language-html")).toBeVisible();
  await expect(frame).toBeHidden();
  await expect(preview.locator(".htmlPreviewNotice")).toContainText("HTML preview is active");
  await expectChromeInsidePreview(":scope > pre");
  await preview.getByRole("button", { name: "Show interactive preview" }).click();
  await expect(preview.locator("pre code.language-html")).toBeHidden();
  await expect(frame).toBeVisible();
  await expect(frame.contentFrame().locator("#ran")).toHaveText("ok");
  await expect(preview.locator(".htmlPreviewNotice")).toContainText("HTML preview is active");
  await preview.getByRole("button", { name: "Stop preview" }).click();
  await expect(preview.locator("iframe")).toHaveCount(0);
  await expect(preview.locator("pre code.language-html")).toBeVisible();
  await expect(preview.locator(".htmlPreviewToggle")).toBeHidden();
  await expect(preview.getByRole("button", { name: "Run preview" })).toBeVisible();
  await expect(preview.locator(".htmlPreviewNotice")).toContainText("HTML preview is inactive");
  await expect(preview).toHaveClass(/htmlPreview--source/);
  await expect(preview).toHaveClass(/htmlPreview--unarmed/);

  await preview.getByRole("button", { name: "Run preview" }).click();
  const restartedFrame = preview.locator("iframe");
  await expect(restartedFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(restartedFrame.contentFrame().locator("#ran")).toHaveText("ok");
});
