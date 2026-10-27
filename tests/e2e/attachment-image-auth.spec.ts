import { expect, test } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const token = "synthetic-attachment-token";

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
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
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

  await page.goto(`/?token=${token}`);

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
