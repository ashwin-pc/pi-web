import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { stopPackedServer } from "./packed-server-process.mjs";

// Test the actual npm tarball after build: source-tree imports can hide files
// omitted from the published package, while an unbuilt tree has no static assets.
// Reuse installed dependencies through a link; never install/download a second
// dependency tree just to verify the extracted server and HTTP artwork routes.
async function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "pi-web-package-"));
  let child;
  let childClosed;
  let spawnError;
  let primaryError;
  try {
    // npm_execpath is the portable npm CLI supplied by `npm run test:package`.
    // Invoke it through Node rather than spawning a Windows .cmd file directly.
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "Run the packaged startup check with npm run test:package");
    const packed = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(dir, JSON.parse(packed.stdout)[0].filename);
    const extract = spawnSync("tar", ["-xf", tarball, "-C", dir], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const pkg = join(dir, "package");
    await symlink(join(root, "node_modules"), join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const port = 21000 + Math.floor(Math.random() * 30000);
    await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 1, identity: { name: "Backup Brand", shortName: "Backup", avatar: { type: "custom" }, revision: 3 } }));
    // Node's ESM --import requires a file URL for absolute Windows drive paths.
    child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, "server.ts"], {
      cwd: pkg,
      env: { ...process.env, PI_WEB_DEV: "0", NODE_ENV: "test", PI_WEB_MOCK: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_AUTH_MODE: "none", PI_WEB_TOKEN: "", PI_WEB_AUTH_STORE: join(dir, "auth.json"), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"), PI_WEB_CWD: dir },
      stdio: "pipe",
    });
    // Attach before any await: 'exit' can precede 'close', which releases the
    // Windows working-directory lock and all inherited stdio handles.
    childClosed = new Promise(resolve => child.once("close", resolve));
    child.once("error", error => { spawnError = error; });
    let errors = "";
    child.stderr?.on("data", chunk => { errors += chunk; });
    let response;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) break;
      try { response = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`); break; }
      catch { await delay(100); }
    }
    assert.equal(response?.status, 200, spawnError || errors);
    assert.equal((await response.json()).name, "Backup Brand");
    const avatar = await fetch(`http://127.0.0.1:${port}/identity/avatar.png`, { redirect: "manual" });
    assert.equal(avatar.status, 302);
    assert.equal(avatar.headers.get("location"), "/avatars/current-pi/still.png");
    const icon = await fetch(`http://127.0.0.1:${port}/identity/icon.png`, { redirect: "manual" });
    assert.equal(icon.headers.get("location"), "/avatars/current-pi/icon.png");
    assert.equal((await fetch(`http://127.0.0.1:${port}/identity/avatar.png`)).status, 200);
    assert.match(await readFile(join(pkg, "server/shared/appIdentity.ts"), "utf8"), /avatarPresetIds/);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Windows keeps a process's working directory locked until its stdio and
    // handles close. Preserve both the test and cleanup errors if either fails.
    try {
      await stopPackedServer(child, childClosed);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "Packed server and cleanup failed");
      throw cleanupError;
    }
  }
}

await main();
console.log("Packed npm server and fallback avatar: passed");
