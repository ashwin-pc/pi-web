import { expect, test, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

// Bundle the production bridge itself: these tests intentionally do not use a copied
// protocol implementation or a production-only test hook.
const bridgeBundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../../src/extensions/artifactPreviews.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "ArtifactBridge",
  platform: "browser",
  write: false,
}).outputFiles[0].text;

const descriptor = { key: "security.viewer", match: { kinds: ["file"], extensions: [".secure"] } };
const artifact = { name: "test.secure", path: "/api/session-artifacts/s1/test.secure", kind: "file" };
const goodSha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

type Asset = { id: string; path: string; mediaType: string; bytes: number; sha256?: string };

async function harness(page: Page, html: string, assets: Asset[]) {
  // Keep a trustworthy localhost origin so Web Crypto is available for the real
  // SHA-256 path, then replace the app document with the isolated harness.
  await page.goto("/");
  await page.setContent("<!doctype html><div id=host></div><iframe id=attacker></iframe>");
  await page.addScriptTag({ content: bridgeBundle });
  await page.evaluate(({ descriptor, artifact, html, assets }) => {
    const w = window as any;
    w.__sid = "s1";
    w.__assetFetches = 0;
    w.__requests = [];
    w.__assetMode = "deferred";
    w.__resolveBodies = [];
    w.__aborts = 0;
    w.__pendingFetches = 0;
    w.__maxPendingFetches = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/web-contributions/invoke") return Promise.resolve(new Response(JSON.stringify({ ok: true, html, assets }), { status: 200, headers: { "content-type": "application/json" } }));
      if (url.startsWith("/api/session-artifacts/")) {
        w.__assetFetches++;
        w.__requests.push(url);
        w.__pendingFetches++;
        w.__maxPendingFetches = Math.max(w.__maxPendingFetches, w.__pendingFetches);
        return new Promise<Response>((resolve, reject) => {
          let settled = false;
          const finish = () => { if (settled) return false; settled = true; w.__pendingFetches--; return true; };
          const abort = () => { if (!finish()) return; w.__aborts++; reject(new DOMException("Aborted", "AbortError")); };
          init?.signal?.addEventListener("abort", abort, { once: true });
          w.__resolveBodies.push((body = "test", type = "text/plain") => {
            if (!finish()) return;
            init?.signal?.removeEventListener("abort", abort);
            resolve(new Response(body, { status: 200, headers: { "content-type": type } }));
          });
        });
      }
      return nativeFetch(input, init);
    }) as typeof fetch;
    w.ArtifactBridge.configureArtifactPreviews({ headers: () => ({ authorization: "Bearer secret" }), getSessionId: () => w.__sid });
    w.ArtifactBridge.setArtifactPreviews([descriptor]);
    return w.ArtifactBridge.mountArtifactPreview(document.querySelector("#host"), artifact, { title: "security preview" });
  }, { descriptor, artifact, html, assets });
  await expect(page.locator("#host iframe")).toHaveCount(1);
}

const oneAsset: Asset[] = [{ id: "tone", path: "/api/session-artifacts/s1/tone.txt", mediaType: "text/plain", bytes: 4, sha256: goodSha }];

async function frameState(page: Page, name: string) {
  return page.locator("#host iframe").contentFrame().locator("body").getAttribute(`data-${name}`);
}

test("shared bridge runtime is active only between first mount and last disposal", async ({ page }) => {
  await page.goto("/");
  await page.setContent("<!doctype html><div id=host></div>");
  await page.evaluate(() => {
    const w = window as any;
    w.__lifecycle = { messageAdds: 0, messageRemoves: 0, observes: 0, disconnects: 0 };
    const add = window.addEventListener.bind(window); const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "message") w.__lifecycle.messageAdds++; add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "message") w.__lifecycle.messageRemoves++; remove(type, listener, options);
    }) as typeof window.removeEventListener;
    const Native = MutationObserver;
    w.MutationObserver = class extends Native {
      observe(target: Node, options?: MutationObserverInit) { w.__lifecycle.observes++; return super.observe(target, options); }
      disconnect() { w.__lifecycle.disconnects++; return super.disconnect(); }
    };
  });
  await page.addScriptTag({ content: bridgeBundle });
  expect(await page.evaluate((descriptor) => {
    const w = window as any;
    w.__lifecycle = { messageAdds: 0, messageRemoves: 0, observes: 0, disconnects: 0 };
    w.__sid = "s1";
    w.fetch = () => Promise.resolve(new Response(JSON.stringify({ ok: true, html: "<body>idle</body>", assets: [] }), { status: 200 }));
    w.ArtifactBridge.configureArtifactPreviews({ headers: () => ({}), getSessionId: () => w.__sid });
    w.ArtifactBridge.setArtifactPreviews([descriptor]);
    return { ...w.__lifecycle };
  }, descriptor)).toEqual({ messageAdds: 0, messageRemoves: 0, observes: 0, disconnects: 0 });
  await page.evaluate(({ descriptor, artifact }) => (window as any).ArtifactBridge.mountArtifactPreview(document.querySelector("#host"), artifact, { title: "lifecycle" }), { descriptor, artifact });
  expect(await page.evaluate(() => ({ ...(window as any).__lifecycle }))).toEqual({ messageAdds: 1, messageRemoves: 0, observes: 1, disconnects: 0 });
  await page.evaluate(() => (window as any).ArtifactBridge.disposeArtifactPreviews());
  expect(await page.evaluate(() => ({ ...(window as any).__lifecycle }))).toEqual({ messageAdds: 1, messageRemoves: 1, observes: 1, disconnects: 1 });
  await page.evaluate(({ artifact }) => (window as any).ArtifactBridge.mountArtifactPreview(document.querySelector("#host"), artifact, { title: "remount" }), { artifact });
  expect(await page.evaluate(() => ({ ...(window as any).__lifecycle }))).toEqual({ messageAdds: 2, messageRemoves: 1, observes: 2, disconnects: 1 });
});

