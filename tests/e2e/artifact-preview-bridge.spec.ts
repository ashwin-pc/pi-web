import { expect, test } from "@playwright/test";

const viewer = `<!doctype html><body><div id="result">booting</div><script>
(async()=>{const api=window.piWebPreview;document.body.dataset.api=String(api.version)+":"+api.assets[0].id;document.body.dataset.compat=document.compatMode;try{await api.loadAsset("missing")}catch{document.body.dataset.unknown="rejected"}const blob=await api.loadAsset("tone");document.getElementById("result").textContent=await blob.text();api.onThemeChange(t=>document.body.dataset.theme=t.density+":"+t.tokens["--pi-web-accent"]);})();
</script>`;

test("opaque contributed preview lazily loads allowlisted media and receives theme changes", async ({ page }) => {
  await page.request.post("/api/mock/reset");
  let assetRequests = 0;
  await page.route("**/api/web-contributions/invoke", route => route.fulfill({ json: { ok: true, html: viewer, assets: [{ id: "tone", path: "/api/session-artifacts/mock-current/tone.txt", mediaType: "text/plain", bytes: 4, sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }] } }));
  await page.route("**/api/session-artifacts/mock-current/tone.txt", route => { assetRequests++; return route.fulfill({ status: 200, contentType: "text/plain", body: "test" }); });
  await page.request.post("/api/mock/state", { data: { webContributions: [{ version: 1, key: "bridge-viewer", slot: "artifact-preview", kind: "rendered", title: "Bridge", match: { kinds: ["file"], extensions: [".gcode"] } }] } });
  await page.goto("/");
  await page.reload();
  await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
  await page.locator("#prompt").fill("show gcode artifact");
  await page.locator("#promptForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  const frame = page.locator(".artifactPreview--file iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(frame.contentFrame().locator("#result")).toHaveText("test");
  const body = frame.contentFrame().locator("body");
  await expect(body).toHaveAttribute("data-api", "1:tone");
  await expect(body).toHaveAttribute("data-compat", "CSS1Compat");
  await expect(body).toHaveAttribute("data-unknown", "rejected");
  const typography = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { family: style.fontFamily, size: style.fontSize };
  });
  await expect.poll(() => frame.contentFrame().locator("html").evaluate((html) => {
    const style = getComputedStyle(html);
    return { family: style.getPropertyValue("--pi-web-font-family").trim(), size: style.getPropertyValue("--pi-web-font-size").trim() };
  })).toEqual(typography);
  expect(assetRequests).toBe(1);
  await page.evaluate(() => { document.documentElement.dataset.density = "compact"; document.documentElement.style.setProperty("--accent", "#ff00aa"); });
  await expect(body).toHaveAttribute("data-theme", "compact:#ff00aa");
  await expect(frame.contentFrame().locator("#result")).toHaveText("test");
});
