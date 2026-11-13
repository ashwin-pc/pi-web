import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { CadError, runCad } from "../examples/pi-web-extensions/3d-modeling/cad/core.js";
import { fusionMcpUrl } from "../examples/pi-web-extensions/3d-modeling/fusion/client.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "cad-cli-")); directories.push(cwd);
  const root = join(cwd, ".pi/web/artifacts"); await mkdir(root, { recursive: true });
  vi.stubEnv("PI_MODELING_CONFIG", join(cwd, "absent.json"));
  vi.stubEnv("PI_WEB_FUSION_MCP_URL", "http://127.0.0.1:27182/mcp");
  return { cwd, root };
}
function fusion(result: unknown, list?: any) {
  const requests: any[] = [];
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "DELETE") return new Response(null, { status: 202 });
    const body = JSON.parse(String(options.body)); requests.push(body);
    if (body.method === "initialize") return new Response(JSON.stringify({ id: 1, result: {} }), { headers: { "mcp-session-id": "fake-session" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ id: 2, result: body.method === "tools/list" ? list ?? { tools: [] } : result }));
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}
const entry = resolve("examples/pi-web-extensions/3d-modeling/cad/cli.ts");
async function cli(args: string[], cwd?: string, signalWhenReady?: string, launcher = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, launcher ? [resolve("examples/pi-web-extensions/3d-modeling/cad.mjs"), ...args] : ["--import", resolve("node_modules/tsx/dist/loader.mjs"), entry, ...args], { cwd, env: { ...process.env, PI_MODELING_CONFIG: process.env.PI_MODELING_CONFIG ?? join(tmpdir(), "cad-no-config.json") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    let readinessTimer: ReturnType<typeof setInterval> | undefined;
    let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
    let readinessFinished = false;
    const clearReadiness = () => { readinessFinished = true; clearInterval(readinessTimer); clearTimeout(readinessDeadline); };
    child.once("error", error => { clearReadiness(); reject(error); });
    child.once("close", code => { clearReadiness(); done({ code, stdout, stderr }); });
    if (signalWhenReady) {
      // Node/tsx startup is unbounded under CI contention. Signal only after the
      // owned backend has installed its cleanup handler, not after a guessed delay.
      readinessTimer = setInterval(() => {
        void access(signalWhenReady).then(() => {
          if (readinessFinished) return;
          clearReadiness(); child.kill("SIGTERM");
        }, () => {});
      }, 10);
      readinessDeadline = setTimeout(() => {
        clearReadiness(); child.kill("SIGKILL");
        reject(new Error(`CLI backend did not become ready: ${stderr}`));
      }, 15_000);
    }
  });
}

 describe("shared modeling CLI", () => {
  it("has complete offline discoverability without connecting or starting a model", async () => {
    const { cwd } = await workspace(); const { fetch } = fusion({});
    const result: any = await runCad(["discover"], { cwd });
    expect(result.reference.commands.map((c: any) => c.command).join("\n")).toContain("fusion exec --script");
    const runtimeArgs = result.reference.runtimeConfig.runtimes[0].args;
    expect(runtimeArgs).toContain("{script}");
    expect(runtimeArgs.slice(runtimeArgs.indexOf("--python-exit-code"), runtimeArgs.indexOf("--python-exit-code") + 2)).toEqual(["--python-exit-code", "1"]);
    expect(runtimeArgs.indexOf("--python-exit-code")).toBeLessThan(runtimeArgs.indexOf("--python"));
    expect(result.fusion.state).toBe("not-probed"); expect(fetch).not.toHaveBeenCalled();
  });
  it("returns clean JSON stdout for help and stderr-only JSON/exit2 for invalid argv", async () => {
    const { cwd } = await workspace();
    const ok = await cli(["help"], cwd);
    expect(ok.code).toBe(0); expect(ok.stderr).toBe(""); expect(JSON.parse(ok.stdout).result.name).toBe("modeling");
    const bad = await cli(["fusion", "undo"], cwd);
    expect(bad.code).toBe(2); expect(bad.stdout).toBe(""); expect(JSON.parse(bad.stderr)).toMatchObject({ ok: false, exitCode: 2 });
  });
  it("runs the extension-local mjs launcher from an unrelated working directory", async () => {
    const { cwd } = await workspace();
    for (const command of ["help", "discover"]) {
      const result = await cli([command], cwd, undefined, true);
      expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).ok).toBe(true);
    }
  });
  it.each(["http://example.com/mcp", "https://127.0.0.1/mcp", "http://127.0.0.1@evil.example/mcp", "http://secret@localhost/mcp", "http://localhost/mcp?token=secret"])("rejects nonloopback or credentialed endpoint %s", url => {
    expect(() => fusionMcpUrl(url)).toThrow(/HTTP loopback/);
  });
  it("lists actual MCP schemas with bounded paging and no generic RPC bypass", async () => {
    const { cwd } = await workspace(); const list = { tools: [{ name: "future-capability", inputSchema: { type: "object" } }], nextCursor: "next" };
    const { requests, fetch } = fusion({}, list);
    expect(await runCad(["fusion", "capabilities", "--cursor", "page"], { cwd })).toEqual(list);
    expect(requests[2]).toMatchObject({ method: "tools/list", params: { cursor: "page" } });
    expect(fetch.mock.calls.every(call => call[1].redirect === "error")).toBe(true);
    expect(fetch.mock.calls.filter(call => call[1].method === "DELETE")).toHaveLength(1);
    await expect(runCad(["fusion", "rpc", "--json", '{}'], { cwd })).rejects.toMatchObject({ exitCode: 2 });
  });
  it("selects matching SSE responses after progress and unrelated ids, joining multiline data", async () => {
    const { cwd } = await workspace();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "DELETE") return new Response(null, { status: 202 });
      const body = JSON.parse(String(options.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = body.method === "initialize" ? 1 : 2;
      const text = ': heartbeat\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":999,"result":{"wrong":true}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":' + id + ',"result":{"selected":' + id + '}}\r\n\r\n';
      return new Response(text, { headers: { "content-type": "text/event-stream", "mcp-session-id": "sse-test" } });
    }));
    expect(await runCad(["fusion", "status"], { cwd })).toEqual({ selected: 2 });
  });
  it.each([
    ['data: {"jsonrpc":"2.0","method":"notifications/progress"}\\n\\n', /no JSON-RPC response matching/],
    ['data: {"jsonrpc":"2.0","id":999,"result":{}}\\n\\n', /no JSON-RPC response matching/],
    ['data: {invalid}\\n\\n', /malformed JSON or SSE/],
    ['data: ' + "x".repeat(2 * 1024 * 1024 + 1), /size limit/],
  ])("rejects missing, unrelated, malformed or oversized SSE response %#", async (text, expected) => {
    const { cwd } = await workspace();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(String(text).replaceAll("\\n", "\n"), { headers: { "content-type": "text/event-stream" } })));
    await expect(runCad(["fusion", "capabilities"], { cwd })).rejects.toThrow(expected as RegExp);
  });
  it("forwards bounded read-only MCP resource catalog, resource reads and generic electronics queries", async () => {
    const { cwd } = await workspace(); const payload = { contents: [{ uri: "fusion://schema/Board", text: "schema" }] };
    const { requests } = fusion(payload);
    expect(await runCad(["fusion", "resources", "--cursor", "page-two"], { cwd })).toEqual(payload);
    expect(requests[2]).toMatchObject({ method: "resources/list", params: { cursor: "page-two" } });
    expect(await runCad(["fusion", "resource", "--json", '{"uri":"fusion://schema/Board"}'], { cwd })).toEqual(payload);
    expect(requests[5]).toMatchObject({ method: "resources/read", params: { uri: "fusion://schema/Board" } });
    const query = { entity_type: "Board", object: { fields: ["name"], filters: { name: "main" }, pagination: { offset: 0, limit: 10 } } };
    await runCad(["fusion", "electronics", "--json", JSON.stringify(query)], { cwd });
    expect(requests[8].params).toEqual({ name: "fusion_mcp_electronics_read", arguments: query });
    await expect(runCad(["fusion", "resource", "--json", '{"uri":"fusion://schema","method":"tools/call"}'], { cwd })).rejects.toMatchObject({ exitCode: 2 });
    await expect(runCad(["fusion", "resource", "--json", '{"uri":""}'], { cwd })).rejects.toMatchObject({ exitCode: 2 });
    await expect(runCad(["fusion", "electronics", "--json", '{}', "--allow-mutation"], { cwd })).rejects.toMatchObject({ exitCode: 2 });
  });
  it("does not mislabel an upstream success-only docs response as retrieved documentation", async () => {
    const { cwd } = await workspace(); const result = { content: [{ type: "text", text: '{"success":true}' }] }; fusion(result);
    expect(await runCad(["fusion", "docs", "--json", '{"searchPattern":"Body"}'], { cwd })).toEqual(result);
    const reference: any = await runCad(["help", "fusion", "docs"], { cwd });
    expect(reference.commands[0].description).toContain("backend limitation");
    expect(reference.commands[0].description).toContain("not evidence");
  });
  it("forwards generic read and docs queries without narrow command duplication", async () => {
    const { cwd } = await workspace(); const { requests } = fusion({ content: [] });
    const query = { queryType: "document", operation: "search", name: "part", project: "hub" };
    await runCad(["fusion", "read", "--json", JSON.stringify(query)], { cwd });
    expect(requests[2].params).toEqual({ name: "fusion_mcp_read", arguments: query });
    await runCad(["fusion", "docs", "--json", '{"searchPattern":"Extrude","filter":"adsk.fusion"}'], { cwd });
    expect(requests[5].params.arguments).toEqual({ queryType: "apiDocumentation", apiCategory: "all", searchPattern: "Extrude", filter: "adsk.fusion" });
  });
  it("requires exactly one explicit script mode and forwards run(context) source unchanged", async () => {
    const { cwd, root } = await workspace(); const { requests, fetch } = fusion({ content: [{ type: "text", text: "done" }] });
    const source = "import adsk.core\n\ndef run(context):\n    print('unchanged')\n";
    await writeFile(join(root, "script.py"), source);
    await expect(runCad(["fusion", "exec", "--script", "script.py"], { cwd })).rejects.toMatchObject({ exitCode: 2 });
    await expect(runCad(["fusion", "exec", "--script", "script.py", "--read-only", "--allow-mutation"], { cwd })).rejects.toMatchObject({ exitCode: 2 });
    expect(fetch).not.toHaveBeenCalled();
    await runCad(["fusion", "exec", "--script", "script.py", "--allow-mutation"], { cwd });
    expect(requests[2].params).toEqual({ name: "fusion_mcp_execute", arguments: { featureType: "script", object: { script: source } } });
  });
  it.each([
    "def run(_context: str):\n    print('typed')\n",
    "def run(\n    context: str,\n) -> None:\n    print('multiline')\n",
    '"""def run(context): is documentation only"""\nprint("no callback")\n',
    "def run(context):\n    pass\nrun = 1\n",
  ])("forwards Python unchanged without pretending to parse or enforce its callback: %s", async source => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "source.py"), source);
    const { requests } = fusion({ content: [] });
    await runCad(["fusion", "exec", "--script", "source.py", "--allow-mutation"], { cwd });
    expect(requests[2].params.arguments.object.script).toBe(source);
    const reference: any = await runCad(["help", "fusion", "exec"], { cwd });
    expect(reference.commands[0].description).toContain("fresh top-level def run(context)");
    expect(reference.commands[0].description).toContain("never overwrite run");
  });
  it.each(["top", "object"])("forwards advertised readOnly flag at the actual %s schema location", async location => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "read.py"), "def run(context):\n    print(1)\n");
    const readOnly = { type: "boolean" };
    const properties = location === "top" ? { readOnly } : { object: { properties: { readOnly } } };
    const { requests } = fusion({ content: [] }, { tools: [{ name: "fusion_mcp_execute", inputSchema: { properties } }] });
    await runCad(["fusion", "exec", "--script", "read.py", "--read-only"], { cwd });
    expect(requests[5].params.arguments[location === "top" ? "readOnly" : "object"]).toEqual(location === "top" ? true : { script: "def run(context):\n    print(1)\n", readOnly: true });
  });
  it("fails closed when read-only is unsupported, and propagates structured Fusion errors", async () => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "read.py"), "def run(context):\n    pass\n");
    const { requests } = fusion({});
    await expect(runCad(["fusion", "exec", "--script", "read.py", "--read-only"], { cwd })).rejects.toThrow(/does not advertise/);
    expect(requests.some(r => r.method === "tools/call")).toBe(false);
    fusion({ content: [{ type: "text", text: JSON.stringify({ success: false, error: "geometry interference" }) }] });
    await expect(runCad(["fusion", "exec", "--script", "read.py", "--allow-mutation"], { cwd })).rejects.toThrow(/geometry interference/);
  });
  it("gates undo/redo before network work and issues only the update operation", async () => {
    const { cwd } = await workspace(); const { requests, fetch } = fusion({ content: [] });
    await expect(runCad(["fusion", "undo"], { cwd })).rejects.toMatchObject({ exitCode: 2 }); expect(fetch).not.toHaveBeenCalled();
    await runCad(["fusion", "redo", "--allow-mutation"], { cwd });
    expect(requests[2].params).toEqual({ name: "fusion_mcp_update", arguments: { featureType: "redo" } });
  });
  it("rejects artifact traversal and escaping script symlinks before network work", async () => {
    const { cwd, root } = await workspace(); const { fetch } = fusion({});
    await writeFile(join(cwd, "outside.py"), "def run(context):\n    pass\n"); await symlink(join(cwd, "outside.py"), join(root, "escape.py"));
    for (const script of ["../outside.py", "escape.py", "/tmp/script.py"]) await expect(runCad(["fusion", "exec", "--script", script, "--allow-mutation"], { cwd })).rejects.toThrow(/Unsafe artifact|symlink escapes/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("saves a bounded PNG with screenshot validation and safe artifact output", async () => {
    const { cwd, root } = await workspace();
    const png = Buffer.from("89504e470d0a1a0a", "hex"); fusion({ content: [{ type: "image", data: png.toString("base64") }] });
    expect(await runCad(["fusion", "screenshot", "--json", '{"output":"view.png"}'], { cwd })).toMatchObject({ url: "/api/artifacts/view.png", bytes: 8 });
    expect(await readFile(join(root, "view.png"))).toEqual(png);
    await expect(runCad(["fusion", "screenshot", "--json", '{"output":"bad.png","width":1}'], { cwd })).rejects.toThrow(/dimensions/);
  });
  it("uses the canonical safe slicer adapter with named profiles and no arbitrary argv", async () => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "part.stl"), "solid part\nendsolid part\n");
    vi.stubEnv("PRUSA_SLICER_PATH", process.execPath);
    const exec = vi.fn(async (_command: string, args: string[]) => { await writeFile(args[args.indexOf("--output") + 1], "G1 X0 Y0\n"); return { code: 0, stdout: "done", stderr: "", killed: false }; });
    const result: any = await runCad(["slice", "--json", '{"input":"part.stl","output":"part.gcode","printerProfile":"Named Printer"}'], { cwd, exec });
    expect(result.url).toBe("/api/artifacts/part.gcode"); expect(exec.mock.calls[0][1]).toContain("Named Printer");
    await expect(runCad(["slice", "--json", '{"input":"part.stl","output":"part.gcode","args":["--evil"]}'], { cwd, exec })).rejects.toMatchObject({ exitCode: 2 });
  });
  it("does not create nested directories through escaping screenshot output parents", async () => {
    const { cwd, root } = await workspace(); const { fetch } = fusion({});
    const outside = join(cwd, "outside"); await mkdir(outside); await symlink(outside, join(root, "escape"));
    await expect(runCad(["fusion", "screenshot", "--json", '{"output":"escape/new/nested/view.png"}'], { cwd })).rejects.toThrow(/parent symlink escapes/);
    await expect(access(join(outside, "new"))).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects profile option injection and newline profile names", async () => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "part.stl"), "solid part\nendsolid part\n"); vi.stubEnv("PRUSA_SLICER_PATH", process.execPath);
    const exec = vi.fn();
    for (const printerProfile of ["--evil", "name\nvalue"]) await expect(runCad(["slice", "--json", JSON.stringify({ input: "part.stl", output: "part.gcode", printerProfile })], { cwd, exec })).rejects.toThrow(/profile name is invalid/);
    expect(exec).not.toHaveBeenCalled();
  });
  it("selects Hunyuan's full native budget by default and honors explicit invocation limits without loading a model", async () => {
    const { cwd } = await workspace();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // Invalid JSON stops dispatch before any adapter/model launch, after the
    // invocation timeout has been selected.
    for (const [args, expected] of [
      [["hunyuan", "generate", "--json", "invalid"], 3_900_000],
      [["hunyuan", "generate", "--json", "invalid", "--timeout-ms", "42"], 42],
      [["slice", "--json", "invalid"], 1_800_000],
    ] as const) {
      timeout.mockClear();
      await expect(runCad([...args], { cwd })).rejects.toMatchObject({ exitCode: 2 });
      expect(timeout.mock.calls).toEqual([[expected]]);
    }
    const reference: any = await runCad(["help"], { cwd });
    expect(reference.global).toContain("hunyuan generate defaults to 3900000");
  });

  it("forwards network cancellation and reports invocation timeout", async () => {
    const { cwd } = await workspace();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    })));
    await expect(runCad(["fusion", "status", "--timeout-ms", "10"], { cwd })).rejects.toMatchObject({ exitCode: 124 });
  });
  it("reports unknown Fusion state after invocation timeout without claiming remote cleanup", async () => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "wait.py"), "def run(context):\n    pass\n");
    const mock = fusion({});
    mock.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method === "DELETE") return new Response(null, { status: 202 });
      const body = JSON.parse(String(options.body));
      if (body.method === "initialize") return new Response('{"id":1,"result":{}}', { headers: { "mcp-session-id": "test" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Promise((_resolve, reject) => { options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }); });
    });
    try { await runCad(["fusion", "exec", "--script", "wait.py", "--allow-mutation", "--timeout-ms", "20"], { cwd }); throw new Error("expected timeout"); }
    catch (error) {
      expect(error).toMatchObject({ exitCode: 124 });
      expect((error as Error).message).toContain("does not cancel Fusion execution");
      expect((error as Error).message).toContain("do not automatically retry mutation");
      expect((error as Error).message).not.toContain("cleanup completed");
    }
    expect(mock.fetch.mock.calls.some(call => call[1].method === "DELETE")).toBe(true);
  });
  it("preserves 120-second mutation budgets and warns on bridge-level timeout", async () => {
    const { cwd, root } = await workspace(); await writeFile(join(root, "script.py"), "def run(context):\n    pass\n");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fusion({ content: [] });
    await runCad(["fusion", "exec", "--script", "script.py", "--allow-mutation"], { cwd });
    expect(timeout).toHaveBeenCalledWith(120_000);
    timeout.mockClear();
    await runCad(["fusion", "undo", "--allow-mutation"], { cwd });
    expect(timeout).toHaveBeenCalledWith(120_000);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("bridge deadline", "TimeoutError"); }));
    await expect(runCad(["fusion", "exec", "--script", "script.py", "--allow-mutation"], { cwd })).rejects.toMatchObject({ exitCode: 124, message: expect.stringContaining("document state are unknown") });
  });
  it("bounds actual response streams even without Content-Length", async () => {
    const { cwd } = await workspace();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))));
    await expect(runCad(["fusion", "capabilities"], { cwd })).rejects.toThrow(/size limit/);
  });
  it("propagates MCP initialization and initialized-notification errors", async () => {
    const { cwd } = await workspace();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, error: { message: "bad init" } }))));
    await expect(runCad(["fusion", "status"], { cwd })).rejects.toThrow(/initialization failed/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"id":1,"result":{}}', { headers: { "mcp-session-id": "test" } })).mockResolvedValueOnce(new Response('{"error":{"message":"not initialized"}}')));
    await expect(runCad(["fusion", "status"], { cwd })).rejects.toThrow(/initialized notification failed/);
  });
  it("redacts ambient secrets in shared backend diagnostics", async () => {
    const { cwd } = await workspace(); vi.stubEnv("EXAMPLE_API_TOKEN", "ambient-secret-1234");
    fusion({ content: [{ type: "text", text: "ambient-secret-1234" }] });
    expect(JSON.stringify(await runCad(["fusion", "status"], { cwd }))).not.toContain("ambient-secret");
  });
});

