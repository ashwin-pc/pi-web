import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCliProcessHarness, cliTestTimeout } from "./cad-cli-process.js";

const harnesses: ReturnType<typeof createCliProcessHarness>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("bounds a stalled CLI child and awaits its termination before rejecting", async () => {
  const harness = createCliProcessHarness(100);
  harnesses.push(harness);
  let pid!: number;
  await expect(harness.run(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    onSpawn: value => { pid = value; },
  })).rejects.toThrow("CLI exceeded 100ms");
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

it("test teardown stops an in-flight CLI and its same-group descendants", async () => {
  const harness = createCliProcessHarness();
  harnesses.push(harness);
  const cwd = await mkdtemp(join(tmpdir(), "cad-cli-owner-")); directories.push(cwd);
  const ready = join(cwd, "ready.json");
  const pending = harness.run(process.execPath, ["-e", `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({parent:process.pid, child:child.pid}));
    setInterval(() => {}, 1000);
  `]);
  let pids!: { parent: number; child: number };
  await vi.waitFor(async () => { pids = JSON.parse(await readFile(ready, "utf8")); }, { timeout: 5_000 });
  await harness.dispose();
  await pending;
  await vi.waitFor(() => {
    for (const pid of [pids.parent, pids.child]) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });
}, cliTestTimeout());
