import { expect, request, test } from "@playwright/test";
import { renderWavyPreview } from "../../examples/pi-web-extensions/wavy/preview.js";
import type { LoadedProject } from "../../examples/pi-web-extensions/wavy/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ref = (path: string) => ({ path, sha256: "b".repeat(64), bytes: 44 });
const score = `X:1
T:Voices & tempo
M:4/4
L:1/8
Q:1/4=120
K:C
[V:1] [CE]2 D2|[Q:1/4=60][M:3/4][K:G] E6|
[V:2] G,8| C,6|`;
function fixture(scoreOverride = score): LoadedProject {
  return {
    absolutePath: "/tmp/unicode.wavy", artifactPath: "/api/artifacts/unicode.wavy", warnings: [],
    head: { lyrics: "Héllo 世界 🎵 <img src=x onerror=window.xss=1>", style: "Élan acoustique", score: scoreOverride, settings: { precision: "bf16", planning: "full", maxSemanticTokens: 9000 } },
    index: { format: "wavy", version: 1, title: "Café 世界 🎶", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", revision: 2,
      revisions: [], sources: [], takes: [
        { id: "older", revision: 1, createdAt: "2025-01-01T00:00:00Z", status: "complete", seed: 1, precision: "bf16", request: ref("unicode.wavy.d/old.json"), audio: ref("unicode.wavy.d/old.wav") },
        { id: "latest", revision: 2, createdAt: "2025-01-02T00:00:00Z", status: "complete", seed: 2, precision: "bf16", request: ref("unicode.wavy.d/new.json"), audio: ref("unicode.wavy.d/new.wav") },
      ] },
  };
}

test("Wavy renders safe Unicode and derives multi-voice score timing/highlights in a real browser", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  const html = await renderWavyPreview(fixture());
  page.on("pageerror", error => console.error("Wavy page error:", error));
  await page.setContent(html);
  await expect(page.locator("#title")).toHaveText("Café 世界 🎶");
  await expect(page.locator("#lyrics")).toContainText("Héllo 世界 🎵");
  expect(await page.evaluate(() => (window as any).xss)).toBeUndefined();
  await expect(page.locator("#mediaNotice")).toContainText("Selected but not loaded");
  await expect(page.locator("#recording")).toBeHidden();
  await expect(page.locator("#takeSelect")).toHaveValue("1");
  await expect(page.locator("#selectedTakeMeta")).toHaveText("Revision 2 · complete");
  await expect(page.locator(".take-history")).not.toHaveAttribute("open", "");
  await page.locator(".take-history summary").click();
  await expect(page.locator(".take").last()).toContainText("latest");

  const events = await page.evaluate(() => (window as any).__wavyTest.events());
  expect(events).toHaveLength(5);
  expect(events.filter((event: any) => event.ms === 0).map((event: any) => event.p).flat().sort()).toEqual([55, 60, 64]);
  expect(events.find((event: any) => event.ms === 0 && event.p.includes(60)).dur).toBe(500);
  expect(events.find((event: any) => event.ms === 1000 && event.p[0] === 64).dur).toBe(3000);
  expect(events.every((event: any) => event.elements.length > 0)).toBe(true);

  await page.locator("#scorePlay").click();
  await expect.poll(() => page.locator("#notation .active-note").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".roll-key.playing").count()).toBeGreaterThan(0);
  await expect(page.locator("#position")).toContainText("Bar 1");
  await page.locator("#scorePlay").click();
  await expect(page.locator("#notation .active-note")).toHaveCount(0);await expect(page.locator(".roll-key.playing")).toHaveCount(0);
});

test("keyboard highlights the active canonical pitch union and clears outside written audition", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one browser clock run covers canonical keyboard lighting");
  const abc=`X:1\nM:4/4\nL:1/8\nQ:1/4=120\nV:Lead\nV:Double\nK:C\n[V:Lead] [C^F]4 z4|\n[V:Double] C4 z4|`;
  await page.setContent(await renderWavyPreview(fixture(abc)));await page.locator("#rollButton").click();await page.locator("#scorePlay").click();
  await expect.poll(()=>page.locator(".roll-key.playing").evaluateAll(keys=>keys.map(key=>key.getAttribute("aria-label")).sort())).toEqual(["C4, sounding","F♯4, sounding"]);
  expect(await page.locator('.roll-key[data-pitch="60"].playing').count()).toBe(1);expect(await page.locator('.roll-key[data-pitch="66"].playing').count()).toBe(1);
  await page.locator("#scoreProgressTrack").fill("900");await expect(page.locator(".roll-key.playing")).toHaveCount(0);
  await page.locator("#scorePlay").click();await expect(page.locator(".roll-key.playing")).toHaveCount(0);
  await page.locator("#scoreProgressTrack").fill("0");await page.locator("#scorePlay").click();await expect.poll(()=>page.locator(".roll-key.playing").count()).toBe(2);await page.locator("#scorePlay").click();await expect(page.locator(".roll-key.playing")).toHaveCount(0);
});

