import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { stopPackedServer } from "./packed-server-process.mjs";
import { availableLoopbackPort, isRetryableBindFailure } from "./packed-test-port.mjs";

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
    const packageInfo = JSON.parse(packed.stdout)[0];
    // Budget guards against accidentally publishing duplicate/unconsumed motion.
    assert.ok(packageInfo.size < 24 * 1024 * 1024, `Compressed package exceeds 24 MiB: ${packageInfo.size}`);
    assert.ok(packageInfo.unpackedSize < 28 * 1024 * 1024, `Unpacked package exceeds 28 MiB: ${packageInfo.unpackedSize}`);
    assert.equal(packageInfo.files.filter(({ path }) => /(?:^|\/)avatars\/.*\/new-session\.webm$/.test(path)).length, 0);
    assert.equal(packageInfo.files.filter(({ path }) => /(?:new-chat-loading\.(?:mp4|webm)|new-chat-still\.png|pi-mascot-avatar\.png)$/.test(path)).length, 0);
    const tarball = join(dir, packageInfo.filename);
    const extract = spawnSync("tar", ["-xf", tarball, "-C", dir], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const pkg = join(dir, "package");
    await symlink(join(root, "node_modules"), join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 1, identity: { name: "Backup Brand", shortName: "Backup", avatar: { type: "custom" }, revision: 3 } }));
    const isolatedEnv = { ...process.env, PI_WEB_HOME: join(dir, "web-home") };
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith("PI_WEB_AUTH_") || key === "PI_WEB_TOKEN" || (key.startsWith("PI_WEB_") && key.endsWith("_FILE"))) isolatedEnv[key] = "";
    }
    let response;
    let port;
    for (let attempt = 0; attempt < 3; attempt++) {
      port = await availableLoopbackPort();
      // Node's ESM --import requires a file URL for absolute Windows drive paths.
      child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, "server.ts"], {
        cwd: pkg,
        env: { ...isolatedEnv, PI_WEB_DEV: "0", NODE_ENV: "test", PI_WEB_MOCK: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_AUTH_MODE: "none", PI_WEB_TOKEN: "", PI_WEB_AUTH_STORE: join(dir, "auth.json"), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"), PI_WEB_CWD: dir },
        stdio: "pipe",
      });
      // Attach before any await: 'exit' can precede 'close', which releases the
      // Windows working-directory lock and all inherited stdio handles.
      childClosed = new Promise(resolve => child.once("close", resolve));
      child.once("error", error => { spawnError = error; });
      let output = "";
      let errors = "";
      let lastFetchError;
      const startupStarted = Date.now();
      // Drain both pipes so startup cannot block on an unread stdout buffer.
      child.stdout?.on("data", chunk => { output += chunk; });
      child.stderr?.on("data", chunk => { errors += chunk; });
      // A fresh extraction has no tsx transform cache for its source paths.
      // Cold SDK imports alone can take several seconds before server.ts runs;
      // measured packed startup exceeds 10s even without concurrent tests.
      // Use a wall-clock deadline, not a poll count, and bound each HTTP probe
      // so an accepted connection that never responds cannot hang this check.
      const startupDeadline = startupStarted + 30_000;
      while (Date.now() < startupDeadline) {
        if (spawnError || child.exitCode !== null) break;
        try {
          response = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`, {
            signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, startupDeadline - Date.now()))),
          });
          break;
        } catch (error) {
          lastFetchError = error;
          await delay(Math.min(100, Math.max(0, startupDeadline - Date.now())));
        }
      }
      if (response?.status === 200) break;
      // 'exit' can precede the final stderr data; classify only after it drains.
      if (child.exitCode !== null) await childClosed;
      if (attempt < 2 && !spawnError && isRetryableBindFailure(errors)) {
        // The OS port probe and child bind are separate; another process can
        // claim the port between them. Fully close the failed child first.
        await stopPackedServer(child, childClosed);
        child = undefined;
        childClosed = undefined;
        continue;
      }
      assert.equal(response?.status, 200, [
        `Packed server not ready after ${Date.now() - startupStarted}ms at http://127.0.0.1:${port}/manifest.webmanifest`,
        `pid=${child.pid}, exitCode=${child.exitCode}, signal=${child.signalCode}`,
        `spawn error: ${spawnError?.stack || "none"}`,
        `last fetch error: ${lastFetchError?.stack || "none"}; cause: ${lastFetchError?.cause || "none"}`,
        `stdout:\n${output || "<empty>"}`,
        `stderr:\n${errors || "<empty>"}`,
      ].join("\n"));
    }
    assert.equal(response?.status, 200);
    assert.equal((await response.json()).name, "Backup Brand");
    const avatar = await fetch(`http://127.0.0.1:${port}/identity/avatar.png`, { redirect: "manual" });
    assert.equal(avatar.status, 302);
    assert.equal(avatar.headers.get("location"), "/avatars/current-pi/still.png");
    const icon = await fetch(`http://127.0.0.1:${port}/identity/icon.png`, { redirect: "manual" });
    assert.equal(icon.headers.get("location"), "/avatars/current-pi/icon.png");
    assert.equal((await fetch(`http://127.0.0.1:${port}/identity/avatar.png`)).status, 200);
    assert.match(await readFile(join(pkg, "server/shared/appIdentity.ts"), "utf8"), /avatarPresetIds/);
    // Assert against the actual packaged Workbox manifest, not just Vite config.
    assert.match(await readFile(join(pkg, "dist/sw.js"), "utf8"), /avatars\/current-pi\/still\.png/);
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
