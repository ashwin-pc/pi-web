import { expect, test } from "@playwright/test";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", { data: { security: { remoteContentHosts: [] } } });
});

test("Remote content Settings edits and persists normalized hosts", async ({ page }) => {
  await page.goto("/");
  await openSessionDrawerFooterAction(page, "Preferences");
  await page.locator("#settingsNavRemoteContent").click();
  const hosts = page.locator("#settingRemoteContentHosts");
  await expect(hosts).toHaveValue("");
  await hosts.fill("Images.Example.TEST.\nlocalhost:8787");
  await page.locator("#settingSaveRemoteContentHosts").click();
  await expect(page.locator("#settingsStatus")).toHaveText("Saved");
  const saved = await (await page.request.get("/api/settings")).json();
  expect(saved.settings.security.remoteContentHosts).toEqual(["images.example.test", "localhost:8787"]);
});

test("remote images make no request before verdict, auto-load allowed hosts, and persist Always allow", async ({ page }) => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  await page.route(/https:\/\/(?:allowed|once|persist)\.example\.test\/.*/, (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() });
    return route.fulfill({ body: png, contentType: "image/png" });
  });
  await page.request.patch("/api/settings", { data: { security: { remoteContentHosts: ["allowed.example.test"] } } });
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: [
        "![allowed](https://allowed.example.test/image.png)",
        "![once](https://once.example.test/first.png)",
        "![still gated](https://once.example.test/second.png)",
        "![persist](https://persist.example.test/image.png)",
      ].join("\n\n"),
    }],
  } }));

  await page.goto("/");
  await expect(page.getByAltText("allowed")).toBeVisible();
  await expect(page.getByRole("group", { name: "Remote image" })).toHaveCount(3);
  expect(requests.some((request) => request.url.includes("once.example.test"))).toBe(false);
  expect(requests.some((request) => request.url.includes("persist.example.test"))).toBe(false);

  const onceHost = page.getByRole("group", { name: "Remote image" }).filter({ hasText: "once.example.test" });
  const once = onceHost.first();
  await once.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByAltText("once")).toBeVisible();
  await expect(onceHost).toHaveCount(1);
  expect(requests.filter((request) => request.url.includes("once.example.test"))).toHaveLength(1);
  const persist = page.getByRole("group", { name: "Remote image" }).filter({ hasText: "persist.example.test" });
  await persist.getByRole("button", { name: "Always allow this host" }).click();
  await expect(page.getByAltText("persist")).toBeVisible();

  const saved = await (await page.request.get("/api/settings")).json();
  expect(saved.settings.security.remoteContentHosts).toContain("persist.example.test");
  for (const request of requests) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-pi-web-client-id"]).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
  }
});

test("contained preview runs without a click, reports blocked fetch, then succeeds after reload", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 960 });
  const requests: Array<Record<string, string>> = [];
  await page.route("https://data.example.test/value", (route) => {
    requests.push(route.request().headers());
    return route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: { value: "loaded" },
    });
  });
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: [
        "```html-preview",
        "<p id=\"status\">running</p>",
        "<script>fetch('https://data.example.test/value').then(r=>r.json()).then(v=>document.getElementById('status').textContent=v.value).catch(()=>document.getElementById('status').textContent='blocked')</script>",
        "```",
      ].join("\n"),
    }],
  } }));

  await page.goto("/");
  const preview = page.locator(".message.assistant .htmlPreview");
  const frame = preview.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const containment = await frame.evaluate((element: HTMLIFrameElement) => {
    const parsed = new DOMParser().parseFromString(element.srcdoc, "text/html");
    const first = parsed.head.firstElementChild;
    return {
      tag: first?.tagName,
      httpEquiv: first?.getAttribute("http-equiv"),
      content: first?.getAttribute("content"),
    };
  });
  expect(containment).toEqual({
    tag: "META",
    httpEquiv: "Content-Security-Policy",
    content: "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'",
  });
  const notice = preview.locator(".htmlPreviewNotice", { hasText: "data.example.test" });
  await expect(notice).toBeVisible();
  const noticeLayout = await notice.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const message = element.querySelector("span")!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      messageWidth: message.width,
      containerWidth: container.width,
      buttonsFit: buttons.every((button) =>
        button.height >= 44
        && button.left >= container.left
        && button.right <= container.right + 0.5),
    };
  });
  expect(noticeLayout.messageWidth).toBeGreaterThan(noticeLayout.containerWidth * 0.9);
  expect(noticeLayout.buttonsFit).toBe(true);
  await expect(frame.contentFrame().locator("html")).toHaveAttribute("data-pi-web-blocked-uri", "https://data.example.test/value");
  expect(requests).toHaveLength(0);
  await notice.getByRole("button", { name: "Allow for this preview" }).click();
  const reloadedFrame = preview.locator("iframe");
  await expect(reloadedFrame.contentFrame().locator("#status")).toHaveText("loaded");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].authorization).toBeUndefined();
  expect(requests[0]["x-pi-web-client-id"]).toBeUndefined();
  expect(requests[0].cookie).toBeUndefined();
  expect(requests[0].referer).toBeUndefined();
});

test("contained preview replaces self-navigation with a notice and can reload", async ({ page }) => {
  await page.route("https://destination.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<p>destination</p>",
  }));
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "```html-preview\n<a id=\"leave\" href=\"https://destination.example.test/page\">Leave</a>\n```",
    }],
  } }));

  await page.goto("/");
  const preview = page.locator(".message.assistant .htmlPreview");
  await preview.locator("iframe").contentFrame().locator("#leave").click();
  const navigation = preview.locator(".htmlPreviewNavigation");
  await expect(navigation).toContainText("destination.example.test");
  await expect(navigation.getByRole("button", { name: "Open in new tab" })).toBeVisible();
  await navigation.getByRole("button", { name: "Reload preview" }).click();
  await expect(preview.locator("iframe").contentFrame().locator("#leave")).toBeVisible();
});