test("new player remains usable with cached preview markup that lacks zoom controls", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  const errors: Error[]=[];page.on("pageerror",error=>errors.push(error));
  const html=(await renderWavyPreview(fixture())).replace(/<div id="zoomControls"[\s\S]*?<\/div><div class="view-buttons">/, '<div class="view-buttons">');
  await page.setContent(html);
  await expect(page.locator("#notation svg")).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__wavyTest?.zoom())).toBe(1);
  expect(errors).toEqual([]);
});

test("score taps position silently, selection persists after playback, and touch scrolling stays native", async ({ page }, info) => {
  const project = fixture();
  project.index.revisions = [{ id: 2, createdAt: "2025-01-01T00:00:00Z", summary: "score", origin: "agent", files: { lyrics: ref("l"), style: ref("s"), settings: ref("j"), score: ref("score.abc") } }];
  await page.setContent(await renderWavyPreview(project));
  const notes = page.locator("#notation [selectable]");
  await expect(notes.first()).toBeVisible();
  await notes.first().click({ force: true });
  expect(await page.evaluate(() => (window as any).__wavyTest.player.playing)).toBe(false);
  await expect(page.locator("#notation .wavy-cursor")).not.toHaveCount(0);
  await page.locator("#selectMode").click();
  await notes.nth(1).click({ force: true });
  await expect(page.locator("#selectionActions")).toBeVisible();
  await page.locator("#scorePlay").click();
  await expect(page.locator("#scorePlay")).toHaveText("Pause");
  await page.locator("#loopSelection").click();
  await expect.poll(() => page.evaluate(() => ({ playing: (window as any).__wavyTest.player.playing, looping: (window as any).__wavyTest.player.looping }))).toEqual({ playing: true, looping: true });
  await expect(page.locator("#loopSelection")).toHaveAttribute("aria-pressed","true");
  await page.locator("#scorePlay").click();
  const pausedWindow = await page.evaluate(() => { const player=(window as any).__wavyTest.player; return { from:player.windowStart,to:player.windowEnd,looping:player.looping }; });
  expect(pausedWindow.looping).toBe(true);
  await page.locator("#scorePlay").click();
  await expect.poll(() => page.evaluate(() => (window as any).__wavyTest.player.playing)).toBe(true);
  expect(await page.evaluate(() => { const player=(window as any).__wavyTest.player; return { from:player.windowStart,to:player.windowEnd,looping:player.looping }; })).toEqual(pausedWindow);
  await page.locator("#scorePlay").click();
  await expect(page.locator("#notation .wavy-selected")).not.toHaveCount(0);
  await page.locator("#loopSelection").click();await expect(page.locator("#loopSelection")).toHaveAttribute("aria-pressed","false");
  expect(await page.locator("#scorePaper").evaluate(element => getComputedStyle(element).touchAction)).toBe("auto");
  expect(await page.locator("#selectionStart").evaluate(element => getComputedStyle(element).touchAction)).toBe("none");
  if (info.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.locator("#scorePlay")).toHaveCSS("min-height", "44px");
    const actionsBox = await page.locator("#selectionActions").boundingBox();
    const sectionBox = await page.locator("#scoreSection").boundingBox();
    expect(actionsBox && sectionBox && actionsBox.x >= sectionBox.x && actionsBox.x + actionsBox.width <= sectionBox.x + sectionBox.width + 1).toBe(true);
    for (const id of ["playSelection", "loopSelection", "commentSelection", "clearSelection"]) await expect(page.locator(`#${id}`)).toBeVisible();
    const client = await page.context().newCDPSession(page);
    await page.locator("#scorePaper").scrollIntoViewIfNeeded();
    const paper = await page.locator("#scorePaper").boundingBox();
    if (paper) {
      const sizes=await page.locator("#scorePaper").evaluate(element=>({scroll:element.scrollWidth,client:element.clientWidth}));expect(sizes.scroll).toBeGreaterThan(sizes.client);
      const y=paper.y+paper.height/2;
      const selectionBeforePan=await page.evaluate(()=>(window as any).__wavyTest.selection());
      await client.send("Input.synthesizeScrollGesture",{x:paper.x+250,y,xDistance:190,yDistance:0,speed:500,gestureSourceType:"touch"});
      expect(await page.evaluate(()=>(window as any).__wavyTest.selection())).toEqual(selectionBeforePan);
    }
    await page.locator("#scorePaper").evaluate(element=>{element.scrollLeft=Math.min(180,element.scrollWidth-element.clientWidth);});await page.waitForTimeout(50);
    const beforeSelection=await page.evaluate(()=>(window as any).__wavyTest.selection());
    await page.locator("#zoomIn").click();await page.locator("#zoomIn").click();
    const handle=await page.locator("#selectionEnd").boundingBox();
    const target=await page.locator("#notation .abcjs-note:not(.wavy-selected)").evaluateAll(elements=>{const paper=document.querySelector("#scorePaper")!.getBoundingClientRect();return elements.map(element=>element.getBoundingClientRect()).filter(rect=>rect.left>=paper.left&&rect.right<=paper.right&&rect.top>=paper.top&&rect.bottom<=paper.bottom).map(rect=>({x:rect.left+rect.width/2,y:rect.top+rect.height/2})).at(-1);});
    if(handle&&target){
      const hx=handle.x+handle.width/2,hy=handle.y+handle.height/2,tx=target.x,ty=target.y;
      await page.mouse.move(hx,hy);await page.mouse.down();
      for(const step of [.25,.5,.75,1])await page.mouse.move(hx+(tx-hx)*step,hy+(ty-hy)*step);
      await page.mouse.up();
      const adjusted=await page.evaluate(()=>(window as any).__wavyTest.selection());
      expect(adjusted).toBeTruthy();expect(adjusted.playback.occurrenceIds.length).toBeGreaterThan(0);await expect(page.locator("#selectionEnd")).toBeVisible();
    }
  }
});