test("dispose callbacks run once, isolate exceptions, and stop later bridge callbacks", async ({ page }) => {
  await harness(page, `<body><script>
let disposed=0,theme=0,viewport=0;
piWebPreview.onDispose(()=>{disposed++;document.body.dataset.order="first";throw new Error("isolated")});
piWebPreview.onDispose(()=>{disposed++;document.body.dataset.disposed=String(disposed)});
piWebPreview.onThemeChange(()=>{theme++;document.body.dataset.themeCalls=String(theme)});
piWebPreview.onViewportChange(()=>{viewport++;document.body.dataset.viewportCalls=String(viewport)});
</script>`, []);
  await page.evaluate(() => (window as any).ArtifactBridge.disposeArtifactPreviews());
  await expect.poll(() => frameState(page, "disposed")).toBe("2");
  await expect.poll(() => frameState(page, "order")).toBe("first");
  const before = await page.locator("#host iframe").contentFrame().locator("body").evaluate((body) => ({ theme: body.dataset.themeCalls, viewport: body.dataset.viewportCalls }));
  await page.evaluate(() => {
    (window as any).ArtifactBridge.broadcastArtifactPreviewTheme();
    (window as any).ArtifactBridge.disposeArtifactPreviews();
  });
  expect(await frameState(page, "disposed")).toBe("2");
  expect(await page.locator("#host iframe").contentFrame().locator("body").evaluate((body) => ({ theme: body.dataset.themeCalls, viewport: body.dataset.viewportCalls }))).toEqual(before);
  await page.locator("#host iframe").contentFrame().locator("body").evaluate(() => {
    let late = 0;
    piWebPreview.onDispose(() => { late++; throw new Error("late isolated"); });
    document.body.dataset.late = String(late);
  });
  await expect.poll(() => frameState(page, "late")).toBe("1");
});

test("a session change without a DOM mutation aborts a deferred response and never delivers stale bytes", async ({ page }) => {
  await harness(page, `<body><script>piWebPreview.loadAsset("tone").then(()=>document.body.dataset.result="delivered",e=>document.body.dataset.result=e.message)</script>`, oneAsset);
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(1);
  await page.evaluate(() => { (window as any).__sid = "s2"; (window as any).__resolveBodies[0]("test", "text/plain"); });
  // The mount is invalidated while processing the response: old-session bytes
  // are never delivered and the child's pending promise is deterministically rejected.
  await expect.poll(() => frameState(page, "result")).toBe("Preview is no longer available");
  expect(await page.evaluate(() => (window as any).__assetFetches)).toBe(1);
});

test("wrong source/channel and unknown ids cannot create an asset fetch", async ({ page }) => {
  await harness(page, `<body><script>addEventListener("message",e=>{if(e.data?.piWebPreview){document.body.dataset.channel=e.data.piWebPreview;piWebPreview.loadAsset("not-listed").catch(()=>document.body.dataset.unknown="rejected")}})</script>`, oneAsset);
  await expect.poll(() => frameState(page, "channel")).not.toBeNull();
  const channel = await frameState(page, "channel");
  await page.evaluate((channel) => {
    const target = (document.querySelector("#host iframe") as HTMLIFrameElement).contentWindow!;
    // Correct channel, wrong WindowProxy source.
    (document.querySelector("#attacker") as HTMLIFrameElement).contentWindow!.eval(`parent.postMessage({piWebPreview:${JSON.stringify(channel)},type:"load",requestId:"1",id:"tone"},"*")`);
    // Correct source, wrong channel.
    target.postMessage({ piWebPreview: `${channel}-wrong`, type: "load", requestId: "2", id: "tone" }, "*");
  }, channel);
  await expect.poll(() => frameState(page, "unknown")).toBe("rejected");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__assetFetches)).toBe(0);
});

