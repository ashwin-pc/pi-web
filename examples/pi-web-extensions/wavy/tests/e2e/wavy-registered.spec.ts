import { expect, request, test } from "@playwright/test";
import { startRegisteredWavyServer, type RegisteredWavyServer } from "./helpers/registeredWavy.js";
import { loadProject } from "../../store.js";
import { renderWavyPreview } from "../../preview.js";
let server: RegisteredWavyServer;
test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop", "one registered runtime path is sufficient"); server = await startRegisteredWavyServer(); });
test.afterEach(async () => { await server?.stop(); });

test("real registered Wavy preview is opaque, HTML-only, and keeps local selection comments", async ({ page }) => {
  const anonymous = await request.newContext({ baseURL: server.origin }); expect((await anonymous.get("/api/state")).status()).toBe(401); await anonymous.dispose();
  const artifactRequests: string[] = []; page.on("request", request => { if (request.url().includes("/api/artifacts/")) artifactRequests.push(request.url()); });
  await page.goto(`${server.origin}/?token=${server.token}`); await expect(page.locator("#statusTitle")).toBeVisible();
  const preview = page.locator(".artifactPreview--file", { has: page.locator("iframe") }); const iframe = preview.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts"); await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const frame = iframe.contentFrame(); await expect(frame.getByRole("heading", { name: "Registered Wavy fixture" })).toBeVisible(); await preview.getByRole("button", { name: /Click to interact/i }).click();
  // The registered iframe passed through core's exact cleanFooterText path. Compare
  // its line-continuation semantics with canonical extension rendering.
  const hostedEvents = await frame.locator("body").evaluate(() => (window as any).__wavyTest.events());
  const canonical = await page.context().newPage();
  await canonical.setContent(await renderWavyPreview(await loadProject(server.workspace, "fixtures/registered.wavy")));
  const canonicalEvents = await canonical.locator("body").evaluate(() => (window as any).__wavyTest.events());
  expect(hostedEvents).toEqual(canonicalEvents);
  expect(hostedEvents).toHaveLength(6);
  await canonical.close();
  await frame.getByRole("button", { name: "Piano roll" }).click(); const notes=frame.locator("#roll .roll-note"); await notes.first().click(); await frame.getByRole("button", {name:"Select"}).click(); await notes.nth(1).click(); const selected=await frame.locator("body").evaluate(()=>(window as any).__wavyTest.selection());
  await frame.getByRole("button", {name:"Comment on selected passage"}).click(); await frame.getByRole("textbox", {name:"Passage edit comment"}).fill("Make the passage lighter."); await frame.getByRole("button", {name:"Notation", exact:true}).click(); await expect(frame.getByRole("textbox", {name:"Passage edit comment"})).toHaveValue("Make the passage lighter."); await frame.getByRole("button", {name:"Piano roll"}).click(); expect(await frame.locator("body").evaluate(()=>(window as any).__wavyTest.selection())).toEqual(selected);
  await frame.getByRole("button", {name:"Copy comment draft"}).click(); const draft=frame.locator("#commentFallback"); await expect(draft).toContainText("Composition revision: 1"); await expect(draft).toContainText(server.scoreSha256); await expect(draft).toContainText("UTF-16"); await expect(draft).toContainText("Make the passage lighter.");
  expect(artifactRequests).toEqual([]);
});