test("phone multi-touch pinches around its focal point, pans, suppresses activation, and resets", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "real CDP touch input needs the phone project");
  await page.setViewportSize({ width: 390, height: 700 });
  await page.setContent(await renderWavyPreview(fixture()));
  const paperLocator=page.locator("#scorePaper");
  await paperLocator.scrollIntoViewIfNeeded();
  const paper=await paperLocator.boundingBox();expect(paper).toBeTruthy();
  const client=await page.context().newCDPSession(page),cx=paper!.x+paper!.width*.55,cy=paper!.y+paper!.height*.45;
  const scoreGeometry=()=>page.evaluate(()=>{const paper=document.querySelector("#scorePaper")!,note=document.querySelector("#notation .abcjs-notehead")!.getBoundingClientRect();return {zoom:(window as any).__wavyTest.zoom(),note:{width:note.width,height:note.height},scroll:{width:paper.scrollWidth,height:paper.scrollHeight}};});
  const beforeGeometry=await scoreGeometry();
  const beforeScroll=await paperLocator.evaluate(element=>element.scrollLeft);
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:1,x:cx-35,y:cy},{id:2,x:cx+35,y:cy}]});
  await client.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{id:1,x:cx-70,y:cy},{id:2,x:cx+70,y:cy}]});
  expect(await page.evaluate(()=>(window as any).__wavyTest.zoom())).toBeGreaterThan(1.8);
  const pinchedGeometry=await scoreGeometry(),pinchFactor=pinchedGeometry.zoom/beforeGeometry.zoom;
  expect(pinchedGeometry.note.width/beforeGeometry.note.width).toBeCloseTo(pinchFactor,1);
  expect(pinchedGeometry.note.height/beforeGeometry.note.height).toBeCloseTo(pinchFactor,1);
  expect(pinchedGeometry.scroll.width).toBeGreaterThan(beforeGeometry.scroll.width);
  expect(pinchedGeometry.scroll.height).toBeGreaterThan(beforeGeometry.scroll.height);
  const anchoredScroll=await paperLocator.evaluate(element=>element.scrollLeft);
  // At 2×, anchoring keeps the content under the midpoint by scrolling one focal offset.
  expect(Math.abs(anchoredScroll-(beforeScroll+(cx-paper!.x)))).toBeLessThan(18);
  // Lift one pinch finger and continue panning without requiring all fingers up.
  const pinchIds=await page.evaluate(()=>(window as any).__wavyTest.gesture().pointerIds);
  await page.locator("#notation").dispatchEvent("pointerup",{pointerId:pinchIds[0],pointerType:"touch",clientX:cx-70,clientY:cy});
  const continuedFrom=await paperLocator.evaluate(element=>element.scrollLeft);
  await page.locator("#notation").dispatchEvent("pointermove",{pointerId:pinchIds[1],pointerType:"touch",clientX:cx+30,clientY:cy});
  expect(await paperLocator.evaluate(element=>element.scrollLeft)).toBeGreaterThan(continuedFrom+25);
  await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  const cursorBefore=await page.locator("#notation .wavy-cursor").count();
  const scrollBefore=await paperLocator.evaluate(element=>element.scrollLeft);
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:3,x:cx,y:cy}]});
  await client.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{id:3,x:cx-80,y:cy}]});
  await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  expect(await paperLocator.evaluate(element=>element.scrollLeft)).toBeGreaterThan(scrollBefore+50);
  expect(await page.locator("#notation .wavy-cursor").count()).toBe(cursorBefore);
  await page.locator("#zoomReset").click();
  expect(await page.evaluate(()=>(window as any).__wavyTest.zoom())).toBe(1);
  await expect(page.locator("#zoomReset")).toHaveText("100%");
  const resetGeometry=await scoreGeometry();
  expect(resetGeometry.note.width).toBeCloseTo(beforeGeometry.note.width,1);
  expect(resetGeometry.note.height).toBeCloseTo(beforeGeometry.note.height,1);
  expect(resetGeometry.scroll.height).toBeCloseTo(beforeGeometry.scroll.height,0);
  await page.locator("#zoomIn").click();
  const buttonGeometry=await scoreGeometry();
  expect(buttonGeometry.zoom).toBeCloseTo(1.2,5);
  expect(buttonGeometry.note.width/beforeGeometry.note.width).toBeCloseTo(1.2,1);
  expect(buttonGeometry.note.height/beforeGeometry.note.height).toBeCloseTo(1.2,1);
  expect(buttonGeometry.scroll.height).toBeGreaterThan(beforeGeometry.scroll.height);
  await page.locator("#zoomReset").click();
  const buttonResetGeometry=await scoreGeometry();
  expect(buttonResetGeometry.note.width).toBeCloseTo(beforeGeometry.note.width,1);
  expect(buttonResetGeometry.note.height).toBeCloseTo(beforeGeometry.note.height,1);
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:5,x:cx,y:cy}]});
  await client.send("Input.dispatchTouchEvent",{type:"touchCancel",touchPoints:[]});
  expect(await page.locator("#notation .wavy-cursor").count()).toBe(cursorBefore);
  const tap=await page.locator("#notation .abcjs-note").first().boundingBox();
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:4,x:tap!.x+tap!.width/2,y:tap!.y+tap!.height/2}]});
  await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  await expect(page.locator("#notation .wavy-cursor")).not.toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__wavyTest.player.playing)).toBe(false);
});

