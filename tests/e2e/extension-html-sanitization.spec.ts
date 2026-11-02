import { expect, test, type Page } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.addInitScript(() => {
    (window as typeof window & { extensionEventMarkers: string[] }).extensionEventMarkers = [];
  });
});

const contributionHtml = (sink: string, action: string) => `
  <style>
    .safe-${sink} {
      color: rgb(180, 190, 200);
      background-image:
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"),
        url("https://example.invalid/${sink}-background.svg");
    }
  </style>
  <form class="safe-${sink}" data-web-action="${action}" action="https://example.invalid/escape">
    <label>${sink} value <input name="value" value="${sink}-value" aria-label="${sink} value"${sink === "panel" ? " autofocus" : ""}></label>
    <button type="submit" data-web-action="${action}" data-web-payload='{"sink":"${sink}"}'>Run ${sink}</button>
  </form>
  <button type="button" class="${sink}-event-marker" onclick="window.extensionEventMarkers.push('${sink}')">Event marker</button>
  <a class="${sink}-active-url" href="javascript:window.extensionEventMarkers.push('${sink}-url')">Active URL</a>
  <a class="${sink}-named-target" href="https://example.invalid/named" target="extension-preview">Named target</a>
  <a class="${sink}-case-target" href="https://example.invalid/blank" target="_BLANK">Case target</a>
  <map name="${sink}-map"><area class="${sink}-area-target" href="https://example.invalid/area" target="extension-preview" alt="Area target"></map>
  <iframe class="${sink}-frame" srcdoc="<script>parent.extensionEventMarkers.push('${sink}-frame')</script>"></iframe>
  <svg class="${sink}-svg" viewBox="0 0 20 20" width="20" height="20" role="img" aria-label="${sink} icon">
    <circle cx="10" cy="10" r="8" fill="currentColor"></circle>
  </svg>
`;

async function openGitExtension(page: Page) {
  await page.locator("#gitButton").evaluate((button: HTMLButtonElement) => button.click());
  await page.locator(".gitExtensionTab", { hasText: "Security test" }).click();
}

test("sanitizes every privileged extension HTML sink without breaking contributions", async ({ page }, testInfo) => {
  const capture = async (name: string) => {
    const body = await page.screenshot({ path: testInfo.outputPath(`${name}-layout.png`) });
    await testInfo.attach(`${name}-layout`, { body, contentType: "image/png" });
  };
  await page.route("https://example.invalid/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
  }));
  await page.request.post("/api/mock/state", { data: {
    webContributions: [
      {
        version: 1,
        key: "security-footer",
        slot: "footer",
        kind: "static",
        view: { kind: "html", html: contributionHtml("footer", "footer-action") },
      },
      { version: 1, key: "security-panel", slot: "panel", kind: "rendered", title: "Security test", label: "Security test", icon: "shield" },
      { version: 1, key: "security-panel-launcher", slot: "fab", kind: "static", title: "Security test", label: "Security test", icon: "shield", opens: "security-panel" },
      { version: 1, key: "security-git", slot: "git-tab", kind: "rendered", title: "Security test", label: "Security test" },
      { version: 1, key: "security-system", slot: "system-info", kind: "rendered", title: "Security test", label: "Security test" },
    ],
  } });

  const invocations: Array<Record<string, any>> = [];
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    const sink = input.slot === "panel" ? "panel" : input.slot === "git-tab" ? "git" : "system";
    await route.fulfill({ json: {
      ok: true,
      title: "Security test",
      html: contributionHtml(sink, `${sink}-action`),
    } });
  });

  await page.goto("/");

  const assertSafeMarkup = async (root: ReturnType<Page["locator"]>, sink: string) => {
    await expect(root.locator(`.${sink}-svg circle`)).toHaveAttribute("r", "8");
    await expect(root.locator(`.${sink}-event-marker`)).not.toHaveAttribute("onclick");
    await expect(root.locator(`.${sink}-active-url`)).not.toHaveAttribute("href");
    await expect(root.locator(`.${sink}-frame`)).toHaveCount(0);
    await expect(root.locator("form")).not.toHaveAttribute("action");
    const stylesheet = root.locator("style");
    await expect.poll(() => stylesheet.textContent()).toContain("data:image/svg+xml");
    await expect.poll(() => stylesheet.textContent()).toContain(`https://example.invalid/${sink}-background.svg`);
    await expect.poll(() => root.locator("form").evaluate((form) => getComputedStyle(form).color))
      .toBe("rgb(180, 190, 200)");
    await expect(root.locator(`.${sink}-named-target`)).toHaveAttribute("rel", "noopener noreferrer");
    await expect(root.locator(`.${sink}-case-target`)).toHaveAttribute("rel", "noopener noreferrer");
    await expect(root.locator(`.${sink}-area-target`)).toHaveAttribute("rel", "noopener noreferrer");
    await root.locator(`.${sink}-event-marker`).click();
    expect(await page.evaluate(() => (window as typeof window & { extensionEventMarkers: string[] }).extensionEventMarkers)).toEqual([]);
  };

  const footer = page.locator("#extensionFooter");
  await assertSafeMarkup(footer, "footer");

  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Security test" }).click();
  const panel = page.locator("#webExtensionPanel");
  const panelInput = panel.getByRole("textbox", { name: "panel value" });
  await expect(panelInput).toHaveAttribute("autofocus", "");
  await expect(panelInput).toBeFocused();
  await assertSafeMarkup(panel, "panel");
  await panel.getByRole("button", { name: "Run panel" }).click();
  await expect.poll(() => invocations.some((input) =>
    input.slot === "panel"
    && input.event?.action === "panel-action"
    && input.event?.payload?.sink === "panel"
    && input.event?.fields?.value === "panel-value")).toBe(true);
  await capture("panel");
  await panel.getByRole("button", { name: "Close panel" }).click();

  await openGitExtension(page);
  const git = page.locator(".gitExtensionContent");
  await assertSafeMarkup(git, "git");
  await git.getByRole("button", { name: "Run git" }).click();
  await expect.poll(() => invocations.some((input) =>
    input.slot === "git-tab"
    && input.event?.action === "git-action"
    && input.event?.payload?.sink === "git")).toBe(true);
  await capture("git");

  await page.locator("#gitCloseButton").click();
  await openSessionDrawerFooterAction(page, "System");
  const system = page.locator(".systemInfoSection", { hasText: "Security test" });
  if (!await system.isVisible()) await page.locator("#settingsNavOverview").click();
  await assertSafeMarkup(system, "system");
  await system.getByRole("button", { name: "Run system" }).click();
  await expect.poll(() => invocations.some((input) =>
    input.slot === "system-info"
    && input.event?.action === "system-action"
    && input.event?.payload?.sink === "system"
    && input.event?.fields?.value === "system-value")).toBe(true);
  await capture("system");
});
