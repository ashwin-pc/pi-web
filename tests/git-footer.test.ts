import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitFooterExtension, runFetchGit, runFetchProcess, safeFetchDestination } from "../examples/pi-web-extensions/git-footer.js";

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
    expect(html).toContain("Automatic fetch disabled; no network fetching");
    expect(html).toContain("Never pulls");
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
    const statusCalls = () => execute.mock.calls.filter(([, args]) => args.includes("status"));
    const mockedExecFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: mockedExecFile }));
    try {
      const cwd = temp();
      const firstModule = await import("../examples/pi-web-extensions/git-footer.js");
      const first = mount(undefined, cwd, firstModule.createGitFooterExtension);
      await flush();
      expect(statusCalls()).toHaveLength(1); // No immediate second subprocess.
      expect(first.html()).toBeUndefined();
      vi.resetModules();
      const secondModule = await import("../examples/pi-web-extensions/git-footer.js");
      const second = mount(undefined, cwd, secondModule.createGitFooterExtension);
      await flush();
      expect(statusCalls()).toHaveLength(2);
      expect(statusCalls()[1][1]).toContain("--no-ahead-behind");
      expect(second.html()).toContain("main");
      expect(second.html()).toContain("⇅?");
      expect(second.html()).toContain("dirty (?1)");
      first.emit("turn_end"); await flush();
      expect(statusCalls()).toHaveLength(2); // Shared fallback result cache.
      expect(first.html()).toContain("⇅?");
      first.stop(); second.stop();
      await vi.advanceTimersByTimeAsync(30_001);
      const recovered = mount(undefined, cwd, firstModule.createGitFooterExtension);
      await flush();
      expect(statusCalls()).toHaveLength(3);
      expect(statusCalls()[2][1]).not.toContain("--no-ahead-behind");
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

describe("git footer fetch policy", () => {
  it("explicit opt-out overrides fetch injection and does no discovery across refreshes", async () => {
    vi.useFakeTimers();
    const git = vi.fn(async () => ok(status(upstream())));
    const fetchGit = vi.fn(async () => ok());
    const footer = mount(git, "/opt-out", options => createGitFooterExtension({ ...options, fetchGit, autoFetch: false }));
    await flush();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(fetchGit).not.toHaveBeenCalled();
    expect(git.mock.calls.length).toBeGreaterThan(1);
    expect(footer.html()).toContain("Automatic fetch disabled; no network fetching");
  });

  it("does not reuse opt-in cached HTML or schedule work for opt-out instances", async () => {
    vi.useFakeTimers();
    const git = async () => ok(status(upstream()));
    const fetchGit = vi.fn(async () => ok());
    const enabled = mount(git, "/policy", options => createGitFooterExtension({ ...options, fetchGit, autoFetch: true }));
    await flush();
    expect(enabled.html()).toContain("counts may be stale");
    expect(enabled.html()).toContain("Automatic fetch attempts");
    fetchGit.mockClear();
    const disabled = mount(git, "/policy", options => createGitFooterExtension({ ...options, fetchGit, autoFetch: false }));
    await flush();
    expect(disabled.html()).toContain("Automatic fetch disabled");
    expect(fetchGit).not.toHaveBeenCalled();
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

  it.each(["refs/remotes/origin/main", "refs/remotes/custom/main"])("refreshes %s without applying configured mappings to local branches", async tracking => {
    const remote = temp(), cwd = temp();
    gitCommand(remote, "init", "-b", "main");
    gitCommand(remote, "config", "user.name", "Footer Test");
    gitCommand(remote, "config", "user.email", "footer@example.test");
    writeFileSync(join(remote, "base"), "base");
    gitCommand(remote, "add", "."); gitCommand(remote, "commit", "-m", "base");
    gitCommand(cwd, "clone", remote, ".");
    gitCommand(cwd, "branch", "victim");
    const original = gitCommand(cwd, "rev-parse", "victim");
    gitCommand(cwd, "update-ref", tracking, original);
    gitCommand(cwd, "config", "remote.origin.fetch", `+refs/heads/main:${tracking}`);
    gitCommand(cwd, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/victim");
    writeFileSync(join(remote, "base"), "advanced");
    gitCommand(remote, "commit", "-am", "advance");
    const advanced = gitCommand(remote, "rev-parse", "HEAD");
    mount(undefined, cwd, options => createGitFooterExtension({ ...options, autoFetch: true }));
    await vi.waitFor(() => expect(gitCommand(cwd, "rev-parse", tracking)).toBe(advanced));
    expect(gitCommand(cwd, "rev-parse", "victim")).toBe(original);
    // Let fetch completion invalidate its cache before the next cache-only test.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("preserves core.sshCommand instead of overriding its trusted transport", async () => {
    const cwd = temp();
    gitCommand(cwd, "init", "-b", "main");
    gitCommand(cwd, "config", "user.name", "Footer Test");
    gitCommand(cwd, "config", "user.email", "footer@example.test");
    writeFileSync(join(cwd, "base"), "base");
    gitCommand(cwd, "add", "."); gitCommand(cwd, "commit", "-m", "base");
    gitCommand(cwd, "remote", "add", "origin", "ssh://example.invalid/repository");
    gitCommand(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    gitCommand(cwd, "branch", "--set-upstream-to", "origin/main");
    const marker = join(cwd, "ssh-invoked");
    const wrapper = join(cwd, "ssh-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\n{
  printf 'agent=%s\\naskpass=%s\\nrequire=%s\\ndisplay=%s\\n' "$SSH_AUTH_SOCK" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE" "$DISPLAY"
  if test -t 0; then echo stdin=tty; else echo stdin=closed; fi
  if (exec </dev/tty) 2>/dev/null; then echo controlling=tty; else echo controlling=none; fi
  git config --get-all credential.helper
} > '${marker}'\nexit 1\n`);
    gitCommand(cwd, "config", "core.sshCommand", `sh '${wrapper}'`);
    const localOnly = mount(undefined, cwd);
    await vi.waitFor(() => expect(localOnly.html()).toContain("Automatic fetch disabled"));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(marker)).toBe(false);
    localOnly.stop();
    mount(undefined, cwd, options => createGitFooterExtension({ ...options, autoFetch: true }));
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    await vi.waitFor(() => expect(readFileSync(marker, "utf8")).toContain("controlling=none"));
    const environment = readFileSync(marker, "utf8");
    expect(environment).toContain("agent=\naskpass=\nrequire=never\ndisplay=\n");
    expect(environment).toContain("stdin=closed");
    await new Promise((resolve) => setTimeout(resolve, 100));
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


describe("automatic upstream fetch", () => {
  function setup(fetch: Runner, cwd = "/repo", upstreamText = upstream()) {
    const runner = vi.fn(async () => ok(status(upstreamText)));
    const factory = (options: Parameters<typeof createGitFooterExtension>[0]) => createGitFooterExtension({ ...options, fetchGit: fetch });
    return { footer: mount(runner, cwd, factory), runner, factory };
  }
  function fetchRunner(result: Result = ok()) {
    return vi.fn(async (args: string[]) => args[0] === "rev-parse" ? ok("/shared/.git")
      : args[0] === "for-each-ref" ? ok("origin\0refs/heads/main\0refs/remotes/origin/main\n") : result);
  }
  it("fetches only the configured remote, deduplicates worktrees and polls every minute", async () => {
    vi.useFakeTimers();
    const fetch = fetchRunner();
    setup(fetch, "/repo/one"); setup(fetch, "/repo/two");
    await flush();
    const calls = () => fetch.mock.calls.filter(([args]) => args.includes("fetch"));
    expect(calls()).toHaveLength(1);
    expect(calls()[0][0]).toEqual(["-c", "credential.helper=", "-c", "credential.interactive=false", "-c", "core.askPass=", "fetch",
      "--refmap=", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--no-write-fetch-head", "--", "origin",
      "+refs/heads/main:refs/remotes/origin/main"]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_501);
    expect(calls()).toHaveLength(2);
  });
  it("aligns cwd retries with fetch completion instead of adding another minute", async () => {
    vi.useFakeTimers();
    const fetch = fetchRunner();
    fetch.mockImplementation(async (args) => {
      if (args[0] === "rev-parse") return ok("/shared/.git");
      if (args[0] === "for-each-ref") return ok("origin\0refs/heads/main\0refs/remotes/origin/main");
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return ok();
    });
    setup(fetch, "/repo/one"); setup(fetch, "/repo/two"); await flush();
    const calls = () => fetch.mock.calls.filter(([args]) => args.includes("fetch"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toHaveLength(2);
  });
  it("does no metadata or network work without an upstream", async () => {
    vi.useFakeTimers();
    const fetch = fetchRunner();
    setup(fetch, "/repo", "");
    await vi.advanceTimersByTimeAsync(125_000);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("backs failures off while status continues refreshing", async () => {
    vi.useFakeTimers();
    const fetch = fetchRunner({ ok: false, output: "" });
    const { runner } = setup(fetch);
    await flush();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetch.mock.calls.filter(([args]) => args.includes("fetch"))).toHaveLength(1);
    expect(runner.mock.calls.length).toBeGreaterThan(30);
    await vi.advanceTimersByTimeAsync(2_501);
    expect(fetch.mock.calls.filter(([args]) => args.includes("fetch"))).toHaveLength(2);
  });
  it("discovers a new branch upstream without inheriting the old branch backoff", async () => {
    vi.useFakeTimers();
    let branch = "first";
    const git = vi.fn(async () => ok(status(upstream(0, 0, `origin/${branch}`), branch)));
    const fetch = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return ok("/shared/.git");
      if (args[0] === "for-each-ref") return ok(`origin\0refs/heads/${branch}\0refs/remotes/origin/${branch}`);
      return args.at(-1)?.includes("first") ? { ok: false, output: "" } : ok();
    });
    const footer = mount(git, "/repo", options => createGitFooterExtension({ ...options, fetchGit: fetch }));
    await flush();
    await vi.advanceTimersByTimeAsync(850_000);
    expect(fetch.mock.calls.filter(([args]) => args.includes("fetch"))).toHaveLength(4);
    branch = "second";
    footer.emit("input");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch.mock.calls.some(([args]) => args.at(-1) === "+refs/heads/second:refs/remotes/origin/second")).toBe(true);
  });
  it("retains failure backoff when another repository reserves expired entries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (args: string[], cwd: string) => args[0] === "rev-parse" ? ok(`${cwd}/.git`)
      : args[0] === "for-each-ref" ? ok("origin\0refs/heads/main\0refs/remotes/origin/main") : { ok: false, output: "" });
    const first = setup(fetch, "/a"); await flush(); first.footer.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    const second = setup(fetch, "/b"); await flush(); second.footer.stop();
    const retry = setup(fetch, "/a"); await flush();
    const calls = () => fetch.mock.calls.filter(([args, cwd]) => args.includes("fetch") && cwd === "/a");
    expect(calls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(calls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toHaveLength(3);
    retry.footer.stop();
  });
  it("caps discovery concurrency across many repositories without blocking initialization", async () => {
    vi.useFakeTimers();
    const release: Array<(result: Result) => void> = [];
    const fetch = vi.fn(() => new Promise<Result>((resolve) => { release.push(resolve); }));
    const mounted = Array.from({ length: 20 }, (_, index) => setup(fetch, `/repository-${index}`));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const { footer } of mounted) expect(footer.html()).toContain("main");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Release discovery with an empty remote; neither admitted job fetches.
    release.splice(0).forEach((resolve) => resolve(ok("/shared/.git")));
    await flush();
    release.splice(0).forEach((resolve) => resolve(ok("")));
    await flush();
  });
  it("never overlaps a slow fetch, keeps status responsive, and retains dedupe after shutdown", async () => {
    vi.useFakeTimers();
    let finish!: (value: Result) => void;
    const fetch = fetchRunner();
    fetch.mockImplementation(async (args) => args[0] === "rev-parse" ? ok("/shared/.git")
      : args[0] === "for-each-ref" ? ok("origin\0refs/heads/main\0refs/remotes/origin/main") : new Promise<Result>((resolve) => { finish = resolve; }));
    const { footer, runner } = setup(fetch);
    await flush();
    expect(footer.html()).toContain("main");
    await vi.advanceTimersByTimeAsync(125_000);
    expect(runner.mock.calls.length).toBeGreaterThan(40);
    expect(fetch.mock.calls.filter(([args]) => args.includes("fetch"))).toHaveLength(1);
    footer.stop();
    setup(fetch, "/repo/other"); await flush();
    expect(fetch.mock.calls.filter(([args]) => args.includes("fetch"))).toHaveLength(1);
    finish(ok()); await flush();
  });
});


describe("real background fetch safety", () => {
  it("rejects symrefs and filesystem symlinks without advancing a local branch", async () => {
    const cwd = temp();
    gitCommand(cwd, "init", "-b", "main");
    gitCommand(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
    gitCommand(cwd, "branch", "victim");
    const before = gitCommand(cwd, "rev-parse", "victim");
    gitCommand(cwd, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/victim");
    expect(await safeFetchDestination(join(cwd, ".git"), "refs/remotes/origin/main", cwd)).toBe(false);
    expect((await runFetchGit(["fetch", "--refmap=", "--", ".", "+refs/heads/main:refs/remotes/origin/main"], cwd)).ok).toBe(false);
    expect(gitCommand(cwd, "rev-parse", "victim")).toBe(before);
    if (process.platform !== "win32") {
      mkdirSync(join(cwd, ".git/refs/remotes/linked"));
      symlinkSync("../../heads/victim", join(cwd, ".git/refs/remotes/linked/main"));
      expect(await safeFetchDestination(join(cwd, ".git"), "refs/remotes/linked/main", cwd)).toBe(false);
      symlinkSync("../heads", join(cwd, ".git/refs/remotes/alias"));
      expect(await safeFetchDestination(join(cwd, ".git"), "refs/remotes/alias/victim", cwd)).toBe(false);
    }
    expect(await safeFetchDestination(join(cwd, ".git"), "refs/remotes/origin/new", cwd)).toBe(true);
    expect((await runFetchGit(["fetch", "--refmap=", "--no-write-fetch-head", "--", ".", "+refs/heads/main:refs/remotes/origin/new"], cwd)).ok).toBe(true);
    expect(gitCommand(cwd, "rev-parse", "refs/remotes/origin/new")).toBe(before);
    expect(gitCommand(cwd, "for-each-ref", "refs/remotes/pi-web-fetch-")).toBe("");
    if (process.platform !== "win32") {
      gitCommand(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "newer");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      // Install a symref after the final validation, immediately before publish.
      writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = update-ref ] && [ "$2" = --no-deref ] && [ "$3" = refs/remotes/origin/new ]; then
  '${realGit}' symbolic-ref refs/remotes/origin/new refs/heads/victim
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath}`;
      try {
        expect((await runFetchGit(["fetch", "--refmap=", "--no-write-fetch-head", "--", ".", "+refs/heads/main:refs/remotes/origin/new"], cwd)).ok).toBe(true);
      } finally { process.env.PATH = oldPath; }
      expect(gitCommand(cwd, "rev-parse", "victim")).toBe(before);
      expect(gitCommand(cwd, "rev-parse", "refs/remotes/origin/new")).toBe(gitCommand(cwd, "rev-parse", "main"));
    }
  });

  it.skipIf(process.platform === "win32").each(["timeout", "output"])("kills a real transport descendant on %s", async mode => {
    const cwd = temp();
    gitCommand(cwd, "init");
    const pidFile = join(cwd, "child.pid");
    const wrapper = join(cwd, "transport.sh");
    // Ignore Git's SSH variant probe; the actual transport leaves an independent
    // child alive even if its parent Git is killed. No network is contacted.
    writeFileSync(wrapper, `#!/bin/sh
case " $* " in *" -G "*) exit 0;; esac
sleep 60 &
echo $! > '${pidFile}'
${mode === "output" ? 'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done' : 'wait'}
`, { mode: 0o755 });
    gitCommand(cwd, "config", "core.sshCommand", wrapper);
    const args = mode === "output" ? ["-c", `alias.footer-test=!${wrapper}`, "footer-test"]
      : ["fetch", "--", "ssh://invalid.example/repo", "main"];
    const result = await runFetchProcess(args, cwd, mode === "timeout" ? 500 : 3000, 4096);
    expect(result.ok).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // On Linux an unreaped zombie may still answer signal 0; it is not running.
    await vi.waitFor(() => {
      let alive = true;
      try {
        process.kill(pid, 0);
        if (existsSync(`/proc/${pid}/stat`)) alive = !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
      } catch { alive = false; }
      expect(alive).toBe(false);
    });
  });
});