test("cancelled score review keeps the inline draft and sends bounded snapshot context", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop covers the bridge payload; mobile layout is covered separately");
  await page.evaluate(() => {
    (window as any).__reviewRequests = [];
    (window as any).piWebPreview = { version: 1, theme: { tokens: {} }, onThemeChange() {}, requestReview(request: any) { (window as any).__reviewRequests.push(request); return Promise.resolve({ status: "cancelled" }); } };
  });
  const project = fixture();
  project.index.revisions = [{ id: 2, createdAt: "2025-01-01T00:00:00Z", summary: "score", origin: "agent", files: { lyrics: ref("l"), style: ref("s"), settings: ref("j"), score: ref("score.abc") } }];
  await page.setContent(await renderWavyPreview(project));
  const notes = page.locator("#notation [selectable]");
  await notes.first().click({ force: true }); await page.locator("#selectMode").click(); await notes.nth(1).click({ force: true });
  await page.locator("#commentSelection").click();
  await page.locator("#commentText").fill("Make this phrase lighter");
  await page.locator("#commentStage").click();
  await expect(page.locator("#commentStatus")).toContainText("cancelled");
  await expect(page.locator("#commentText")).toHaveValue("Make this phrase lighter");
  const request = await page.evaluate(() => (window as any).__reviewRequests[0]);
  expect(request.action).toBe("review-score-edit");
  expect(request.payload.snapshot).toEqual({ compositionRevision: 2, scoreSha256: "b".repeat(64) });
  expect(request.payload.selection.kind).toBe("abc-source-ranges");
  expect(request.payload.selection.ranges.every((range: any) => range.end > range.start && range.excerpt)).toBe(true);
});

test("roll and notation share one passage comment draft, layout, and review payload", async ({page},info)=>{
  test.skip(info.project.name!=="desktop","one test switches views and exercises both phone widths");await page.evaluate(()=>{(window as any).__reviewRequests=[];(window as any).piWebPreview={version:1,theme:{tokens:{}},onThemeChange(){},requestReview(request:any){(window as any).__reviewRequests.push(request);return Promise.resolve({status:"cancelled"});}};});
  const project=fixture();project.index.revisions=[{id:2,createdAt:"2025-01-01T00:00:00Z",summary:"score",origin:"agent",files:{lyrics:ref("l"),style:ref("s"),settings:ref("j"),score:ref("score.abc")}}];await page.setContent(await renderWavyPreview(project));await page.locator("#rollButton").click();const rollNotes=page.locator("#roll .roll-note");await rollNotes.first().click();await page.locator("#selectMode").click();await rollNotes.nth(1).click();const original=await page.evaluate(()=>(window as any).__wavyTest.selection());expect(original.ranges.length).toBeGreaterThan(0);await page.locator("#commentSelection").click();await page.locator("#commentText").fill("Keep this shared passage draft.");
  await page.locator("#notationButton").click();await expect(page.locator("#commentPanel")).toBeVisible();await expect(page.locator("#commentText")).toHaveValue("Keep this shared passage draft.");expect(await page.evaluate(()=>(window as any).__wavyTest.selection())).toEqual(original);await expect(page.locator("#notation .wavy-selected")).not.toHaveCount(0);
  await page.locator("#rollButton").click();await expect(page.locator("#commentPanel")).toBeVisible();await expect(page.locator("#commentText")).toHaveValue("Keep this shared passage draft.");await expect(page.locator("#roll .wavy-selected")).not.toHaveCount(0);
  for(const width of [390,320]){await page.setViewportSize({width,height:700});await expect(page.locator("#commentPanel")).toHaveClass(/phone-drawer/);await expect.poll(()=>page.evaluate(()=>{const panel=document.querySelector("#commentPanel")!.getBoundingClientRect(),paper=document.querySelector("#scorePaper")!.getBoundingClientRect(),selected=[...document.querySelectorAll("#roll .wavy-selected")].map(e=>e.getBoundingClientRect());return panel.bottom<=innerHeight+1&&selected.some(r=>r.left>=paper.left+41&&r.right<=paper.right&&r.top>=paper.top&&r.bottom<=paper.bottom);})).toBe(true);}
  await page.locator("#commentStage").click();await expect(page.locator("#commentStatus")).toContainText("cancelled");await expect(page.locator("#commentText")).toHaveValue("Keep this shared passage draft.");const request=await page.evaluate(()=>(window as any).__reviewRequests[0]);expect(request.payload.selection.ranges.map((r:any)=>({start:r.start,end:r.end,voiceId:r.voiceId}))).toEqual(original.ranges);await page.locator("#notationButton").click();await page.locator("#commentStage").click();await expect.poll(()=>page.evaluate(()=>(window as any).__reviewRequests.length)).toBe(2);const requests=await page.evaluate(()=>(window as any).__reviewRequests);expect(requests[1].payload.selection).toEqual(requests[0].payload.selection);
});

