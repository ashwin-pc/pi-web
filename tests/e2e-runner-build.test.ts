import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const runner = fileURLToPath(new URL("../scripts/run-all-tests.mjs", import.meta.url));

it("isolates compilation caches across every E2E task and concurrent invocations, then cleans them", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-cache-env-"));
  try {
    const bin = join(cwd, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const source = `const fs = require("node:fs");
const cache = process.env.PWTEST_CACHE_DIR;
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(require("node:path").join(cache, "partial-cache"), "test");
fs.appendFileSync("caches.jsonl", JSON.stringify({ cache, args: process.argv.slice(2), dev: process.env.PI_WEB_DEV, invocation: process.env.TEST_INVOCATION }) + "\\n");
setTimeout(() => { if (process.env.TEST_FAIL && process.argv.includes("--project=isolated")) process.exitCode = 1; }, 100);
`;
    if (process.platform === "win32") {
      await writeFile(join(bin, "playwright.cjs"), source);
      await writeFile(join(bin, "playwright.cmd"), `@"${process.execPath}" "%~dp0playwright.cjs" %*\r\n`);
    } else {
      await writeFile(join(bin, "playwright"), `#!/usr/bin/env node\n${source}`);
      await chmod(join(bin, "playwright"), 0o755);
    }
    const invoke = (invocation: string, shards: string, fail = false) => run(process.execPath, [runner, "--e2e-only", "--skip-build"], {
      cwd,
      env: { ...process.env, PI_WEB_DEV: "1", NODE_ENV: "development", PWTEST_CACHE_DIR: join(cwd, "ambient-cache"), PI_WEB_E2E_SHARDS: shards, PI_WEB_E2E_CONCURRENCY: "4", PI_WEB_E2E_PORT_OFFSET: "0", TEST_INVOCATION: invocation, TEST_FAIL: fail ? "1" : "" },
      timeout: 15_000,
    });
    await Promise.all([invoke("unsharded", "1"), invoke("sharded", "2")]);
    await expect(invoke("failed", "1", true)).rejects.toMatchObject({ code: 1 });
    const records = (await readFile(join(cwd, "caches.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(18); // 5 unsharded + 8 sharded + 5 failing-run tasks.
    expect(new Set(records.map(record => record.cache)).size).toBe(records.length);
    for (const [invocation, count] of [["unsharded", 5], ["sharded", 8], ["failed", 5]] as const) {
      const tasks = records.filter(record => record.invocation === invocation);
      expect(tasks).toHaveLength(count);
      expect(tasks.filter(record => record.args.includes("--project=isolated"))).toHaveLength(1);
      expect(tasks.filter(record => record.args.includes("--project=auth"))).toHaveLength(1);
    }
    for (const record of records) {
      expect(record.dev).toBe("0");
      expect(record.cache).not.toBe(join(cwd, "ambient-cache"));
      await expect(stat(record.cache)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(record.cache, ".."))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(stat(join(cwd, "ambient-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("builds production E2E assets without leaking build flags into other tasks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-build-env-"));
  try {
    const bin = join(cwd, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "vite build && tsc -p tsconfig.extensions.json" } }));
    for (const command of ["vite", "tsc", "playwright"]) {
      let source = `require("node:fs").writeFileSync(${JSON.stringify(`${command}-env.json`)}, JSON.stringify({ NODE_ENV: process.env.NODE_ENV, PI_WEB_DEV: process.env.PI_WEB_DEV }));\n`
        + `require("node:fs").writeFileSync(${JSON.stringify(`${command}-paths.json`)}, JSON.stringify({ home: process.env.PI_WEB_HOME, settings: process.env.PI_WEB_SETTINGS_FILE, notepad: process.env.PI_WEB_NOTEPAD_FILE }));\n`;
      if (command === "playwright") {
        source += `const project = process.argv.find(arg => arg.startsWith("--project="));\n`
          + `const record = event => require("node:fs").appendFileSync("project-order.jsonl", JSON.stringify({ event, project, isolated: process.env.PI_WEB_E2E_ISOLATED }) + "\\n");\n`
          + `record("start"); setTimeout(() => record("finish"), 100);\n`;
      }
      if (process.platform === "win32") {
        await writeFile(join(bin, `${command}.cjs`), source);
        await writeFile(join(bin, `${command}.cmd`), `@"${process.execPath}" "%~dp0${command}.cjs" %*\r\n`);
      } else {
        const path = join(bin, command);
        await writeFile(path, `#!/usr/bin/env node\n${source}`);
        await chmod(path, 0o755);
      }
    }
    await run(process.execPath, [fileURLToPath(new URL("../scripts/run-all-tests.mjs", import.meta.url)), "--e2e-only"], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PI_WEB_DEV: "1",
        PI_WEB_HOME: "/developer/live-home",
        PI_WEB_SETTINGS_FILE: "/developer/live-settings.json",
        PI_WEB_NOTEPAD_FILE: "/developer/live-notepad.json",
        PI_WEB_E2E_SHARDS: "1",
        PI_WEB_E2E_CONCURRENCY: "2",
        PI_WEB_E2E_ISOLATED: "inherited",
        PI_WEB_E2E_PORT_OFFSET: "0",
      },
      timeout: 15_000,
    });
    expect(JSON.parse(await readFile(join(cwd, "vite-env.json"), "utf8"))).toEqual({ NODE_ENV: "production", PI_WEB_DEV: "0" });
    expect(JSON.parse(await readFile(join(cwd, "tsc-env.json"), "utf8"))).toEqual({ NODE_ENV: "production", PI_WEB_DEV: "0" });
    expect(JSON.parse(await readFile(join(cwd, "playwright-env.json"), "utf8"))).toEqual({ NODE_ENV: "development", PI_WEB_DEV: "0" });
    for (const command of ["vite", "tsc", "playwright"]) {
      expect(JSON.parse(await readFile(join(cwd, `${command}-paths.json`), "utf8"))).toEqual({ home: "", settings: "", notepad: "" });
    }
    const order = (await readFile(join(cwd, "project-order.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(order.slice(-2)).toEqual([
      { event: "start", project: "--project=isolated", isolated: "1" },
      { event: "finish", project: "--project=isolated", isolated: "1" },
    ]);
    expect(order.slice(0, -2).filter(entry => entry.event === "finish")).toHaveLength(4);
    expect(order.slice(0, -2).every(entry => entry.isolated === "0")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
