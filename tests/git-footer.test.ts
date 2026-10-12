import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitFooterExtension } from "../examples/pi-web-extensions/git-footer.js";

type Result = { ok: boolean; output: string; notRepo?: boolean };
type Runner = (args: string[], cwd: string) => Promise<Result>;
const stops: Array<() => void> = [];
const dirs: string[] = [];
let nextId = 0;
function mount(git?: Runner, cwd = "/example", factory = createGitFooterExtension) {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const contribute = vi.fn();
  const ctx = { cwd, sessionManager: { getSessionId: () => `footer-test-${nextId++}` }, ui: { web: { contribute } } };
  // Session ids must remain stable through shutdown and events.
  const id = ctx.sessionManager.getSessionId();
  ctx.sessionManager.getSessionId = () => id;
  factory({ git, refreshMs: 2_500 })({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
  const emit = (event: string, context = ctx) => handlers.get(event)?.({}, context);
  const stop = () => emit("session_shutdown");
  stops.push(stop);
  emit("session_start");
  return { ctx, contribute, emit, stop, html: () => contribute.mock.calls.at(-1)?.[1]?.view?.html as string | undefined };
}
const status = (extra = "", branch = "main") => `# branch.oid abcdef0123456789\0# branch.head ${branch}\0${extra}`;
const upstream = (ahead = 0, behind = 0, name = "upstream/main") => `# branch.upstream ${name}\0# branch.ab +${ahead} -${behind}\0`;
const ok = (output = status()) => ({ ok: true, output });
async function flush() { await vi.advanceTimersByTimeAsync(0); }
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "git-footer-"));
  dirs.push(dir);
  return dir;
}
function gitCommand(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git footer porcelain v2 regression and command budget", () => {
  it.each([[0, 0], [3, 0], [0, 2], [3, 2]])("renders compact tracking counts +%i -%i without inline upstream text", async (ahead, behind) => {
    vi.useFakeTimers();
    const runner = vi.fn(async () => ok(status(upstream(ahead, behind))));
    const footer = mount(runner);
    await flush();
    expect(runner).toHaveBeenCalledExactlyOnceWith(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], "/example");
    const html = footer.html()!;
    const visible = html.replace(/<[^>]*>/g, "");
    expect(visible).toContain("main");
    expect(visible).toContain(ahead || behind ? [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean).join(" ") : "✓");
    expect(visible).not.toMatch(/dirty|clean/);
    expect(html).toContain(`${ahead} ahead, ${behind} behind`);
    expect(visible).not.toContain("upstream/main");
    expect(visible).not.toContain("up to date");
    expect(html).toContain("upstream/main");
    expect(html).toMatch(/last fetched|locally fetched/i);
    expect(html).toMatch(/no network|never fetch/);
    expect(html).toContain("aria-label=");
  });

  it.each([
    [status(), "main"],
    [status("", "(detached)"), "abcdef0"],
    ["# branch.oid (initial)\0# branch.head newborn\0", "newborn"],
  ])("supports no upstream, detached and unborn branches", async (output, label) => {
    vi.useFakeTimers();
    const footer = mount(async () => ok(output));
    await flush();
    expect(footer.html()).toContain(label);
    expect(footer.html()).not.toContain("↑");
    expect(footer.html()).not.toContain("✓");
  });

  it("counts dirty records, not newlines or rename source filenames", async () => {
    vi.useFakeTimers();
    const output = status([
      "1 A. N... 100644 100644 100644 a b added\0",
      "1 .M N... 100644 100644 100644 a b newline\n? fake\0",
      "1 .D N... 100644 100644 100644 a b deleted\0",
      "2 R. N... 100644 100644 100644 a b R100 renamed\0? source\n1 A. not a record\0",
      "u UU N... 100644 100644 100644 100644 a b c conflict\0",
      "? quotes\" and tabs\tand newlines\n# branch.head fake\0",
      "! ignored\0",
    ].join(""));
    const footer = mount(async () => ok(output));
    await flush();
    expect(footer.html()).toContain("dirty (+1 ~2 -1 ?1)");
    expect(footer.html()!.replace(/<[^>]*>/g, "")).toContain("● (+1 ~2 -1 ?1)");
    expect(footer.html()!.replace(/<[^>]*>/g, "")).not.toContain("dirty");
    expect(footer.html()).toContain("main");
  });

  it("conflicts without categorized counts remain dirty", async () => {
    vi.useFakeTimers();
    const footer = mount(async () => ok(status("u UU N... a b c conflict\0")));
    await flush();
    expect(footer.html()).toContain("dirty");
    expect(footer.html()).not.toContain("● clean");
  });

  it("escapes branch/upstream in HTML and marks missing comparison unavailable", async () => {
    vi.useFakeTimers();
    const footer = mount(async () => ok(status("# branch.upstream origin/<bad>\0", "<branch>")));
    await flush();
    expect(footer.html()).toContain("&lt;branch&gt;");
    expect(footer.html()).toContain("origin/&lt;bad&gt;");
    expect(footer.html()).toContain("unavailable");
    expect(footer.html()!.replace(/<[^>]*>/g, "")).toContain("⇅?");
    expect(footer.html()).not.toContain("✓");
  });

  it("deduplicates concurrent sessions across extension factories, caches briefly, suppresses unchanged HTML", async () => {
    vi.useFakeTimers();
    let resolve!: (result: Result) => void;
    const runner = vi.fn(() => new Promise<Result>((done) => { resolve = done; }));
    const footers = Array.from({ length: 20 }, () => mount(runner));
    for (const footer of footers) footer.emit("turn_end");
    expect(runner).toHaveBeenCalledTimes(1);
    resolve(ok(status(upstream(2, 1))));
    await flush();
    for (const footer of footers) expect(footer.contribute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    for (const footer of footers) footer.emit("turn_start");
    await flush();
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    for (const footer of footers) footer.emit("turn_end");
    expect(runner).toHaveBeenCalledTimes(2);
    resolve(ok(status(upstream(2, 1))));
    await flush();
    for (const footer of footers) expect(footer.contribute).toHaveBeenCalledTimes(1);
  });

  it("keeps cwd caches separate and interval polling shares one subprocess per cwd", async () => {
    vi.useFakeTimers();
    const runner = vi.fn(async () => ok());
    mount(runner, "/one"); mount(runner, "/one"); mount(runner, "/two");
    await flush();
    expect(runner).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(runner).toHaveBeenCalledTimes(8); // 2 cwds × (initial + 3 ticks)
  });

  it.each(["failed result", "throw", "incomplete output"])("retains good HTML on %s and retries immediately", async (failure) => {
    vi.useFakeTimers();
    const runner = vi.fn(async (): Promise<Result> => ok(status(upstream())));
    const footer = mount(runner);
    await flush();
    const good = footer.html();
    await vi.advanceTimersByTimeAsync(1_001);
    runner.mockImplementationOnce(async () => {
      if (failure === "throw") throw new Error("git failed");
      return failure === "incomplete output" ? ok("") : { ok: false, output: "" };
    });
    footer.emit("turn_end"); await flush();
    expect(footer.html()).toBe(good);
    expect(footer.contribute).toHaveBeenCalledTimes(1);
    runner.mockImplementationOnce(async () => ok(status(upstream(1, 0))));
    footer.emit("turn_end"); await flush();
    expect(runner).toHaveBeenCalledTimes(3);
    expect(footer.html()).toContain("↑1");
    expect(footer.html()).not.toContain("↓0");
  });

  it("shows and caches a nonrepo result, but retries generic failures", async () => {
    vi.useFakeTimers();
    const runner = vi.fn(async () => ({ ok: false, output: "", notRepo: true }));
    const footer = mount(runner);
    await flush();
    expect(footer.html()).toContain("no git repo");
    footer.emit("input"); await flush();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rebinds an in-flight refresh to a replacement runtime without publishing to the old one", async () => {
    vi.useFakeTimers();
    let resolve!: (result: Result) => void;
    const runner = vi.fn(() => new Promise<Result>((done) => { resolve = done; }));
    const footer = mount(runner);
    const contribute = vi.fn();
    const replacement = { ...footer.ctx, sessionManager: { getSessionId: footer.ctx.sessionManager.getSessionId }, ui: { web: { contribute } } };
    footer.emit("session_start", replacement);
    resolve(ok()); await flush();
    expect(footer.contribute).not.toHaveBeenCalled();
    expect(contribute).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    footer.stop(); // Stale shutdown must not clear the replacement runtime.
    expect(contribute).toHaveBeenCalledTimes(1);
    footer.emit("session_shutdown", replacement);
    expect(contribute.mock.calls.at(-1)).toEqual(["local-git-footer", undefined]);
  });

  it("uses session-manager cwd and refreshes when its cwd changes", async () => {
    vi.useFakeTimers();
    const runner = vi.fn(async (_args: string[], cwd: string) => ok(status("", cwd === "/new" ? "new-branch" : "main")));
    const footer = mount(runner);
    await flush();
    Object.assign(footer.ctx.sessionManager, { getCwd: () => "/new" });
    footer.emit("session_before_switch"); await flush();
    expect(runner).toHaveBeenLastCalledWith(expect.any(Array), "/new");
    expect(footer.html()).toContain("new-branch");
  });

  it("does not publish late results after shutdown", async () => {
    vi.useFakeTimers();
    let resolve!: (result: Result) => void;
    const footer = mount(() => new Promise((done) => { resolve = done; }));
    footer.stop();
    resolve(ok()); await flush();
    expect(footer.contribute.mock.calls).toEqual([["local-git-footer", undefined]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(footer.contribute).toHaveBeenCalledTimes(1);
  });
});

describe("git footer subprocess bounds", () => {
  it.each([{ killed: true }, { signal: "SIGKILL" }])("recovers on the next refresh after timeout %j, shares cooldown across module loads and retries counts later", async (failure) => {
    vi.useFakeTimers();
    const execute = vi.fn(async (_command: string, args: string[]) => ({
      stdout: status(args.includes("--no-ahead-behind")
        ? "# branch.upstream upstream/main\0# branch.ab +? -?\0? new-file\0"
        : upstream(2, 1)),
      stderr: "",
    })).mockRejectedValueOnce(failure);
    const mockedExecFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: mockedExecFile }));
    try {
      const cwd = temp();
      const firstModule = await import("../examples/pi-web-extensions/git-footer.js");
      const first = mount(undefined, cwd, firstModule.createGitFooterExtension);
      await flush();
      expect(execute).toHaveBeenCalledTimes(1); // No immediate second subprocess.
      expect(first.html()).toBeUndefined();
      vi.resetModules();
      const secondModule = await import("../examples/pi-web-extensions/git-footer.js");
      const second = mount(undefined, cwd, secondModule.createGitFooterExtension);
      await flush();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1][1]).toContain("--no-ahead-behind");
      expect(second.html()).toContain("main");
      expect(second.html()).toContain("⇅?");
      expect(second.html()).toContain("dirty (?1)");
      first.emit("turn_end"); await flush();
      expect(execute).toHaveBeenCalledTimes(2); // Shared fallback result cache.
      expect(first.html()).toContain("⇅?");
      first.stop(); second.stop();
      await vi.advanceTimersByTimeAsync(30_001);
      const recovered = mount(undefined, cwd, firstModule.createGitFooterExtension);
      await flush();
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls[2][1]).not.toContain("--no-ahead-behind");
      expect(recovered.html()).toContain("↑2 ↓1");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("sets a timeout, kill signal, output cap, stable diagnostic locale and disables optional locks", async () => {
    const execute = vi.fn(async () => ({ stdout: status(), stderr: "" }));
    const mockedExecFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: mockedExecFile }));
    try {
      const module = await import("../examples/pi-web-extensions/git-footer.js");
      const cwd = temp();
      const footer = mount(undefined, cwd, module.createGitFooterExtension);
      await vi.waitFor(() => expect(footer.html()).toContain("main"));
      expect(execute).toHaveBeenCalledExactlyOnceWith("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], {
        cwd, env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("git footer real local refs", () => {
  it("reads a real diverged upstream and edge-case filenames without fetching", async () => {
    const cwd = temp();
    gitCommand(cwd, "init", "-b", "main");
    gitCommand(cwd, "config", "user.name", "Footer Test");
    gitCommand(cwd, "config", "user.email", "footer@example.test");
    writeFileSync(join(cwd, "base"), "base");
    gitCommand(cwd, "add", "."); gitCommand(cwd, "commit", "-m", "base");
    gitCommand(cwd, "remote", "add", "upstream", "/does-not-exist-no-network");
    gitCommand(cwd, "checkout", "-b", "remote-work");
    writeFileSync(join(cwd, "remote"), "remote");
    gitCommand(cwd, "add", "."); gitCommand(cwd, "commit", "-m", "remote");
    gitCommand(cwd, "update-ref", "refs/remotes/upstream/main", "HEAD");
    gitCommand(cwd, "checkout", "main");
    gitCommand(cwd, "branch", "--set-upstream-to", "upstream/main");
    writeFileSync(join(cwd, "local"), "local");
    gitCommand(cwd, "add", "."); gitCommand(cwd, "commit", "-m", "local");
    writeFileSync(join(cwd, 'odd\n? fake\t"file'), "untracked");
    gitCommand(cwd, "mv", "base", 'renamed\n? fake');
    const footer = mount(undefined, cwd);
    await vi.waitFor(() => expect(footer.html()).toContain("↑1 ↓1"));
    expect(footer.html()).toContain("dirty (~1 ?1)");
    expect(gitCommand(cwd, "rev-parse", "refs/remotes/upstream/main")).not.toBe(gitCommand(cwd, "rev-parse", "HEAD"));
  });

  it("uses the process-wide default cache across independent module loads", async () => {
    const cwd = temp();
    gitCommand(cwd, "init", "-b", "first");
    const first = mount(undefined, cwd);
    await vi.waitFor(() => expect(first.html()).toContain("first"));
    gitCommand(cwd, "symbolic-ref", "HEAD", "refs/heads/changed");
    vi.resetModules();
    const otherModule = await import("../examples/pi-web-extensions/git-footer.js");
    const second = mount(undefined, cwd, otherModule.createGitFooterExtension);
    await vi.waitFor(() => expect(second.html()).toContain("first"));
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    second.emit("input");
    await vi.waitFor(() => expect(second.html()).toContain("changed"));
  });

  it("treats a bare repository as no working-tree repo", async () => {
    const cwd = temp();
    gitCommand(cwd, "init", "--bare");
    const footer = mount(undefined, cwd);
    await vi.waitFor(() => expect(footer.html()).toContain("no git repo"));
  });

  it("recognizes a real nonrepo directory", async () => {
    const footer = mount(undefined, temp());
    await vi.waitFor(() => expect(footer.html()).toContain("no git repo"));
  });
});