test("an accepted delayed review never clears newer inline comment text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one browser run is sufficient");
  await page.evaluate(() => {
    (window as any).piWebPreview={version:1,theme:{tokens:{}},onThemeChange(){},requestReview(){return new Promise(resolve=>{(window as any).__resolveReview=resolve;});}};
  });
  const project=fixture();project.index.revisions=[{id:2,createdAt:"2025-01-01T00:00:00Z",summary:"score",origin:"agent",files:{lyrics:ref("l"),style:ref("s"),settings:ref("j"),score:ref("score.abc")}}];
  await page.setContent(await renderWavyPreview(project));const notes=page.locator("#notation [selectable]");
  await notes.first().click({force:true});await page.locator("#selectMode").click();await notes.nth(1).click({force:true});await page.locator("#commentSelection").click();
  await page.locator("#commentText").fill("Submitted draft");await page.locator("#commentStage").click();await expect(page.locator("#commentStage")).toBeDisabled();
  await page.locator("#commentText").fill("Newer draft while review is open");await page.evaluate(()=>(window as any).__resolveReview({status:"added"}));
  await expect(page.locator("#commentText")).toHaveValue("Newer draft while review is open");await expect(page.locator("#commentStage")).toBeEnabled();
});

test("open passage comments survive desktop-to-phone resizing without overflow", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one test exercises all three viewport widths");
  const project = fixture();
  project.index.revisions = [{ id: 2, createdAt: "2025-01-01T00:00:00Z", summary: "score", origin: "agent", files: { lyrics: ref("l"), style: ref("s"), settings: ref("j"), score: ref("score.abc") } }];
  await page.setContent(await renderWavyPreview(project));
  const head = page.locator("#notation .abcjs-notehead").first();
  await head.scrollIntoViewIfNeeded();
  const hit = await head.boundingBox();
  // A ledger line may legitimately be the painted SVG target over a notehead.
  // Exercise the real coordinate hit-test rather than forcing a DOM target.
  await page.mouse.click(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
  await page.locator("#selectMode").click();
  await expect(page.locator("#selectionLabel")).toContainText("0.50s");
  await page.locator("#commentSelection").click();
  await page.locator("#commentText").fill("Keep this short phrase together.");
  await expect(page.locator("#commentPanel")).toHaveClass(/desktop-anchor/);
  const originalSelection = await page.evaluate(() => (window as any).__wavyTest.selection());
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.locator("#commentPanel")).toHaveClass(/phone-drawer/);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator("#commentText")).toHaveValue("Keep this short phrase together.");
    expect(await page.evaluate(() => (window as any).__wavyTest.selection())).toEqual(originalSelection);
    const panel = await page.locator("#commentPanel").boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.locator("#selectionActions svg.action-icon").count()).toBe(4);
    // Simulate retained document scroll putting the selected passage above the
    // viewport after a layout change. Reflow must restore the music, not just Review.
    await page.evaluate(() => {
      const selected = document.querySelector("#notation .wavy-selected")!;
      window.scrollBy(0, selected.getBoundingClientRect().top + 20);
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => page.locator("#notation .wavy-selected").first().evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(11);
  }
});

test("ABCJS audio flattening preserves key signatures, accidentals, octaves, ties, and repeats", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  const abc = `X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:G\n|: F2 =F2 _B2 ^C2|c2 C2-C2 :|`;
  await page.setContent(await renderWavyPreview(fixture(abc)));
  const events = await page.evaluate(() => (window as any).__wavyTest.events());
  const firstPass = events.slice(0, 6);
  expect(firstPass.map((event: any) => event.p[0])).toEqual([66, 65, 70, 61, 72, 60]);
  expect(firstPass.at(-1).dur).toBe(1000);
  expect(events.slice(6).map((event: any) => event.p[0])).toEqual(firstPass.map((event: any) => event.p[0]));
});

test("block voice IDs, tie fragments, and exact multivoice SVG ownership share one source adapter", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one real browser adapter run is sufficient");
  const abc=`X:1\nM:4/4\nL:1/8\nQ:1/4=120\nV:Vocal\nV:Ins\nK:C\n[V:Vocal] C2-C2 E4|\n[V:Ins] G,8|`;
  await page.setContent(await renderWavyPreview(fixture(abc)));
  const notes=await page.evaluate(()=>(window as any).__wavyTest.notes());
  const vocal=notes.find((note:any)=>note.voiceLabel==="Vocal");
  expect(vocal).toBeTruthy();expect(vocal.sourceRanges).toHaveLength(2);
  const vocalSvg=vocal.elements.filter((classes:string)=>classes.includes("abcjs-"));expect(vocalSvg.every((classes:string)=>classes.includes("abcjs-v0")&&!classes.includes("abcjs-v1"))).toBe(true);
  const ins=notes.find((note:any)=>note.voiceLabel==="Ins"),insSvg=ins.elements.filter((classes:string)=>classes.includes("abcjs-"));expect(insSvg.every((classes:string)=>classes.includes("abcjs-v1"))).toBe(true);
});