test("script-driven preview navigation can request its URL before the parent shows a host notice", async ({ page }) => {
  let markerRequests = 0;
  let noticesWhenRequested = -1;
  await page.route("https://navigation.example.test/marker", async (route) => {
    markerRequests += 1;
    noticesWhenRequested = await page.locator(".htmlPreviewNavigation").count();
    return route.fulfill({
      contentType: "text/html",
      body: "<script>parent.postMessage({type:'pi-web-preview-navigation',url:location.href},'*')</script>",
    });
  });
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "```html-preview\n<script>location.href='https://navigation.example.test/marker'</script>\n```",
    }],
  } }));

  await page.goto("/");
  await expect.poll(() => markerRequests).toBe(1);
  expect(noticesWhenRequested).toBe(0);
  const navigation = page.locator(".message.assistant .htmlPreviewNavigation");
  await expect(navigation).toBeVisible();
  await expect(navigation).toContainText("navigation.example.test");
  await expect(navigation).not.toContainText(/blocked|prevented/i);
});

test("preview WebRTC availability is a browser channel outside the CSP directives", async ({ page }) => {
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: [
        "```html-preview",
        "<p id=\"webrtc\">starting</p>",
        "<script>",
        "(async()=>{",
        "const status=document.getElementById('webrtc');",
        "let peer;",
        "try{",
        "peer=new RTCPeerConnection({iceServers:[{urls:'stun:webrtc-residual.example.test:3478'}]});",
        "const channel=peer.createDataChannel('containment-probe');",
        "const offer=await peer.createOffer();",
        "await peer.setLocalDescription(offer);",
        "status.textContent=`configured ${channel.label} ${peer.localDescription?.type}`;",
        "}catch(error){status.textContent=`failed ${error?.name||error}`}",
        "finally{peer?.close()}",
        "})()",
        "</script>",
        "```",
      ].join("\n"),
    }],
  } }));

  await page.goto("/");
  const preview = page.locator(".message.assistant .htmlPreview");
  await expect(preview.locator("iframe").contentFrame().locator("#webrtc")).toHaveText("configured containment-probe offer");
  await expect(preview.locator(".htmlPreviewNotice")).toHaveCount(0);
});

test("inline HTML preview runs on mount and keeps its Source control outside the iframe", async ({ page }) => {
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "```html-preview\n<p id=\"inline-status\">pending</p><script>document.getElementById('inline-status').textContent='ran'</script>\n```",
    }],
  } }));

  await page.goto("/");
  const preview = page.locator(".message.assistant .htmlPreview");
  const frame = preview.locator("iframe");
  await expect(frame.contentFrame().locator("#inline-status")).toHaveText("ran");
  const controls = preview.locator(".htmlPreviewControls");
  const source = controls.getByRole("button", { name: "Show HTML source" });
  await expect(controls).toHaveCSS("position", "static");
  await source.click();
  await expect(frame).toBeHidden();
  await expect(preview.locator("pre")).toBeVisible();
  await expect(preview.locator("pre")).toContainText("inline-status");
  await controls.getByRole("button", { name: "Show interactive preview" }).click();
  await expect(frame).toBeVisible();
  await expect(frame.contentFrame().locator("#inline-status")).toHaveText("ran");
  await expect(page.getByRole("button", { name: /Run|Stop/i })).toHaveCount(0);
});

test("linked and custom HTML artifact previews execute before their interaction shields are dismissed", async ({ page }) => {
  await page.route("**/api/artifacts/preview.html", (route) => route.fulfill({
    contentType: "text/html",
    body: "<p id=\"linked\">linked ran</p><script>linked.dataset.ran='yes'</script>",
  }));
  await page.route("**/api/web-contributions/invoke", (route) => route.fulfill({
    json: { ok: true, html: "<p id=\"custom\">custom ran</p><script>custom.dataset.ran='yes'</script>" },
  }));
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [{
      role: "assistant",
      isError: false,
      text: "[Linked HTML](/api/artifacts/preview.html)\n\n[Custom HTML](/api/artifacts/toolpath.gcode)",
    }],
  } }));
  await page.request.post("/api/mock/state", { data: {
    webContributions: [{
      version: 1,
      key: "gcode-preview",
      slot: "artifact-preview",
      kind: "rendered",
      title: "G-code preview",
      match: { kinds: ["file"], extensions: [".gcode"] },
    }],
  } });

  await page.goto("/");
  const linked = page.locator('.artifactPreview[data-artifact-name="preview.html"] iframe');
  const custom = page.locator('.artifactPreview[data-artifact-name="toolpath.gcode"] iframe');
  await expect(linked.contentFrame().locator("#linked")).toHaveAttribute("data-ran", "yes");
  await expect(custom.contentFrame().locator("#custom")).toHaveAttribute("data-ran", "yes");
  const linkedCard = page.locator('.artifactPreview[data-artifact-name="preview.html"]');
  const customCard = page.locator('.artifactPreview[data-artifact-name="toolpath.gcode"]');
  await expect(linked).toHaveCSS("pointer-events", "none");
  await expect(custom).toHaveCSS("pointer-events", "none");
  await expect(linkedCard.getByRole("button", { name: /Click to interact/i })).toBeVisible();
  await customCard.getByRole("button", { name: /Click to interact/i }).click();
  await expect(customCard).toHaveClass(/artifactPreview--interactive/);
  await expect(customCard.locator("iframe")).toHaveCSS("pointer-events", "auto");
  await expect(page.getByRole("button", { name: /Run preview/i })).toHaveCount(0);
});
