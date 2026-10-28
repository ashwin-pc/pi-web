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
  let destinationRequests = 0;
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
  await page.route("https://destination.example.test/**", (route) => {
    destinationRequests += 1;
    return route.fulfill({ body: "unexpected navigation", contentType: "text/plain" });
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
        "[![remote report](https://images.example.test/private.png)](https://destination.example.test/report)",
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
  expect(destinationRequests).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(message.getByAltText("remote report")).toBeVisible();
  await expect(message.getByAltText("remote report")).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(message.getByAltText("remote report")).not.toHaveAttribute("crossorigin", /.*/);
  await expect.poll(() => remoteRequests).toBe(1);
  expect(remoteHeaders.authorization).toBeUndefined();
  expect(remoteHeaders.cookie).toContain("private-session=must-not-leak");
  expect(remoteHeaders.referer).toBeUndefined();
});

test("HTML preview source is visible and scripts mount only after Run preview", async ({ page }, testInfo) => {
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
  await expect(preview.locator(".htmlPreviewStatus")).toContainText("Running");
  await expect(preview).not.toHaveClass(/htmlPreview--unarmed/);
  await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(239);
  await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(300);
  await expectChromeInsidePreview(".htmlPreviewFrame");
  await testInfo.attach("preview-after-consent", { body: await page.screenshot({ path: testInfo.outputPath("preview-after-consent.png") }), contentType: "image/png" });
  await preview.getByRole("button", { name: "Show HTML source" }).click();
  await expect(preview.locator("pre code.language-html")).toBeVisible();
  await expect(frame).toBeHidden();
  await expect(preview.locator(".htmlPreviewStatus")).toContainText("Running");
  await expectChromeInsidePreview(":scope > pre");
  await preview.getByRole("button", { name: "Show interactive preview" }).click();
  await expect(preview.locator("pre code.language-html")).toBeHidden();
  await expect(frame).toBeVisible();
  await expect(frame.contentFrame().locator("#ran")).toHaveText("ok");
  await expect(preview.locator(".htmlPreviewStatus")).toContainText("Running");
  await preview.getByRole("button", { name: "Stop preview" }).click();
  await expect(preview.locator("iframe")).toHaveCount(0);
  await expect(preview.locator("pre code.language-html")).toBeVisible();
  await expect(preview.locator(".htmlPreviewToggle")).toBeHidden();
  await expect(preview.getByRole("button", { name: "Run preview" })).toBeVisible();
  await expect(preview.locator(".htmlPreviewStatus")).toContainText("Inactive");
  await expect(preview).toHaveClass(/htmlPreview--source/);
  await expect(preview).toHaveClass(/htmlPreview--unarmed/);

  await preview.getByRole("button", { name: "Run preview" }).click();
  const restartedFrame = preview.locator("iframe");
  await expect(restartedFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(restartedFrame.contentFrame().locator("#ran")).toHaveText("ok");
});

test("linked and custom HTML artifacts stay inert until their shared preview consent", async ({ page }, testInfo) => {
  let linkedMarkers = 0;
  let customMarkers = 0;
  let customRenders = 0;
  const tallBody = Array.from({ length: 24 }, (_, index) => `<p>Preview row ${index + 1}</p>`).join("");
  const linkedHtml = `<!doctype html><p id="linked-status">waiting</p>${tallBody}<img src="https://markers.example.test/linked"><script>document.querySelector("#linked-status").textContent="linked ran"</script>`;
  const customHtml = `<!doctype html><p id="custom-status">waiting</p>${tallBody}<img src="https://markers.example.test/custom"><script>document.querySelector("#custom-status").textContent="custom ran"</script>`;
  await page.route("https://markers.example.test/**", (route) => {
    if (route.request().url().endsWith("/linked")) linkedMarkers += 1;
    if (route.request().url().endsWith("/custom")) customMarkers += 1;
    return route.fulfill({ body: png, contentType: "image/png" });
  });
  await page.route("**/api/artifacts/consent.html", (route) => route.fulfill({ body: linkedHtml, contentType: "text/html" }));
  await page.route("**/api/web-contributions/invoke", (route) => {
    customRenders += 1;
    return route.fulfill({ json: { ok: true, html: customHtml } });
  });
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: `<div class="previewScrollContext">${"Maintained preview context. ".repeat(160)}</div>\n\n[Linked HTML](/api/artifacts/consent.html)\n\n[Custom HTML](/api/artifacts/consent.gcode)`,
    }],
  } }));
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{
      version: 1,
      key: "consent-preview",
      slot: "artifact-preview",
      kind: "rendered",
      title: "Consent preview",
      match: { kinds: ["file"], extensions: [".gcode"] },
    }],
  } });

  await page.goto("/");
  const messages = page.locator(".messages");
  const composer = page.locator(".composer");
  const scrollContext = page.locator(".previewScrollContext");
  const messagesViewportHeight = await messages.evaluate((element) => element.clientHeight);
  await scrollContext.evaluate((element, viewportHeight) => {
    element.style.height = `${Math.ceil(viewportHeight * 2)}px`;
    element.style.overflow = "hidden";
  }, messagesViewportHeight);
  const linked = page.locator('.artifactPreview[data-artifact-name="consent.html"]');
  const custom = page.locator('.artifactPreview[data-artifact-name="consent.gcode"]');
  await expect(linked.getByRole("button", { name: "Run preview" })).toBeVisible();
  await expect(custom.getByRole("button", { name: "Run preview" })).toBeVisible();
  await expect(linked.locator("iframe")).toHaveCount(0);
  await expect(custom.locator("iframe")).toHaveCount(0);
  await expect(linked.locator(".htmlPreviewPlaceholder")).toContainText("inactive");
  await expect(custom.locator(".htmlPreviewPlaceholder")).toContainText("inactive");
  expect(customRenders).toBe(1);
  expect(linkedMarkers).toBe(0);
  expect(customMarkers).toBe(0);
  await testInfo.attach("artifact-consent", { body: await page.screenshot({ path: testInfo.outputPath("artifact-consent.png") }), contentType: "image/png" });

  await linked.getByRole("button", { name: "Run preview" }).click();
  const linkedFrame = linked.locator("iframe");
  const assistant = linked.locator("xpath=ancestor::div[contains(@class,'message') and contains(@class,'assistant')]");
  const responseToggle = assistant.locator(":scope > .messageToggle");
  await expect(assistant).not.toHaveClass(/collapsed/);
  await expect(responseToggle).toBeEnabled();
  await expect(linkedFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(linkedFrame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(linkedFrame.contentFrame().locator("#linked-status")).toHaveText("linked ran");
  await expect.poll(() => linkedMarkers).toBe(1);
  expect(customMarkers).toBe(0);
  await expect(custom.locator("iframe")).toHaveCount(0);
  await linkedFrame.contentFrame().locator("#linked-status").evaluate((element) => {
    element.textContent = "state preserved";
  });
  await responseToggle.click();
  await expect(assistant).toHaveClass(/collapsed/);
  await expect(linkedFrame).toHaveCount(1);
  await expect(responseToggle).toBeVisible();
  await expect(responseToggle).toHaveText("Show more");
  await testInfo.attach("artifact-collapsed", { body: await page.screenshot({ path: testInfo.outputPath("artifact-collapsed.png") }), contentType: "image/png" });
  await responseToggle.click();
  await expect(assistant).not.toHaveClass(/collapsed/);
  await expect(linkedFrame).toHaveCount(1);
  await expect(linkedFrame.contentFrame().locator("#linked-status")).toHaveText("state preserved");

  await page.locator("#prompt").fill("Keep this draft while reviewing the running preview.");
  await linked.evaluate((element) => {
    const scroller = element.closest<HTMLElement>(".messages")!;
    const scrollerRect = scroller.getBoundingClientRect();
    const previewRect = element.getBoundingClientRect();
    const clearance = scrollerRect.height / 2;
    const previewGap = previewRect.top - scrollerRect.bottom;
    scroller.scrollTo({ top: scroller.scrollTop + previewGap - clearance });
  });
  await expect.poll(() => linked.evaluate((element) => {
    const preview = element.getBoundingClientRect();
    const scroller = element.closest<HTMLElement>(".messages")!.getBoundingClientRect();
    return preview.top - scroller.bottom;
  })).toBeGreaterThan(0);
  const offscreenGeometry = await linked.evaluate((element) => {
    const preview = element.getBoundingClientRect();
    const scroller = element.closest<HTMLElement>(".messages")!.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(preview.bottom, scroller.bottom) - Math.max(preview.top, scroller.top));
    return {
      overlap,
      previewTop: preview.top,
      previewBottom: preview.bottom,
      scrollerBottom: scroller.bottom,
    };
  });
  expect(offscreenGeometry.overlap).toBe(0);
  expect(offscreenGeometry.previewTop).toBeGreaterThan(offscreenGeometry.scrollerBottom);
  expect(offscreenGeometry.previewBottom).toBeGreaterThan(offscreenGeometry.scrollerBottom);
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest message" });
  await expect(jumpToLatest).toBeVisible();
  const launcherToggle = page.locator(".actionLauncherToggle");
  await launcherToggle.click();
  await expect(page.locator(".actionLauncher")).toHaveClass(/open/);
  await expect(jumpToLatest).toBeVisible();
  await expect(linkedFrame.contentFrame().locator("#linked-status")).toHaveText("state preserved");
  await launcherToggle.click();
  await expect(page.locator(".actionLauncher")).not.toHaveClass(/open/);
  await expect(page.locator("#actionLauncherMenu")).toBeHidden();
  await expect(jumpToLatest).toBeVisible();
  const jumpBox = await jumpToLatest.boundingBox();
  const chatBox = await page.locator(".app").boundingBox();
  expect(jumpBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(jumpBox!.x + jumpBox!.width / 2).toBeCloseTo(chatBox!.x + chatBox!.width / 2, 1);
  await testInfo.attach("artifact-navigation", { body: await page.screenshot({ path: testInfo.outputPath("artifact-navigation.png") }), contentType: "image/png" });

  if ((page.viewportSize()?.width || 0) >= 701) {
    await page.locator("#sessionButton").click();
    const drawer = page.locator("#sessionDrawer");
    await expect(drawer).toBeVisible();
    const pushedJumpBox = await jumpToLatest.boundingBox();
    const pushedChatBox = await page.locator(".app").boundingBox();
    const drawerBox = await drawer.boundingBox();
    expect(pushedJumpBox).not.toBeNull();
    expect(pushedChatBox).not.toBeNull();
    expect(drawerBox).not.toBeNull();
    // appLayout uses a full-screen modal below 1025px, including fold screens.
    // Only docked drawers leave the chat available for interaction.
    if (drawerBox!.width < page.viewportSize()!.width - 1) {
      expect(pushedJumpBox!.x).toBeGreaterThanOrEqual(drawerBox!.x + drawerBox!.width);
      expect(pushedJumpBox!.x + pushedJumpBox!.width / 2).toBeCloseTo(pushedChatBox!.x + pushedChatBox!.width / 2, 1);
      await jumpToLatest.click();
      await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48);
      await drawer.getByRole("button", { name: "Close sessions" }).click();
    } else {
      expect(drawerBox!.width).toBeCloseTo(page.viewportSize()!.width, 1);
      await drawer.getByRole("button", { name: "Close sessions" }).click();
      await expect(jumpToLatest).toBeVisible();
      await jumpToLatest.click();
      await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48);
    }
    await expect(drawer).toBeHidden();
  } else {
    await jumpToLatest.click();
    await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48);
  }
  await expect(linkedFrame.contentFrame().locator("#linked-status")).toHaveText("state preserved");

  const expectActiveControlsReachable = async (preview: typeof linked) => {
    const geometry = await preview.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".messages")!.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll<HTMLButtonElement>(".htmlPreviewActions button:not([hidden])"))
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        });
      return {
        scroller: { top: scroller.top, bottom: scroller.bottom, left: scroller.left, right: scroller.right },
        composerTop: composer.top,
        controls,
      };
    });
    expect(geometry.controls.map((control) => control.label)).toEqual(["Stop preview", "Source"]);
    for (const control of geometry.controls) {
      expect(control.top, `${control.label} top`).toBeGreaterThanOrEqual(geometry.scroller.top - 1);
      expect(control.bottom, `${control.label} scroller bottom`).toBeLessThanOrEqual(geometry.scroller.bottom + 1);
      expect(control.bottom, `${control.label} composer coverage`).toBeLessThanOrEqual(geometry.composerTop + 1);
      expect(control.left, `${control.label} left`).toBeGreaterThanOrEqual(geometry.scroller.left - 1);
      expect(control.right, `${control.label} right`).toBeLessThanOrEqual(geometry.scroller.right + 1);
    }
  };
  await linkedFrame.hover();
  await expectActiveControlsReachable(linked);
  await linked.getByRole("button", { name: "Show HTML source" }).click();
  await expect(linked.locator("pre code")).toContainText("linked-status");
  await linked.getByRole("button", { name: "Show interactive preview" }).click();
  await linked.getByRole("button", { name: "Stop preview" }).click();
  await expect(linkedFrame).toHaveCount(0);
  await expect(responseToggle).toBeEnabled();
  await linked.getByRole("button", { name: "Run preview" }).click();
  await expect(linked.locator("iframe").contentFrame().locator("#linked-status")).toHaveText("linked ran");

  await custom.getByRole("button", { name: "Show HTML source" }).click();
  await expect(custom.locator("pre code")).toContainText("custom-status");
  expect(customMarkers).toBe(0);
  await custom.getByRole("button", { name: "Run preview" }).click();
  const customFrame = custom.locator("iframe");
  await expect(customFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(customFrame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(customFrame.contentFrame().locator("#custom-status")).toHaveText("custom ran");
  await expect.poll(() => customMarkers).toBe(1);
  await customFrame.hover();
  await expectActiveControlsReachable(custom);
  await custom.getByRole("button", { name: "Show HTML source" }).click();
  await custom.getByRole("button", { name: "Show interactive preview" }).click();
  await custom.getByRole("button", { name: "Stop preview" }).click();
  await expect(customFrame).toHaveCount(0);
  await custom.getByRole("button", { name: "Run preview" }).click();
  await expect(custom.locator("iframe").contentFrame().locator("#custom-status")).toHaveText("custom ran");
  await expect(messages).toBeVisible();
  await expect(composer).toBeVisible();
  await testInfo.attach("artifact-running", { body: await page.screenshot({ path: testInfo.outputPath("artifact-running.png") }), contentType: "image/png" });
});
