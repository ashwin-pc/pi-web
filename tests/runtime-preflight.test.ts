import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runtimeFingerprint, runtimePreflight, supervisorDependencyFiles } from "../server/runtimePreflight.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-preflight-"));
  roots.push(root);
  for (const file of [...supervisorDependencyFiles, "server/session/x.ts", "bin/pi-web.js", "package.json", "package-lock.json"]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), file === "package.json" ? "{}" : "original");
  }
  for (const name of ["@earendil-works/pi-coding-agent", "tsx"]) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    await writeFile(join(directory, "index.js"), "");
  }
  return root;
}
it("admits unchanged runtime", async () => {
  const root = await fixture();
  expect(await runtimePreflight(root, await runtimeFingerprint(root))).toEqual({ ok: true });
});
it.each(supervisorDependencyFiles)("requires manual restart after %s changes", async file => {
  const root = await fixture();
  const loaded = await runtimeFingerprint(root);
  await writeFile(join(root, file), "updated");
  expect(await runtimePreflight(root, loaded)).toMatchObject({ ok: false, code: "FULL_RUNTIME_RESTART_REQUIRED" });
});
it.each(["server/session/x.ts", "bin/pi-web.js", "package.json", "package-lock.json"])("allows child-only or unloaded metadata change: %s", async file => {
  const root = await fixture();
  const loaded = await runtimeFingerprint(root);
  await writeFile(join(root, file), file === "package.json" ? '{"version":"2.0.0"}' : "updated");
  expect(await runtimePreflight(root, loaded)).toEqual({ ok: true });
});
it("supports published layouts without a lockfile but detects installed dependency version changes", async () => {
  const root = await fixture();
  await rm(join(root, "package-lock.json"));
  const loaded = await runtimeFingerprint(root);
  await writeFile(join(root, "node_modules/tsx/package.json"), JSON.stringify({ name: "tsx", version: "2.0.0", main: "index.js" }));
  expect((await runtimePreflight(root, loaded)).ok).toBe(false);
});
it("fails closed on incomplete installation or missing startup identity", async () => {
  const root = await fixture();
  expect((await runtimePreflight(root, undefined)).ok).toBe(false);
  const loaded = await runtimeFingerprint(root);
  await rm(join(root, "server/auth/kernel.ts"));
  expect((await runtimePreflight(root, loaded)).ok).toBe(false);
});