test("piano roll uses canonical empty-bar boundaries and keeps source selection across views", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop covers canonical geometry and shared selection");
  const abc=`X:1\nM:4/4\nL:1/8\nQ:1/4=120\nV:Vocal\nK:C\n[V:Vocal] Z2|C2 D2 E4|`;
  await page.setContent(await renderWavyPreview(fixture(abc)));
  expect(await page.evaluate(()=>(window as any).__wavyTest.bars())).toEqual([
    {measure:0,ms:0},{measure:1,ms:2000},{measure:2,ms:4000},{measure:3,ms:6000},
  ]);
  await page.locator("#rollButton").click();
  await expect(page.locator(".roll-barline span")).toHaveText(["Bar 1","Bar 2","Bar 3","Bar 4"]);const keyboardX=await page.locator(".roll-keyboard").evaluate(e=>e.getBoundingClientRect().x);await page.locator("#scorePaper").evaluate(e=>e.scrollLeft=180);await expect.poll(()=>page.locator(".roll-keyboard").evaluate(e=>e.getBoundingClientRect().x)).toBeCloseTo(keyboardX,0);const alignment=async()=>page.evaluate(()=>{const key=document.querySelector('.roll-key[data-pitch="60"]')!.getBoundingClientRect(),row=document.querySelector('.roll-row[data-pitch="60"]')!.getBoundingClientRect();return{delta:Math.abs(key.top-row.top),keyHeight:key.height,rowHeight:row.height};});expect((await alignment()).delta).toBeLessThan(.6);await page.locator("#pitchIn").click();const taller=await alignment();expect(taller.delta).toBeLessThan(.6);expect(taller.keyHeight).toBeGreaterThan(18);await page.locator("#pitchFit").click();expect((await alignment()).delta).toBeLessThan(.6);expect(await page.evaluate(()=>[...document.querySelectorAll('.roll-key-label:not([hidden])')].every(label=>{const r=label.getBoundingClientRect(),key=label.parentElement!.getBoundingClientRect();return r.left>=key.left&&r.right<=document.querySelector('.roll-keyboard')!.getBoundingClientRect().right+1&&r.top>=key.top-1&&r.bottom<=key.bottom+1;}))).toBe(true);
  const sourceNotes=page.locator('.roll-note[data-note-id]');await sourceNotes.first().click();await page.locator("#selectMode").click();await sourceNotes.nth(1).click();
  const selected=await page.evaluate(()=>(window as any).__wavyTest.selection());expect(selected.ranges.length).toBeGreaterThan(0);
  await expect(page.locator("#selectionStart")).toBeVisible();await expect(page.locator("#selectionEnd")).toBeVisible();const handle=await page.locator("#selectionEnd").boundingBox(),target=await sourceNotes.last().boundingBox();await page.mouse.move(handle!.x+22,handle!.y+22);await page.mouse.down();await page.mouse.move(target!.x+target!.width/2,target!.y+target!.height/2);await page.mouse.up();const adjusted=await page.evaluate(()=>(window as any).__wavyTest.selection());expect(adjusted).not.toEqual(selected);
  await page.locator("#notationButton").click();expect(await page.evaluate(()=>(window as any).__wavyTest.selection())).toEqual(adjusted);await expect(page.locator("#notation .wavy-selected")).not.toHaveCount(0);
  await page.locator("#rollButton").click();await expect(page.locator("#roll .wavy-selected")).not.toHaveCount(0);await expect(page.locator("#roll .wavy-cursor")).not.toHaveCount(0);
});