test("raw cancel plus request-id reuse preserves the 32-request cap", async ({ page }) => {
  const html = `<body><script>let c;addEventListener("message",e=>{if(!c&&e.data?.piWebPreview){c=e.data.piWebPreview;for(let i=1;i<=32;i++)parent.postMessage({piWebPreview:c,type:"load",requestId:String(i),id:"tone"},"*");parent.postMessage({piWebPreview:c,type:"cancel",requestId:"1"},"*");parent.postMessage({piWebPreview:c,type:"load",requestId:"1",id:"tone"},"*");parent.postMessage({piWebPreview:c,type:"load",requestId:"33",id:"tone"},"*");document.body.dataset.sent="yes"}})</script>`;
  await harness(page, html, oneAsset.map(a => ({ ...a, sha256: undefined })));
  await expect.poll(() => frameState(page, "sent")).toBe("yes");
  // Cancelling active ID 1 releases one slot, so request 7 starts. Reusing ID 1
  // before its aborted fetch settles and request 33 must both remain rejected.
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(7);
  for (let round = 0; round < 8; round++) {
    await page.evaluate(() => {
      const w = window as any;
      for (const resolve of w.__resolveBodies.splice(0)) resolve("test", "text/plain");
    });
    await page.waitForTimeout(20);
  }
  // One cancelled entry may be replaced, but both the reused ID and request 33
  // cannot be admitted. Thus 32 originals + exactly one replacement fetch.
  expect(await page.evaluate(() => (window as any).__assetFetches)).toBe(33);
  expect(await page.evaluate(() => (window as any).__maxPendingFetches)).toBeLessThanOrEqual(6);
});

test("the 30 second deadline releases active slots for queued requests", async ({ page }) => {
  await page.clock.install();
  const html = `<body><script>Promise.allSettled(Array.from({length:7},()=>piWebPreview.loadAsset("tone"))).then(r=>document.body.dataset.done=r.map(x=>x.status).join(","))</script>`;
  await harness(page, html, oneAsset.map(a => ({ ...a, sha256: undefined })));
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(6);
  await page.clock.runFor(30_001);
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(7);
  await page.clock.runFor(30_001);
  await expect.poll(() => frameState(page, "done")).toBe("rejected,rejected,rejected,rejected,rejected,rejected,rejected");
});

test("MIME, byte length, and SHA-256 mismatches are rejected", async ({ page }) => {
  for (const [type, body, asset, expected] of [
    ["audio/mpeg", "test", oneAsset[0], "Asset media type mismatch"],
    ["text/plain", "toolong", oneAsset[0], "Asset exceeds declared size"],
    ["text/plain", "test", { ...oneAsset[0], sha256: "0".repeat(64) }, "Asset integrity check failed"],
  ] as const) {
    await harness(page, `<body><script>piWebPreview.loadAsset("tone").catch(e=>document.body.dataset.error=e.message)</script>`, [asset]);
    await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(1);
    await page.evaluate(({ type, body }) => (window as any).__resolveBodies[0](body, type), { type, body });
    await expect.poll(() => frameState(page, "error")).toBe(expected);
    await page.evaluate(() => (window as any).ArtifactBridge.disposeArtifactPreviews());
  }
});

test("cancelling during an asynchronous integrity check cannot deliver success bytes", async ({ page }) => {
  await harness(page, `<body><script>const controller=new AbortController();window.cancelLoad=()=>controller.abort();piWebPreview.loadAsset("tone",{signal:controller.signal}).then(()=>document.body.dataset.result="delivered",e=>document.body.dataset.result=e.name)</script>`, oneAsset);
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.__digestStarted = false;
    Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: () => {
      w.__digestStarted = true;
      return new Promise<ArrayBuffer>((resolve) => { w.__resolveDigest = resolve; });
    } });
    w.__resolveBodies[0]("test", "text/plain");
  });
  await expect.poll(() => page.evaluate(() => (window as any).__digestStarted)).toBe(true);
  const child = await (await page.locator("#host iframe").elementHandle())!.contentFrame();
  await child!.evaluate(() => (window as any).cancelLoad());
  await page.evaluate(() => (window as any).__resolveDigest(new Uint8Array(32).buffer));
  await expect.poll(() => frameState(page, "result")).toBe("AbortError");
  expect(await frameState(page, "result")).not.toBe("delivered");
});

test("disposing a mount rejects pending child promises and aborts the parent fetch", async ({ page }) => {
  await harness(page, `<body><script>piWebPreview.loadAsset("tone").catch(e=>document.body.dataset.error=e.message)</script>`, oneAsset);
  await expect.poll(() => page.evaluate(() => (window as any).__assetFetches)).toBe(1);
  await page.evaluate(() => (window as any).ArtifactBridge.disposeArtifactPreviews());
  await expect.poll(() => frameState(page, "error")).toBe("Preview is no longer available");
  await expect.poll(() => page.evaluate(() => (window as any).__aborts)).toBe(1);
});
