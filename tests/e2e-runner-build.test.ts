import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

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
    expect(JSON.parse(await readFile(join(cwd, "playwright-env.json"), "utf8"))).toEqual({ NODE_ENV: "development", PI_WEB_DEV: "1" });
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
