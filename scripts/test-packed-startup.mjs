import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Run the actual tarball entrypoint: source-tree imports can otherwise hide
// missing files from the published package allowlist.
async function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "pi-web-package-"));
  let child;
  try {
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(dir, JSON.parse(packed.stdout)[0].filename);
    const extract = spawnSync("tar", ["-xf", tarball, "-C", dir], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const pkg = join(dir, "package");
    await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
    const port = 21000 + Math.floor(Math.random() * 30000);
    await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 1, identity: { name: "Backup Brand", shortName: "Backup", avatar: { type: "custom" }, revision: 3 } }));
    child = spawn(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), "server.ts"], {
      cwd: pkg,
      env: { ...process.env, PI_WEB_DEV: "0", NODE_ENV: "test", PI_WEB_MOCK: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_AUTH_MODE: "none", PI_WEB_TOKEN: "", PI_WEB_AUTH_STORE: join(dir, "auth.json"), PI_WEB_SETTINGS_FILE: join(dir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"), PI_WEB_CWD: dir },
      stdio: "pipe",
    });
    let errors = "";
    child.stderr?.on("data", chunk => { errors += chunk; });
    let response;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) break;
      try { response = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`); break; }
      catch { await delay(100); }
    }
    assert.equal(response?.status, 200, errors);
    assert.equal((await response.json()).name, "Backup Brand");
    const avatar = await fetch(`http://127.0.0.1:${port}/identity/avatar.png`, { redirect: "manual" });
    assert.equal(avatar.status, 302);
    assert.equal(avatar.headers.get("location"), "/avatars/current-pi/still.png");
    const icon = await fetch(`http://127.0.0.1:${port}/identity/icon.png`, { redirect: "manual" });
    assert.equal(icon.headers.get("location"), "/avatars/current-pi/icon.png");
    assert.equal((await fetch(`http://127.0.0.1:${port}/identity/avatar.png`)).status, 200);
    assert.match(await readFile(join(pkg, "server/shared/appIdentity.ts"), "utf8"), /avatarPresetIds/);
  } finally {
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
console.log("Packed npm server and fallback avatar: passed");
