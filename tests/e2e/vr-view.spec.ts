import { expect, test, type Page } from "@playwright/test";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// The VR view (/view/vr, issue #181) in mock server mode: the City scene on a
// real canvas, driven by the client state layer over the mock sessions.

type VrWindow = Window & { __vrCity?: any };
const since = () => new Date().toISOString();

async function pinBoth(page: Page) {
  await seedSessionUiState(page, { lanes: [
    { sessionId: "mock-current", lane: "pinned", since: since() },
    { sessionId: "mock-older", lane: "pinned", since: since() },
  ] });
}

async function openVr(page: Page) {
  await page.goto("/view/vr");
  await page.waitForFunction(() => ((window as VrWindow).__vrCity?.frames || 0) > 5, null, { timeout: 25_000 });
}

const vr = <T>(page: Page, fn: (city: any) => T) => page.evaluate(fn as any, undefined) as Promise<T>;
const agentEvent = (page: Page, sessionId: string, event: Record<string, unknown>) =>
  page.request.post("/api/mock/event", { data: { type: "agent_event", sessionId, event } });

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("VR view", () => {
  test.describe.configure({ timeout: 60_000 });

  test("loads at /view/vr, renders a canvas and shows the pinned sessions as avatars", async ({ page }) => {
    await pinBoth(page);
    await openVr(page);
    await expect(page.locator("#rootView[data-view='vr'] canvas#scene")).toBeVisible();
    await expect(page.locator("main.app")).toBeHidden();
    await expect(page.locator("#enterVR")).toBeVisible();
    await expect(page.locator("#vrBack")).toHaveAttribute("href", "/");
    const state = await page.evaluate(() => (window as VrWindow).__vrCity.state());
    expect(state.pinned).toEqual(["mock-current", "mock-older"]);
    const regions: string[] = await page.evaluate(() => (window as VrWindow).__vrCity.allRegions());
    expect(regions).toEqual(expect.arrayContaining(["avatar:mock-current", "avatar:mock-older"]));
    // The city is the real workspace tree, walked through /api/files/tree.
    const files = await page.evaluate(() => (window as VrWindow).__vrCity.cityFiles());
    expect(files.files).toBeGreaterThan(50);
    // Without a headset, Enter VR explains itself and the desktop preview stays usable.
    await expect(page.locator("#xrMsg")).toContainText(/headset|WebXR|HTTPS/);
  });

  test("opening a session from the bar shows its messages in the reader", async ({ page }) => {
    await pinBoth(page);
    await openVr(page);
    const point = await page.evaluate(() => (window as VrWindow).__vrCity.project("avatar:mock-older"));
    expect(point?.visible).toBe(true);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => { const s = (window as VrWindow).__vrCity.state(); return s.reading && s.readerSid === "mock-older"; });
    const messages = await page.evaluate(() => (window as VrWindow).__vrCity.messages("mock-older"));
    expect(messages.map((m: { type: string; text: string }) => [m.type, m.text])).toEqual([
      ["user", "Review the mobile composer layout"],
      ["assistant", "Resumed older session."],
    ]);
    expect(await page.evaluate(() => (window as VrWindow).__vrCity.header()?.title)).toBe("Older mock session");
  });

  test("a streaming turn appears in the reader, with a beam on the file its tool reads", async ({ page }) => {
    await pinBoth(page);
    await openVr(page);
    await page.evaluate(() => (window as VrWindow).__vrCity.open("mock-older"));
    await agentEvent(page, "mock-older", { type: "agent_start", startedAt: since() });
    await agentEvent(page, "mock-older", { type: "tool_execution_start", toolCallId: "vr-1", toolName: "read", args: { path: "src/main.ts" } });
    await expect.poll(() => vr(page, () => (window as VrWindow).__vrCity.state().indicators["mock-older"])).toBe("running");
    await expect.poll(async () => (await vr(page, () => (window as VrWindow).__vrCity.beams())).find((beam: { id: string }) => beam.id === "mock-older")?.building || "")
      .toMatch(/\/src\/main\.ts$/);
    await agentEvent(page, "mock-older", { type: "tool_execution_end", toolCallId: "vr-1", toolName: "read", isError: false, result: "ok" });
    for (const delta of ["Streaming ", "into the ", "VR reader."]) {
      await agentEvent(page, "mock-older", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    }
    await expect.poll(async () => {
      const messages = await vr(page, () => (window as VrWindow).__vrCity.messages("mock-older"));
      return messages.map((m: { type: string; name?: string; text: string; streaming: boolean }) => `${m.type}:${m.name || ""}:${m.streaming ? "live" : ""}:${m.text}`);
    }).toEqual([
      "user:::Review the mobile composer layout",
      "assistant:::Resumed older session.",
      "tool:read::",
      "assistant::live:Streaming into the VR reader.",
    ]);
    await agentEvent(page, "mock-older", { type: "agent_end", willRetry: false, aborted: false });
    await agentEvent(page, "mock-older", { type: "agent_settled" });
    await expect.poll(() => vr(page, () => (window as VrWindow).__vrCity.state().indicators["mock-older"])).toBe("current");
  });

  test("the normal app is unaffected: no VR chunks, the client layer stays unloaded", async ({ page }) => {
    const scripts: string[] = [];
    page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
    await page.goto("/");
    await expect(page.locator(".message.assistant").first()).toBeVisible();
    await expect(page.locator("main.app")).toBeVisible();
    await expect(page.locator("#rootView")).toHaveCount(0);
    // The header's VR button exists but only appears where immersive VR is supported.
    await expect(page.locator("#openVrViewButton")).toBeHidden();
    expect(scripts.filter((path) => /\/(vrApp|main|client)-[\w-]+\.js$/.test(path))).toEqual([]);
  });

  test("an unknown view falls back to the normal app", async ({ page }) => {
    await page.goto("/view/nope");
    await expect(page.locator(".message.assistant").first()).toBeVisible();
    await expect(page.locator("#rootView")).toHaveCount(0);
  });
});
