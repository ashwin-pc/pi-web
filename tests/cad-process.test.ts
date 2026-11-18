import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execLocal, runOwnedProcess } from "../examples/pi-web-extensions/3d-modeling/cad/process.js";
import { discover, executeModeling, loadConfig } from "../examples/pi-web-extensions/3d-modeling/cad/runtime.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "cad-owned-")); dirs.push(cwd);
  const root = join(cwd, ".pi/web/artifacts"); await mkdir(root, { recursive: true });
  const config = join(cwd, "config.json");
  const descriptor = { id: "node", description: "test", executable: process.execPath, args: ["{script}"], scriptExtension: ".mjs", timeoutMs: 5000 };
  await writeFile(config, JSON.stringify({ version: 1, runtimes: [descriptor] }));
  return { cwd, root, config, descriptor };
}

describe("canonical owned process lifecycle", () => {
  it("rejects pre-aborted entrypoints without launching and handles spawn errors", async () => {
    const signal = AbortSignal.abort();
    await expect(execLocal(process.execPath, ["-e", "process.exit(99)"], { signal })).rejects.toThrow(/before launch/);
    const f = await fixture(); await writeFile(join(f.root, "script.mjs"), "process.exit(99)");
    await expect(executeModeling(f.cwd, { runtime: "node", script: "script.mjs", acknowledgeUnsandboxed: true }, signal, f.config)).rejects.toThrow(/before launch/);
    await expect(execLocal("/nonexistent/modeling-command", [])).rejects.toThrow(/ENOENT/);
    const before = process.listenerCount("exit");
    const result = await runOwnedProcess("/nonexistent/modeling-command", []);
    expect(result.error?.message).toMatch(/ENOENT/);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("fixes the first stop reason and removes abort listeners after timeout cleanup", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const running = runOwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, timeout: 20 });
    await new Promise(r => setTimeout(r, 60)); controller.abort();
    expect((await running).reason).toBe("timed-out");
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(execLocal(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 20 })).rejects.toThrow(/timed out/);
  });

  it.each(["exec", "runtime"])("cleans descendants after early leader exit through %s", async adapter => {
    const f = await fixture(); const heartbeat = join(f.root, "heartbeat");
    // Child readiness is acknowledged before the leader exits; its inherited pipes
    // remain open and SIGTERM is deliberately ignored, requiring group escalation.
    const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(heartbeat)},'ready'); process.send('ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),10);`;
    const source = `import { fork } from 'node:child_process'; const c=fork('-e',[${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']}); c.once('message',()=>process.exit(0));`;
    await writeFile(join(f.root, "script.mjs"), source);
    if (adapter === "exec") {
      expect((await execLocal(process.execPath, [join(f.root, "script.mjs")])).code).toBe(0);
    } else {
      const result = await executeModeling(f.cwd, { runtime: "node", script: "script.mjs", acknowledgeUnsandboxed: true }, undefined, f.config);
      expect(result.status).toBe("succeeded");
      expect((await discover(f.config)).runtimes[0].busy).toBe("unknown");
    }
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise(r => setTimeout(r, 100));
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
  });

  it("bounds logs, retains failure/redaction evidence, and releases admission", async () => {
    const f = await fixture(); vi.stubEnv("TEST_API_TOKEN", "private-secret-12345");
    const helperPath = "/opt/homebrew/bin:/user/helper/bin:/usr/bin";
    vi.stubEnv("PATH", helperPath); vi.stubEnv("TMPDIR", f.cwd);
    await writeFile(join(f.root, "script.mjs"), `console.log('private-secret-12345'); console.log(JSON.stringify(process.env)); console.log('x'.repeat(300000)); process.exitCode = 7;`);
    const result = await executeModeling(f.cwd, { runtime: "node", script: "script.mjs", acknowledgeUnsandboxed: true }, undefined, f.config);
    expect(result.status).toBe("failed"); expect(result.exitCode).toBe(7); expect(result.truncated).toBe(true);
    const log = await readFile(join(f.cwd, ".pi/web/artifacts", result.log.replace("/api/artifacts/", "")), "utf8");
    expect(log).toContain("[REDACTED]"); expect(log).not.toContain("TEST_API_TOKEN"); expect(log.length).toBeLessThanOrEqual(256 * 1024);
    const environment = JSON.parse(log.split("\n").find(line => line.startsWith("{"))!);
    expect(environment.PATH).toBe(helperPath); expect(environment.TMPDIR).toBe(f.cwd);
    // macOS may inject its text-encoding marker when launching an executable.
    expect(Object.keys(environment).filter(key => key !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    expect(result.reproducibility.script.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await discover(f.config)).runtimes[0].busy).toBe("unknown");
    const out = await execLocal(process.execPath, ["-e", "process.stdout.write('a'.repeat(70000)+'end')"]);
    expect(out.stdout).toHaveLength(65536); expect(out.stdout.endsWith("end")).toBe(true);
  });

  it("retains configured-runtime spawn-error evidence and releases admission", async () => {
    const f = await fixture();
    const executable = join(f.cwd, "broken-runtime");
    await writeFile(executable, "#!/nonexistent/modeling-interpreter\n"); await chmod(executable, 0o700);
    await writeFile(f.config, JSON.stringify({ version: 1, runtimes: [{ ...f.descriptor, executable }] }));
    await writeFile(join(f.root, "script.mjs"), "console.log('unused')");
    const result = await executeModeling(f.cwd, { runtime: "node", script: "script.mjs", acknowledgeUnsandboxed: true }, undefined, f.config);
    expect(result.status).toBe("failed"); expect(result.exitCode).toBeNull();
    const retained = join(f.root, "modeling-runs", result.id);
    expect(await readFile(join(retained, "execution.log"), "utf8")).toMatch(/Process error:.*ENOENT/);
    expect(JSON.parse(await readFile(join(retained, "result.json"), "utf8")).status).toBe("failed");
    expect(await readFile(join(retained, "script.mjs"), "utf8")).toContain("unused");
    expect((await discover(f.config)).runtimes[0].busy).toBe("unknown");
  });

  it("holds admission until awaited cancellation cleanup and then permits another run", async () => {
    const f = await fixture(); await writeFile(join(f.root, "script.mjs"), "setInterval(()=>{},1000)");
    const controller = new AbortController();
    const input = { runtime: "node", script: "script.mjs", acknowledgeUnsandboxed: true };
    const running = executeModeling(f.cwd, input, controller.signal, f.config);
    for (let i = 0; i < 100 && (await discover(f.config)).runtimes[0].busy !== true; i++) await new Promise(r => setTimeout(r, 10));
    await expect(executeModeling(f.cwd, input, undefined, f.config)).rejects.toThrow(/active run/);
    controller.abort(); expect((await running).status).toBe("cancelled");
    await writeFile(join(f.root, "script.mjs"), "process.exit(0)");
    expect((await executeModeling(f.cwd, input, undefined, f.config)).status).toBe("succeeded");
  });

  it.each([
    ["id", "INVALID", "id"], ["executable", "relative", "executable"],
    ["args", [], "args"], ["args", ["{script}", "{bad}"], "args[1]"],
    ["scriptExtension", "py", "scriptExtension"], ["requiredPaths", ["relative"], "requiredPaths[0]"],
    ["timeoutMs", 0, "timeoutMs"],
  ])("reports indexed %s configuration diagnostics", async (field, value, diagnostic) => {
    const f = await fixture();
    await writeFile(f.config, JSON.stringify({ version: 1, runtimes: [{ ...f.descriptor, id: "first" }, { ...f.descriptor, id: "second" }, { ...f.descriptor, [field]: value }] }));
    await expect(loadConfig(f.config)).rejects.toThrow(`runtimes[2].${diagnostic}:`);
  });
});
