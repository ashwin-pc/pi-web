import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { WorkError } from "./workStore.js";

export function browserUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) throw new WorkError("Enter a web address");
  let url: URL; try { url = new URL(value); } catch { throw new WorkError("Enter a complete http or https address"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new WorkError("Browser addresses must use http or https without embedded credentials");
  return url.href;
}
function browserExecutable(defaultExecutable: string) {
  const explicit = process.env.PI_WEB_BROWSER_EXECUTABLE;
  if (explicit) return explicit;
  for (const path of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", defaultExecutable]) if (existsSync(path)) return path;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) for (const dir of readdirSync(cache).filter(dir => /^chromium-\d+$/.test(dir)).reverse()) {
    for (const executable of ["chrome-linux/chrome", "chrome-linux64/chrome"]) { const path = join(cache, dir, executable); if (existsSync(path)) return path; }
  }
  throw new WorkError("Install Chromium with npx playwright install chromium, or set PI_WEB_BROWSER_EXECUTABLE to your browser executable", 503);
}
type BrowserEntry = { id: string; workId: string; context: BrowserContext; page: Page; touched: number; queue: Promise<unknown> };
export class WorkspaceBrowser {
  private browser?: Promise<Browser>;
  private entries = new Map<string, BrowserEntry>();
  private timer = setInterval(() => { for (const entry of this.entries.values()) if (Date.now() - entry.touched > 30 * 60_000) void this.close(entry.workId, entry.id).catch(() => undefined); }, 60_000).unref();
  private launch() {
    if (!this.browser) {
      const proxy = process.env.PI_WEB_BROWSER_PROXY || process.env.HTTPS_PROXY;
      this.browser = import("playwright-core").then(({ chromium }) => chromium.launch({ executablePath: browserExecutable(chromium.executablePath()), headless: true, ...(proxy ? { proxy: { server: proxy, bypass: "localhost,127.0.0.1" } } : {}) })).catch(error => { this.browser = undefined; throw error; });
    }
    return this.browser;
  }
  async open(workId: string, url: string) {
    const target = browserUrl(url);
    if (this.entries.size >= 12) throw new WorkError("Close a browser page before opening another", 409);
    const context = await (await this.launch()).newContext({ viewport: { width: 1280, height: 800 } });
    await context.route(/^(?:file|ftp):/, route => route.abort());
    const page = await context.newPage(), id = randomUUID();
    this.entries.set(id, { id, workId, context, page, touched: Date.now(), queue: Promise.resolve() });
    try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 }); return await this.snapshot(workId, id); }
    catch (error) { await this.close(workId, id); throw error; }
  }
  private require(workId: string, id: string) { const entry = this.entries.get(id); if (!entry || entry.workId !== workId) throw new WorkError("This browser page is unavailable in this work", 404); entry.touched = Date.now(); return entry; }
  validate(workId: string, id: string) { this.require(workId, id); }
  async snapshot(workId: string, id: string) {
    const entry = this.require(workId, id), page = entry.page;
    const image = await page.screenshot({ type: "jpeg", quality: 75 });
    const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    return { id, workId, url: page.url(), title: await page.title(), width: 1280, height: 800, text: text.slice(0, 24_000), image: image.toString("base64") };
  }
  action(workId: string, id: string, input: Record<string, unknown>) {
    const entry = this.require(workId, id);
    const result = entry.queue.then(async () => {
      const page = entry.page, action = input.action;
      if (action === "navigate") await page.goto(browserUrl(input.url), { waitUntil: "domcontentloaded", timeout: 20_000 });
      else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
      else if (action === "reload") await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      else if (action === "click") {
        if (typeof input.selector === "string" && input.selector.length <= 2000) await page.locator(input.selector).first().click({ timeout: 5000 });
        else if (typeof input.x === "number" && typeof input.y === "number" && input.x >= 0 && input.x <= 1280 && input.y >= 0 && input.y <= 800) await page.mouse.click(input.x, input.y);
        else throw new WorkError("A click target is required");
      } else if (action === "type") {
        if (typeof input.text !== "string" || input.text.length > 16_000) throw new WorkError("Text is required (maximum 16,000 characters)");
        if (typeof input.selector === "string" && input.selector.length <= 2000) await page.locator(input.selector).first().fill(input.text, { timeout: 5000 });
        else await page.keyboard.insertText(input.text);
      } else if (action !== "inspect") throw new WorkError("Unknown browser action");
      return this.snapshot(workId, id);
    });
    entry.queue = result.catch(() => undefined); return result;
  }
  async close(workId: string, id: string) { const entry = this.require(workId, id); this.entries.delete(id); await entry.context.close(); }
  async dispose() { clearInterval(this.timer); for (const entry of [...this.entries.values()]) await this.close(entry.workId, entry.id); if (this.browser) await (await this.browser).close(); }
}