test("piano roll shares cancellable pinch-to-pan touch gestures with notation", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "real CDP touch input needs the phone project");
  await page.setViewportSize({width:390,height:760});await page.setContent(await renderWavyPreview(fixture()));await page.locator("#rollButton").click();await page.waitForTimeout(50);
  expect(await page.evaluate(()=>{const viewport=(window as any).piWebPreview?.viewport?.visible||{top:0,bottom:innerHeight},paper=document.querySelector("#scorePaper")!.getBoundingClientRect();return [...document.querySelectorAll("#roll .roll-note")].some(note=>{const rect=note.getBoundingClientRect();return rect.right>paper.left&&rect.left<paper.right&&rect.bottom>Math.max(paper.top,viewport.top)&&rect.top<Math.min(paper.bottom,viewport.bottom);});})).toBe(true);
  await page.locator("#scorePaper").scrollIntoViewIfNeeded();const paper=await page.locator("#scorePaper").boundingBox();expect(paper).toBeTruthy();const visibleNote=await page.locator("#roll .roll-note").evaluateAll((items,paperBox)=>items.map(item=>item.getBoundingClientRect()).filter(rect=>rect.top>=paperBox.y&&rect.bottom<=paperBox.y+paperBox.height).map(rect=>({top:rect.top,bottom:rect.bottom,height:rect.height}))[0],paper!);expect(visibleNote).toBeTruthy();const client=await page.context().newCDPSession(page),cx=paper!.x+paper!.width*.55,cy=visibleNote!.top+visibleNote!.height/2;
  const keyboardX=await page.locator(".roll-keyboard").evaluate(e=>e.getBoundingClientRect().x);await page.locator("#scorePaper").evaluate(e=>e.scrollLeft+=120);expect(await page.locator(".roll-keyboard").evaluate(e=>e.getBoundingClientRect().x)).toBeCloseTo(keyboardX,0);const geometry=()=>page.locator(".roll-note").first().evaluate(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height};}),before=await geometry();
  await page.locator("#pitchIn").click();const vertical=await geometry();expect(vertical.height).toBeGreaterThan(before.height*1.1);expect(vertical.width).toBeCloseTo(before.width,1);await page.locator("#pitchFit").click();expect((await geometry()).height).toBeCloseTo(before.height,0);
  const focalBefore=await page.evaluate(({cy})=>{const paper=document.querySelector("#scorePaper")!,r=paper.getBoundingClientRect();return(paper.scrollTop+cy-r.top-28)/(window as any).__wavyTest.rowHeight();},{cy});
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:21,x:cx-35,y:cy-20},{id:22,x:cx+35,y:cy+20}]});await client.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{id:21,x:cx-75,y:cy-45},{id:22,x:cx+75,y:cy+45}]});
  const pinched=await geometry();expect(await page.evaluate(()=>(window as any).__wavyTest.rollZoom())).toBeGreaterThan(2);expect(pinched.width).toBeGreaterThan(before.width*1.5);expect(pinched.height).toBeGreaterThan(before.height*1.5);const focalAfter=await page.evaluate(({cy})=>{const paper=document.querySelector("#scorePaper")!,r=paper.getBoundingClientRect();return(paper.scrollTop+cy-r.top-28)/(window as any).__wavyTest.rowHeight();},{cy});expect(focalAfter).toBeCloseTo(focalBefore,0);
  const ids=await page.evaluate(()=>(window as any).__wavyTest.rollGesture().pointerIds);await page.locator("#rollContent").dispatchEvent("pointerup",{pointerId:ids[0],pointerType:"touch",clientX:cx-75,clientY:cy-45});expect(await page.evaluate(()=>(window as any).__wavyTest.rollGesture().mode)).toBe("tap-pan");const panFrom=await page.locator("#scorePaper").evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));await page.locator("#rollContent").dispatchEvent("pointermove",{pointerId:ids[1],pointerType:"touch",clientX:cx+120,clientY:cy+120});const panned=await page.locator("#scorePaper").evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));expect(Math.abs(panned.x-panFrom.x)).toBeGreaterThan(20);expect(Math.abs(panned.y-panFrom.y)).toBeGreaterThan(20);await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  const cursorBefore=await page.locator("#roll .wavy-cursor").count();await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{id:23,x:cx,y:cy}]});await client.send("Input.dispatchTouchEvent",{type:"touchCancel",touchPoints:[]});expect(await page.locator("#roll .wavy-cursor").count()).toBe(cursorBefore);
  await page.locator("#zoomReset").click();expect(await page.evaluate(()=>(window as any).__wavyTest.rollZoom())).toBe(1);await page.locator("#pitchFit").click();expect(await page.evaluate(()=>{const paper=document.querySelector("#scorePaper")!.getBoundingClientRect(),notes=[...document.querySelectorAll("#roll .roll-note")].map(e=>e.getBoundingClientRect());return notes.every(r=>r.top>=paper.top-1&&r.bottom<=paper.bottom+1);})).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test("canonical bar labels count multimeasure rests instead of ABCJS visual measures", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one canonical adapter run is sufficient");
  const abc=`X:1\nM:4/4\nL:1/8\nQ:1/4=120\nV:Vocal\nK:C\n[V:Vocal] Z19|C8|`;
  await page.setContent(await renderWavyPreview(fixture(abc)));
  const note=(await page.evaluate(()=>(window as any).__wavyTest.notes())).find((item:any)=>item.pitches.includes(60));
  expect(note.measure).toBe(19);
  const selectable=page.locator("#notation .abcjs-note").last();await selectable.click({force:true});await page.locator("#selectMode").click();
  expect((await page.evaluate(()=>(window as any).__wavyTest.selection())).label).toContain("Bar 20");
});