async function runtimeWorkspace() {
  const context = await workspace();
  const config = join(context.cwd, "modeling.json"); vi.stubEnv("PI_MODELING_CONFIG", config);
  await writeFile(config, JSON.stringify({ version: 1, runtimes: [{ id: "node", description: "Fake local procedural runtime", executable: process.execPath, args: ["{script}"], scriptExtension: ".mjs", timeoutMs: 5000 }] }));
  return context;
}
describe("configured local runtime and CLI lifecycle", () => {
  it("retains immutable source/hash and redacted logs without inheriting secrets", async () => {
    const { cwd, root } = await runtimeWorkspace(); vi.stubEnv("TEST_API_TOKEN", "not-in-child-1234");
    await writeFile(join(root, "script.mjs"), "console.log(process.env.TEST_API_TOKEN || 'clean');\n");
    await expect(runCad(["runtime", "exec", "--json", '{"runtime":"node","script":"script.mjs"}'], { cwd })).rejects.toMatchObject({ exitCode: 2 });
    const result: any = await runCad(["runtime", "exec", "--json", '{"runtime":"node","script":"script.mjs"}', "--allow-mutation"], { cwd });
    expect(result.status).toBe("succeeded"); expect(result.reproducibility.script.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, "modeling-runs", result.id, "execution.log"), "utf8")).toBe("clean\n");
    expect(JSON.parse(await readFile(join(root, "modeling-runs", result.id, "result.json"), "utf8")).status).toBe("succeeded");
  });
  it("bounds runtime timeout, records failure evidence, and returns CLI exit124", async () => {
    const { cwd, root } = await runtimeWorkspace(); await writeFile(join(root, "wait.mjs"), "setInterval(() => {}, 1000);\n");
    const result = await cli(["runtime", "exec", "--json", '{"runtime":"node","script":"wait.mjs","timeoutMs":50}', "--allow-mutation"], cwd);
    expect(result.code).toBe(124); expect(result.stdout).toBe(""); expect(JSON.parse(result.stderr).result.status).toBe("timed-out");
  });
  it.each([false, true])("propagates SIGTERM, waits for owned cleanup and returns exit130 (launcher=%s)", async launcher => {
    const { cwd, root } = await runtimeWorkspace();
    const ready = join(root, "ready.json"), cleaned = join(root, "cleaned.json");
    await writeFile(join(root, "wait.mjs"), `
import { writeFileSync } from "node:fs";
process.once("SIGTERM", () => {
  setTimeout(() => {
    console.log("owned cleanup completed");
    writeFileSync(${JSON.stringify(cleaned)}, JSON.stringify({ pid: process.pid }));
    process.exit(0);
  }, 75);
});
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));
`);
    const result = await cli(["runtime", "exec", "--json", '{"runtime":"node","script":"wait.mjs"}', "--allow-mutation"], cwd, ready, launcher);
    expect(result.code).toBe(130); expect(result.stdout).toBe("");
    const response = JSON.parse(result.stderr);
    expect(response).toMatchObject({ ok: false, exitCode: 130, result: { status: "cancelled", exitCode: 0 } });
    const run = join(root, "modeling-runs", response.result.id);
    expect(JSON.parse(await readFile(join(run, "result.json"), "utf8"))).toEqual(response.result);
    expect(await readFile(join(run, "execution.log"), "utf8")).toContain("owned cleanup completed");
    const { pid } = JSON.parse(await readFile(ready, "utf8"));
    expect(JSON.parse(await readFile(cleaned, "utf8"))).toEqual({ pid });
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 30_000);
  it("preserves retained runtime evidence when global timeout translates cancellation", async () => {
    const { cwd, root } = await runtimeWorkspace(); await writeFile(join(root, "wait.mjs"), "setInterval(() => {}, 1000);\n");
    const result = await cli(["runtime", "exec", "--json", '{"runtime":"node","script":"wait.mjs"}', "--allow-mutation", "--timeout-ms", "100"], cwd);
    const response = JSON.parse(result.stderr);
    expect(result.code).toBe(124); expect(response.result.status).toBe("cancelled");
    expect(response.result.log).toContain("execution.log");
    expect(JSON.parse(await readFile(join(root, "modeling-runs", response.result.id, "result.json"), "utf8")).status).toBe("cancelled");
  });
  it("preserves retained runtime evidence when caller cancellation is translated", async () => {
    const { cwd, root } = await runtimeWorkspace(); await writeFile(join(root, "wait.mjs"), "setInterval(() => {}, 1000);\n");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try {
      await runCad(["runtime", "exec", "--json", '{"runtime":"node","script":"wait.mjs"}', "--allow-mutation"], { cwd, signal: controller.signal });
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(CadError); expect((error as CadError).exitCode).toBe(130);
      const result: any = (error as CadError).result;
      expect(result.status).toBe("cancelled"); expect(result.log).toContain("execution.log");
      expect(JSON.parse(await readFile(join(root, "modeling-runs", result.id, "result.json"), "utf8")).status).toBe("cancelled");
    } finally { clearTimeout(timer); }
  });
  it("preserves completed success evidence when caller aborts during normal group cleanup", async () => {
    const { cwd, root } = await runtimeWorkspace();
    await writeFile(join(root, "script.mjs"), "console.log('completed');\n");
    const controller = new AbortController();
    const kill = process.kill.bind(process);
    // The shared runner removes its abort listener before sending SIGTERM on
    // normal leader exit. Abort during that awaited grace period, not execution.
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGTERM") controller.abort();
      return kill(pid, signal);
    });
    let failure: CadError | undefined;
    try {
      await runCad(["runtime", "exec", "--json", '{"runtime":"node","script":"script.mjs"}', "--allow-mutation"], { cwd, signal: controller.signal });
    } catch (error) { expect(error).toBeInstanceOf(CadError); failure = error as CadError; }
    expect(failure?.exitCode).toBe(130);
    const result: any = failure?.result;
    expect(result?.status).toBe("succeeded");
    expect(result.log).toContain("execution.log");
    expect(JSON.parse(await readFile(join(root, "modeling-runs", result.id, "result.json"), "utf8")).status).toBe("succeeded");
  });
  it("rejects escaping run-directory symlinks without writing outside artifacts", async () => {
    const { cwd, root } = await runtimeWorkspace(); await writeFile(join(root, "script.mjs"), "console.log('no');\n");
    const outside = join(cwd, "outside"); await mkdir(outside); await symlink(outside, join(root, "modeling-runs"));
    await expect(runCad(["runtime", "exec", "--json", '{"runtime":"node","script":"script.mjs"}', "--allow-mutation"], { cwd })).rejects.toThrow(/symlink escapes/);
  });
  it("honors pre-aborted signals without spawning backend work", async () => {
    const { cwd } = await workspace(); const { fetch } = fusion({}); const controller = new AbortController(); controller.abort();
    await expect(runCad(["fusion", "status"], { cwd, signal: controller.signal })).rejects.toMatchObject({ exitCode: 130 }); expect(fetch).not.toHaveBeenCalled();
  });
});
