import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, hashSecret, randomSecret } from "../../server/auth/kernel.js";
import { ArtifactDerivations } from "../../server/extensions/artifactDerived.js";
import { ArtifactBridges } from "../../server/extensions/artifactBridge.js";
import { artifactBridgePreview } from "../fixtures/artifact-bridge-preview.js";
import { bootstrapStlPage, isolatedStlEnv, reserveStlOrigin, startOwnedStlServer } from "./helpers/owned-stl-server.js";

// Authenticated isolated app + real bridge registry; contribution transport is fixture-routed
// because the mock agent intentionally does not load arbitrary local extensions.
for (const bytes of [false, true]) test(`extension-rendered HTML receives post-reply live events (${bytes ? 'with bytes' : 'bridge only'})`, async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop"); test.setTimeout(90_000);
  const { port, origin } = await reserveStlOrigin();
  const dir = await mkdtemp(join(tmpdir(), "pi-artifact-bridge-"));
  const authPath = join(dir, "auth.json"), bootstrap = randomSecret();
  await new AuthStore(authPath).update(state => { state.config = { policy: "authenticated", methods: [] }; state.bootstrap = { hash: hashSecret(bootstrap), expiresAt: Date.now() + 120_000 }; });
  const server = startOwnedStlServer({ ...await isolatedStlEnv(dir), PI_WEB_AUTH_STORE: authPath, PI_WEB_AUTH_POLICY: "authenticated", PI_WEB_AUTH_ORIGIN: origin, PI_WEB_MOCK: "1", PI_WEB_CWD: process.cwd(), PI_WEB_DEV: "0", NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json") }, dir, 30_000);
  const context = await browser.newContext({ serviceWorkers: "block" });
  const selections = new ArtifactDerivations();
  const source = join(dir, "notes.gcode"); await writeFile(source, "notes");
  const selection = selections.select({ sessionId: "mock-current", key: "notes", registration: "fixture", bridge: true, derived: false, artifact: { name: "notes.gcode", path: "/api/artifacts/e2e-toolpath.gcode", kind: "file" }, url: "/selected" });
  let deliver: (event: unknown) => void = () => {};
  let previewId = "";
  const registry = new ArtifactBridges(selections, (socket, owner) => socket === "fixture-socket" && owner === "owner" ? { send: event => { deliver(event); return true; }, onClose: () => () => {} } : undefined,
    (_session, selected, options) => artifactBridgePreview.connect!(selected.artifact as never, options));
  try {
    await server.ready();
    expect((await fetch(origin + "/api/state")).status).toBe(401);
    const page = await context.newPage();
    await page.routeWebSocket("**/ws?*", ws => {
      const upstream = ws.connectToServer();
      upstream.onMessage(message => {
        const data = JSON.parse(String(message));
        if (data.type === "hello") data.artifactBridgeSocket = "fixture-socket";
        ws.send(JSON.stringify(data));
      });
      deliver = event => ws.send(JSON.stringify(event));
    });
    await bootstrapStlPage(page, origin, bootstrap, "isolated bridge test password");
    await expect(page.locator("#prompt")).toBeVisible();
    await page.request.post(origin + "/api/mock/state", { headers: { "x-pi-web-test-client-intent": "playwright-test" }, data: { webContributions: [{ version: 1, key: "notes", slot: "artifact-preview", kind: "rendered", title: "Notes bridge", match: { extensions: [".gcode"] } }] } });
    await page.route("**/api/web-contributions/invoke", async route => {
      const body = route.request().postDataJSON();
      if (!body.preview) { await route.fulfill({ json: { ok: true, ...await artifactBridgePreview.render(), ...(bytes ? { artifactBytes: true } : {}), selection } }); return; }
      try {
        const result = await registry.invoke("owner", body.sessionId, body.key, body.preview, new AbortController().signal);
        if (body.preview.operation === "open") previewId = String((result as { preview: string }).preview);
        await route.fulfill({ json: { ok: true, ...result } });
      } catch { await route.fulfill({ status: 422, json: { ok: false, error: "Fixture request failed" } }); }
    });
    let probes = 0, fullReads = 0;
    await page.route("**/api/session-artifacts/mock-current/e2e-toolpath.gcode", async route => {
      if (route.request().headers().range) {
        probes++; selections.bind(selection, "mock-current", "/selected", source);
        // Byte streams attach their frame after probing. Exercise a delayed attachment.
        if (bytes && probes === 1) await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ status: 206, headers: { "content-range": "bytes 0-0/5" }, body: "n" });
      } else { fullReads++; if (bytes) await route.fulfill({ headers: { 'content-length': '5' }, body: 'notes' }); else await route.abort(); }
    });
    await page.reload(); await expect(page.locator("#prompt")).toBeVisible();
    await page.locator("#prompt").fill("show gcode artifact");
    await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
    const card = page.locator(".artifactPreview--file").last();
    const frame = card.locator("iframe").contentFrame();
    await expect(frame.locator("#request")).toBeEnabled();
    await card.locator(".artifactPreviewShield").click();
    await frame.locator("#request").click();
    await expect(frame.locator("#reply")).toHaveText("Reply completed");
    await expect(frame.locator("#event")).toHaveText("Asynchronous event after reply");
    expect(probes).toBe(bytes ? 2 : 1);
    await expect.poll(() => fullReads).toBe(bytes ? 1 : 0);
    // Replay delivery must not overwrite live preview state.
    deliver({ type: "artifact_bridge_event", preview: "wrong-preview", event: { text: "wrong" } });
    deliver({ type: "artifact_bridge_event", preview: previewId, replay: true, event: { text: "replayed" } });
    await expect(frame.locator("#event")).toHaveText("Asynchronous event after reply");
    await page.screenshot({ path: `.pi/web/artifacts/artifact-bridge-${bytes ? 'with-bytes' : 'fixture'}.png` });
    await card.locator("iframe").evaluate(frame => frame.remove());
    await expect.poll(() => (registry as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  } finally { registry.releaseSession("mock-current"); await context.close(); await server.close(); }
});