test("pending piano loading is immediately stoppable and cancelled by recording selection", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  await page.evaluate(() => {
    (window as any).__loads = [];
    (window as any).piWebPreview = { version: 1, hosted: true, assets: [], theme: { tokens: {}, colorScheme: "dark", density: "comfortable" }, onThemeChange() {}, loadAsset(id: string, options: any = {}) {
      const item: any = { id, aborted: false }; (window as any).__loads.push(item);
      return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => { item.aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
    } };
  });
  await page.setContent(await renderWavyPreview(fixture()));
  await page.locator("#scorePlay").click();
  await expect(page.locator("#scorePlay")).toHaveText("Pause");
  await page.locator("#takeSelect").selectOption("0");
  await page.locator("#loadRecording").click();
  await expect(page.locator("#scorePlay")).toHaveText("Play");
  await expect.poll(() => page.evaluate(() => (window as any).__loads.filter((x: any) => x.id.startsWith("piano-")).every((x: any) => x.aborted))).toBe(true);
  expect(await page.evaluate(() => (window as any).__loads.filter((x: any) => x.id.startsWith("recording-")).length)).toBe(1);
});

test("recording selection is local, lazy, switchable, and disabled without audio", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  const project = fixture();
  project.index.takes.push({ id: "failed", revision: 2, createdAt: "2025-01-03T00:00:00Z", status: "error", seed: 3, precision: "4bit", request: ref("unicode.wavy.d/failed.json"), error: "Generation failed" });
  await page.evaluate(() => {
    (window as any).__loads = [];
    (window as any).piWebPreview = { version: 1, theme: { tokens: {} }, onThemeChange() {}, async loadAsset(id: string) {
      (window as any).__loads.push(id); return new Blob(["audio"]);
    } };
  });
  await page.setContent(await renderWavyPreview(project));
  await expect(page.locator("#takeSelect")).toHaveValue("1");
  expect(await page.evaluate(() => (window as any).__loads)).toEqual([]);
  await page.locator("#loadRecording").click();
  await expect.poll(() => page.evaluate(() => (window as any).__loads)).toEqual(["recording-1"]);
  await page.locator("#takeSelect").selectOption("0");
  await expect(page.locator("#selectedTakeWarnings")).toContainText("Older revision");
  await expect(page.locator("#recording")).toBeHidden();
  await page.locator("#takeSelect").selectOption("2");
  await expect(page.locator("#loadRecording")).toBeDisabled();
  await expect(page.locator("#selectedTakeMeta")).toHaveText("Revision 2 · error");
  await expect(page.locator("#selectedTakeWarnings")).toContainText("Generation failed");
  expect(await page.evaluate(() => (window as any).__loads)).toEqual(["recording-1"]);
});

test("authenticated core rejects native audio in opaque inline and expanded sandboxes", async ({ page }, info) => {
  test.skip(process.env.PI_WEB_E2E_AUTH !== "1" || info.project.name !== "desktop", "run with PI_WEB_E2E_AUTH=1 on Chromium");
  const dir = join(process.cwd(), ".pi/web/artifacts/wavy-e2e");
  await mkdir(dir, { recursive: true });
  const wav = Buffer.alloc(8044, 128); wav.write("RIFF"); wav.writeUInt32LE(8036, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(8000, 40);
  await writeFile(join(dir, "tone.wav"), wav);
  await page.goto("/?token=test-secret");
  await expect(page.locator("#statusTitle")).toBeVisible();
  const statuses: number[] = [];
  page.on("response", response => { if (response.url().endsWith("/wavy-e2e/tone.wav")) statuses.push(response.status()); });
  await page.evaluate(() => {
    for (const id of ["inline", "expanded"]) {
      const frame = document.createElement("iframe"); frame.id = id; frame.sandbox.add("allow-scripts");
      frame.srcdoc = `<button id="play">Play</button><audio id="audio" preload="none" src="/api/artifacts/wavy-e2e/tone.wav"></audio>`;
      document.body.append(frame);
    }
  });
  for (const id of ["inline", "expanded"]) {
    const frame = page.frameLocator(`#${id}`);
    await frame.locator("#play").evaluate((button) => button.addEventListener("click", () => { const audio = document.querySelector("audio")!; audio.load(); void audio.play().catch(() => {}); }));
    await frame.locator("#play").click();
  }
  await expect.poll(async () => Promise.all(["inline", "expanded"].map(id => page.frameLocator(`#${id}`).locator("audio").evaluate((audio: HTMLAudioElement) => audio.error?.code || 0)))).toEqual([4, 4]);
  // Chromium blocks these opaque srcdoc media loads before an HTTP response;
  // a fresh request to the same real core route confirms the auth rejection.
  expect(statuses).toEqual([]);
  expect(await page.locator("iframe").evaluateAll(frames => frames.every(frame => frame.getAttribute("sandbox") === "allow-scripts"))).toBe(true);
  const anonymousContext = await request.newContext({ baseURL: info.project.use.baseURL as string });
  const anonymous = await anonymousContext.get("/api/artifacts/wavy-e2e/tone.wav");
  expect(anonymous.status()).toBe(401);
  await anonymousContext.dispose();
});

test("Wavy playback modes are mutually exclusive and standalone fallback is explicit", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one Chromium browser run is sufficient");
  await page.route("**/*.wav", route => route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(100)]) }));
  await page.setContent(await renderWavyPreview(fixture()));
  await page.locator("#scorePlay").click();
  await expect(page.locator("#scorePlay")).toHaveText("Pause");
  await page.evaluate(() => (window as any).__wavyTest.selectTake(0));
  await expect(page.locator("#scorePlay")).toHaveText("Play");
  expect(await page.locator("#recording").evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
});
