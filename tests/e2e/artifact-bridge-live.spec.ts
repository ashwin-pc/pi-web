import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, hashSecret, randomSecret } from "../../server/auth/kernel.js";
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from "./helpers/owned-stl-server.js";

test("real authenticated extension bridge replies, emits only to its tab, and closes on unmount", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(90_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), "pi-bridge-live-"));
  const workspace = join(dir, "workspace"), home = join(dir, "home"), agent = join(dir, "agent");
  const authPath = join(dir, "auth.json"), bootstrap = randomSecret();
  const sessionId = "01a1bd6d-6a86-771d-8269-9d31e911a96b";
  await mkdir(join(home, "extensions"), { recursive: true });
  await mkdir(join(workspace, ".pi/web/artifacts"), { recursive: true });
  await writeFile(join(workspace, ".pi/web/artifacts/notes.gcode"), "selected notes\n");
  // Normal SDK session, no prompt or provider invocation. This global loader is
  // trusted through the ordinary extension discovery path, not a production hook.
  await writeFile(join(home, "extensions/notes.ts"), `
    import type { PiWebExtensionAPI } from ${JSON.stringify(join(process.cwd(), "src/extensions.ts"))};
    import { artifactBridgePreview } from ${JSON.stringify(join(process.cwd(), "tests/fixtures/artifact-bridge-preview.ts"))};
    export default function (pi: PiWebExtensionAPI) {
      pi.on("session_start", (_event, ctx) => ctx.ui.web.contribute("live-notes", artifactBridgePreview));
    }
  `);
  const sessionDir = join(agent, "sessions", `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `2026-11-08T00-00-00-000Z_${sessionId}.jsonl`), JSON.stringify({
    type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: workspace,
  }) + "\n");
  await new AuthStore(authPath).update(state => {
    state.config = { policy: "authenticated", methods: [] };
    state.bootstrap = { hash: hashSecret(bootstrap), expiresAt: Date.now() + 120_000 };
  });
  const server = startOwnedStlServer({
    ...await isolatedStlEnv(dir), PI_WEB_HOME: home, PI_CODING_AGENT_DIR: agent,
    PI_WEB_AUTH_STORE: authPath, PI_WEB_AUTH_POLICY: "authenticated", PI_WEB_AUTH_ORIGIN: origin,
    PI_WEB_MOCK: "0", PI_WEB_CWD: workspace, PI_WEB_DEV: "0", NODE_ENV: "test",
    HOST: "127.0.0.1", PORT: String(port), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"),
    PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"),
  }, dir, 30_000);
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(() => {
    const Native = WebSocket;
    (window as any).__bridgeSockets = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); (window as any).__bridgeSockets.push(this); }
    };
  });
  const observe = (page: Page) => {
    const events: Record<string, unknown>[] = [];
    page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
      try { events.push(JSON.parse(String(payload))); } catch { /* non-JSON frames are irrelevant */ }
    }));
    return events;
  };
  try {
    await server.ready();
    expect((await fetch(origin + "/api/state")).status).toBe(401);
    const page = await context.newPage(), other = await context.newPage();
    const events = observe(page), otherEvents = observe(other);
    await bootstrapStlPage(page, origin, bootstrap, "isolated live bridge password");
    await expect(page.locator("#prompt")).toBeVisible();
    await page.goto(`${origin}/?sessionId=${sessionId}`);
    await other.goto(`${origin}/?sessionId=${sessionId}`);
    await expect(other.locator("#prompt")).toBeVisible();
    await expect.poll(() => otherEvents.some(event => event.type === "hello" && typeof event.artifactBridgeSocket === "string")).toBe(true);
    const invocations: Record<string, unknown>[] = [];
    let probes = 0, fullReads = 0;
    page.on("request", request => {
      if (request.url().endsWith("/api/web-contributions/invoke")) invocations.push(request.postDataJSON());
      if (request.url().endsWith("/notes.gcode")) {
        if (request.headers().range) probes++; else fullReads++;
      }
    });
    // Real artifact browser, no synthetic chat messages, route fulfillment, mock
    // endpoints, fake WebSocket transports, model calls, or token extraction.
    await page.getByRole("button", { name: "Open session actions" }).click();
    await page.getByRole("menuitem", { name: "File explorer" }).click();
    await page.locator("#filesArtifactsScope").click();
    await page.getByRole("button", { name: "Preview notes.gcode" }).click();
    const panel = page.locator("#artifactBrowserPreviewBody");
    const frame = panel.locator("iframe").contentFrame();
    await expect(frame.locator("#request")).toBeEnabled();
    await frame.locator("#request").click();
    await expect(frame.locator("#reply")).toHaveText("Reply completed");
    await expect(frame.locator("#event")).toHaveText("Asynchronous event after reply");
    expect(probes).toBe(1);
    expect(fullReads).toBe(0);
    const opened = invocations.find(body => (body.preview as Record<string, unknown> | undefined)?.operation === "open");
    expect(opened).toBeDefined();
    let preview = (opened!.preview as Record<string, unknown>).preview;
    await expect.poll(() => events.filter(event => event.type === "artifact_bridge_event" && event.preview === preview && event.event).length).toBe(1);
    // Give the second authenticated socket time to receive any erroneous broadcast.
    await other.waitForTimeout(250);
    expect(otherEvents.filter(event => event.type === "artifact_bridge_event")).toEqual([]);
    const element = panel.locator("iframe");
    await element.evaluate(element => { element.dataset.retained = "same-frame"; });
    await frame.locator("#draft").fill("Keep this browser-only draft");
    await frame.locator("#slow").click();
    await expect.poll(() => invocations.filter(body => (body.preview as any)?.command === "wait").length).toBe(1);
    await page.evaluate(() => (window as any).__bridgeSockets.at(-1).close());
    await expect.poll(() => invocations.filter(body => (body.preview as any)?.operation === "open").length).toBe(2);
    await expect(frame.locator("#connection")).toHaveText("ready");
    await expect(frame.locator("#draft")).toHaveValue("Keep this browser-only draft");
    await expect(element).toHaveAttribute("data-retained", "same-frame");
    expect(invocations.filter(body => (body.preview as any)?.command === "wait")).toHaveLength(1);
    await expect(frame.locator("#reply")).toContainText("outcome may be unknown");
    await frame.locator("#event").evaluate(element => { element.textContent = "Awaiting new event"; });
    await frame.locator("#request").click();
    await expect(frame.locator("#reply")).toHaveText("Reply completed");
    await expect(frame.locator("#event")).toHaveText("Asynchronous event after reply");
    const connectionIds = invocations.filter(body => (body.preview as any)?.operation === "open").map(body => (body.preview as any).preview);
    expect(new Set(connectionIds).size).toBe(2);
    // A changed source cannot be silently rebound on reconnect. Only explicit full
    // rendering/probing obtains fresh authority; the retained draft is left visible meanwhile.
    await writeFile(join(workspace, ".pi/web/artifacts/notes.gcode"), "changed selected source\n");
    await page.evaluate(() => (window as any).__bridgeSockets.at(-1).close());
    await expect(frame.locator("#connection")).toHaveText("reopen-required");
    await expect(frame.locator("#draft")).toHaveValue("Keep this browser-only draft");
    await panel.getByRole("button", { name: "Open again", exact: true }).click();
    await expect(panel.locator("iframe")).not.toHaveAttribute("data-retained", "same-frame");
    await expect(frame.locator("#connection")).toHaveText("ready");
    const last = invocations.filter(body => (body.preview as any)?.operation === "open").at(-1)!;
    preview = (last.preview as any).preview;
    const closing = page.waitForResponse(response => response.url().endsWith("/api/web-contributions/invoke")
      && response.request().postDataJSON()?.preview?.operation === "close");
    await page.locator("#artifactBrowserPreviewBack").click();
    expect((await closing).ok()).toBe(true);
    await expect.poll(() => events.some(event => event.type === "artifact_bridge_event" && event.preview === preview && event.closed === true)).toBe(true);
    await expect(panel.locator("iframe")).toHaveCount(0);
    // Use the app's ordinary browser fetch/auth flow, without extracting cookies,
    // CSRF material, or credentials into the test process.
    const stale = await page.evaluate(async ({ sessionId, preview }) => {
      const response = await fetch("/api/web-contributions/invoke", {
        method: "POST", headers: { "content-type": "application/json", "x-pi-web-client-id": "bridge-live-cleanup-check" },
        body: JSON.stringify({ sessionId, slot: "artifact-preview", key: "live-notes", preview: { operation: "request", preview, id: "after_close", command: "echo" } }),
      });
      return { status: response.status, body: await response.json() };
    }, { sessionId, preview });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ ok: false, error: "Preview connection unavailable" });
    expect(otherEvents.filter(event => event.type === "artifact_bridge_event")).toEqual([]);
  } finally {
    try { await context.close(); } finally { await server.close(); }
  }
});
