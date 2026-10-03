import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionFactory, piSessionDirectory } from "../server/session/piFactory.js";
import type { LocalSessionServiceDependencies } from "../server/session/service.js";

const loaderState = vi.hoisted(() => ({ options: [] as any[], reload: vi.fn(async () => undefined) }));
vi.mock("../server/extensions/resilientLoader.js", () => ({
  ResilientResourceLoader: class {
    constructor(options: unknown) { loaderState.options.push(options); }
    reload = loaderState.reload;
  },
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: vi.fn(async (input: any) => ({
    session: { sessionManager: input.sessionManager }, modelFallbackMessage: "fallback",
  })),
}));

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-factory-"));
  cwd = join(root, "workspace");
  await mkdir(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  loaderState.options.length = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function factory(noSession = false) {
  return new PiSessionFactory({
    noSession,
    modelRuntime: {} as LocalSessionServiceDependencies["modelRuntime"],
    additionalExtensionPaths: (workspace) => [join(workspace, "extension.ts")],
    readSession: async () => { throw new Error("not called during creation"); },
  });
}

async function savedSession(workspace: string, id = "saved") {
  const directory = piSessionDirectory(workspace);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: workspace })}\n`);
  return path;
}

describe("PiSessionFactory resource lifecycle", () => {
  it("creates persistent resources once and preserves SDK context and start input", async () => {
    const value = factory();
    const start = { reason: "new" as const, previousSessionFile: "/previous.jsonl" };
    const result = await value.create({ cwd, sessionStartEvent: start });
    const input = vi.mocked(createAgentSession).mock.calls[0][0]!;
    expect(input.sessionManager).toBeInstanceOf(SessionManager);
    expect(input.sessionManager!.getSessionFile()).toContain(piSessionDirectory(cwd));
    expect(input.cwd).toBe(cwd);
    expect(input.sessionStartEvent).toBe(start);
    expect(input.customTools?.map((tool) => tool.name)).toContain("sessions_read");
    expect(result.modelFallbackMessage).toBe("fallback");
    expect(value.loaderFor(result.session)).toBe(input.resourceLoader);
    expect(loaderState.reload).toHaveBeenCalledTimes(1);
    const options = loaderState.options[0].loaderOptions;
    expect(options.additionalExtensionPaths).toEqual([join(cwd, "extension.ts")]);
    const prompt = options.appendSystemPromptOverride(["existing"]).join("\n");
    expect(prompt).toContain("existing");
    expect(prompt).toContain("pi-web UI context");
    expect(prompt).toContain("docs/pi-web-extensions.md");
    expect(await readFile(join(cwd, ".pi/web/.gitignore"), "utf8")).toBe("*\n");
  });

  it("opens with the saved cwd, not the caller's discovery cwd, without rewriting history", async () => {
    const other = join(root, "other");
    await mkdir(other);
    const path = await savedSession(other);
    const before = await readFile(path, "utf8");
    await factory().create({ path, cwd });
    const input = vi.mocked(createAgentSession).mock.calls[0][0]!;
    expect(input.cwd).toBe(other);
    expect(input.sessionManager!.getSessionId()).toBe("saved");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("uses an in-memory manager in no-session mode even when given a path", async () => {
    await factory(true).create({ cwd, path: "/does-not-exist.jsonl", sessionStartEvent: { reason: "new" } });
    const input = vi.mocked(createAgentSession).mock.calls[0][0]!;
    expect(input.sessionManager!.getSessionFile()).toBeUndefined();
  });

  it("lists shallow metadata and locates bookmarked sessions without changing bytes", async () => {
    const path = await savedSession(cwd);
    const before = await readFile(path, "utf8");
    const value = factory();
    const [info] = await value.list(cwd);
    expect(info).toMatchObject({ id: "saved", path, cwd });
    expect(info.created).toBeInstanceOf(Date);
    expect(info.modified).toBeInstanceOf(Date);
    expect(await value.locate("saved", join(root, "unvisited"), [])).toEqual({ path, cwd });
    expect(await value.locate("absent", cwd, [])).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects a bookmarked header whose cwd does not match its directory", async () => {
    const path = await savedSession(cwd);
    await writeFile(path, `${JSON.stringify({ type: "session", id: "saved", cwd: join(root, "wrong") })}\n`);
    await expect(factory().locate("saved", join(root, "unvisited"), [])).rejects.toThrow("working directory does not match");
  });

  it("uses trash when installed and does not permanently delete on trash failure", async () => {
    const path = await savedSession(cwd);
    const bin = join(root, "bin");
    await mkdir(bin);
    const trash = join(bin, "trash");
    await writeFile(trash, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    await expect(factory().remove("saved", path)).rejects.toMatchObject({ code: 7 });
    expect(await readFile(path, "utf8")).toContain("saved");
    await writeFile(trash, '#!/bin/sh\n/bin/mv "$1" "$1.trashed"\n', { mode: 0o755 });
    expect(await factory().remove("saved", path)).toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${path}.trashed`, "utf8")).toContain("saved");
  });

  it("deletes only the requested session when trash is not installed", async () => {
    const path = await savedSession(cwd);
    const kept = await savedSession(cwd, "kept");
    vi.stubEnv("PATH", join(root, "empty-bin"));
    expect(await factory().remove("saved", path)).toBe("deleted");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(kept, "utf8")).toContain("kept");
  });
});
