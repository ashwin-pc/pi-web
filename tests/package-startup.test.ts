import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Run the actual tarball entrypoint: source-tree imports can otherwise hide
// missing files from the published package allowlist.
describe("npm package", () => {
  it("starts from packed files", async () => {
    const root = resolve(import.meta.dirname, "..");
    const dir = await mkdtemp(join(tmpdir(), "pi-web-package-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
      expect(packed.status, packed.stderr).toBe(0);
      const tarball = join(dir, JSON.parse(packed.stdout)[0].filename);
      const extract = spawnSync("tar", ["-xf", tarball, "-C", dir], { encoding: "utf8" });
      expect(extract.status, extract.stderr).toBe(0);
      const pkg = join(dir, "package");
      await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
      const port = 21000 + Math.floor(Math.random() * 30000);
      child = spawn(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), "server.ts"], {
        cwd: pkg,
        env: { ...process.env, PI_WEB_DEV: "0", NODE_ENV: "test", PI_WEB_MOCK: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_AUTH_MODE: "none", PI_WEB_TOKEN: "", PI_WEB_AUTH_STORE: join(dir, "auth.json"), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"), PI_WEB_CWD: dir },
        stdio: "pipe",
      });
      let errors = "";
      child.stderr?.on("data", chunk => { errors += chunk; });
      let response: Response | undefined;
      for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) break;
        try { response = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`); break; }
        catch { await delay(100); }
      }
      expect(response?.status, errors).toBe(200);
      expect((await response!.json()).name).toBeTruthy();
      expect((await readFile(join(pkg, "server/shared/appIdentity.ts"), "utf8"))).toContain("avatarPresetIds");
    } finally {
      child?.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
