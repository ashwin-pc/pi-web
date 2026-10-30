import { expect, test } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const trustedUser = "owner@example.test";

test("authenticated transcript image previews stay same-origin", async ({ page, baseURL }) => {
  const externalRequests: string[] = [];
  const authenticatedPreviewRequests: string[] = [];
  const origin = new URL(baseURL!).origin;
  const attachments = [
    ["malicious absolute", "https://absolute.invalid/image.png"],
    ["malicious protocol relative", "//protocol-relative.invalid/image.png"],
    ["malicious backslash", "/\\backslash.invalid/image.png"],
    ["malformed", "http://[::1"],
    ["same-origin relative", "/api/test-images/relative.png"],
    ["same-origin absolute", `${origin}/api/test-images/absolute.png`],
    ["same-origin redirect", "/api/test-images/redirect.png"],
  ];

  for (const host of ["absolute.invalid", "protocol-relative.invalid", "backslash.invalid", "redirect.invalid"]) {
    await page.route(`**://${host}/**`, async (route) => {
      externalRequests.push(route.request().url());
      await route.abort();
    });
  }
  await page.route("**/api/test-images/**", async (route) => {
    const request = route.request();
    expect(request.headers()["x-test-user"]).toBe(trustedUser);
    authenticatedPreviewRequests.push(new URL(request.url()).pathname);
    if (request.url().endsWith("/redirect.png")) {
      await route.fulfill({ status: 302, headers: { location: "https://redirect.invalid/image.png" } });
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route("**/api/messages?*", async (route) => {
    await route.fulfill({
      json: {
        messages: attachments.map(([text, imageUrl], index) => ({
          role: "user",
          text,
          entryId: `image-${index}`,
          raw: { content: [{ type: "text", text }, { type: "image", mimeType: "image/png", imageUrl }] },
        })),
      },
    });
  });

  await page.goto("/");

  await expect(page.locator(".message.user", { hasText: "same-origin relative" }).locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".message.user", { hasText: "same-origin absolute" }).locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".message.user", { hasText: "same-origin redirect" }).locator(".messageAttachmentPreview")).toHaveClass(/missing/);
  await expect.poll(() => authenticatedPreviewRequests.sort()).toEqual([
    "/api/test-images/absolute.png",
    "/api/test-images/redirect.png",
    "/api/test-images/relative.png",
  ]);
  expect(externalRequests).toEqual([]);
});

test("authenticated tool-result image previews stay same-origin", async ({ page }) => {
  const externalRequests: string[] = [];
  const authenticatedPreviewRequests: string[] = [];

  for (const host of ["tool-protocol-relative.invalid", "tool-backslash.invalid"]) {
    await page.route(`**://${host}/**`, async (route) => {
      externalRequests.push(route.request().url());
      await route.abort();
    });
  }
  await page.route("**/api/test-images/tool-same-origin.png", async (route) => {
    expect(route.request().headers()["x-test-user"]).toBe(trustedUser);
    authenticatedPreviewRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route("**/api/messages?*", async (route) => {
    await route.fulfill({
      json: {
        messages: [{
          role: "toolResult",
          toolName: "read",
          text: "tool image authentication",
          entryId: "tool-image-auth",
          raw: {
            content: [
              { type: "text", text: "tool image authentication" },
              { type: "image", name: "protocol relative", url: "//tool-protocol-relative.invalid/image.png" },
              { type: "image", name: "backslash normalized", url: "/\\tool-backslash.invalid/image.png" },
              { type: "image", name: "same origin", url: "/api/test-images/tool-same-origin.png" },
            ],
          },
        }],
      },
    });
  });

  await page.goto("/");

  const card = page.locator('.toolCard[data-tool-name="read"]');
  await expect(card).toHaveCount(1);
  // Compact and minimal density defer images behind visible tool controls.
  const summary = page.getByRole("button", { name: "Show 1 tool", exact: true });
  if (await summary.isVisible()) await summary.click();
  await expect(card).toBeVisible();
  const details = card.locator(".toolCardExpandToggle");
  if (await details.isVisible() && await details.getAttribute("aria-expanded") === "false") await details.click();

  const images = card.locator(".toolCardImage img");
  await expect(images).toHaveCount(3);
  await expect(images.nth(0)).toHaveAttribute("alt", "protocol relative (failed to load)");
  await expect(images.nth(1)).toHaveAttribute("alt", "backslash normalized (failed to load)");
  await expect(images.nth(2)).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => authenticatedPreviewRequests).toEqual(["/api/test-images/tool-same-origin.png"]);
  expect(externalRequests).toEqual([]);
});
