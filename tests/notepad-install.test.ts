import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

describe("standalone notepad installation", () => {
  it("loads a copied example outside the repo without a pi-web runtime dependency", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-web-copied-notepad-"));
    try {
      const directory = join(home, ".pi/web/extensions");
      await mkdir(directory, { recursive: true });
      const extension = join(directory, "notepad.ts");
      await copyFile(resolve("examples/pi-web-extensions/notepad.ts"), extension);
      const loader = pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href;
      // Run the actual pi loader in a plain Node subprocess: no Vitest aliases,
      // tsx paths, package self-reference, or extension-local node_modules.
      const script = `
        import { loadExtensions } from ${JSON.stringify(loader)};
        const result = await loadExtensions([${JSON.stringify(extension)}], process.cwd());
        console.log(JSON.stringify({ errors: result.errors, count: result.extensions.length }));
      `;
      const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
        cwd: home, env: { ...process.env, HOME: home, NODE_OPTIONS: "", NODE_PATH: "" }, timeout: 20_000,
      });
      expect(JSON.parse(stdout.trim())).toEqual({ errors: [], count: 1 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
