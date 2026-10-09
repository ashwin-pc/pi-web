import { describe, expect, it, vi } from "vitest";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "../src/extensions";
import githubRepoPanel from "../examples/pi-web-extensions/github-repo-panel";

const result = (code: number, stdout = "", stderr = "", killed = false) => ({ code, stdout, stderr, killed });

async function renderWith(gh: (args: string[]) => ReturnType<typeof result> | Promise<ReturnType<typeof result>>) {
  let touch: ((event: unknown, ctx: PiWebExtensionContext) => void) | undefined;
  const contribute = vi.fn();
  const exec = vi.fn(async (command: string, args: string[]) => {
    if (command === "gh") return gh(args);
    return result(0, args.includes("rev-parse") ? "true" : "remote.origin.url https://github.com/ashwin-pc/pi-web.git");
  });
  githubRepoPanel({ exec, on: (name: string, handler: typeof touch) => {
    if (name === "input") touch = handler;
  } } as unknown as PiWebExtensionAPI);
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "github-test" }, ui: { web: { contribute } } } as unknown as PiWebExtensionContext;
  touch!(undefined, ctx);
  await vi.waitFor(() => expect(contribute).toHaveBeenCalled());
  const tab = contribute.mock.calls[0][1];
  return { html: (await tab.render()).html as string, exec };
}

describe("GitHub repo panel CLI diagnostics", () => {
  it("replaces swallowed spawn failures with actionable server-side setup help", async () => {
    const { html, exec } = await renderWith(() => result(1));
    expect(html).toContain("GitHub CLI (gh) could not be started");
    expect(html).toContain("https://cli.github.com");
    expect(html).toContain("server&#39;s PATH");
    expect(html).toContain("gh auth login");
    expect(exec).toHaveBeenCalledWith("gh", ["--version"], expect.anything());
  });

  it("preserves real authentication errors without probing or switching APIs", async () => {
    const { html, exec } = await renderWith(() => result(4, "", "To get started with GitHub CLI, please run: gh auth login"));
    expect(html).toContain("please run: gh auth login");
    expect(exec.mock.calls.filter(([command, args]) => command === "gh" && args[0] === "--version")).toHaveLength(0);
  });

  it("does not claim gh is missing when it runs but fails silently", async () => {
    const { html } = await renderWith((args) => args[0] === "--version" ? result(0, "gh version 2.102.0") : result(1));
    expect(html).toContain("exit code 1, no diagnostic output");
    expect(html).toContain("gh auth status");
    expect(html).not.toContain("could not be started");
  });

  it("distinguishes timeout from missing CLI", async () => {
    const { html } = await renderWith(() => result(1, "", "", true));
    expect(html).toContain("timed out after 15s");
    expect(html).not.toContain("could not be started");
  });

  it("handles runtimes that reject with ENOENT", async () => {
    const { html } = await renderWith(() => Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })));
    expect(html).toContain("GitHub CLI (gh) could not be started");
  });

  it("still renders authenticated JSON results", async () => {
    const { html } = await renderWith(() => result(0, JSON.stringify([{ number: 42, title: "CLI works", author: { login: "tester" } }])));
    expect(html).toContain("CLI works");
    expect(html).not.toContain('class="ghError"');
  });
});
