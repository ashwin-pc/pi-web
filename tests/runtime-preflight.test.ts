import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runtimeFingerprint, runtimePreflight } from "../server/runtimePreflight.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-preflight-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "server"));
  for (const file of ["supervisor.ts", "bin/pi-web.js", "package.json", "package-lock.json", "server/auth.ts"])
    await writeFile(join(root, file), "original");
  return root;
}
it("admits unchanged runtime without stopping anything", async () => {
  const root = await fixture();
  expect(await runtimePreflight(root, await runtimeFingerprint(root))).toEqual({ ok: true });
});
it.each(["supervisor.ts", "server/auth.ts", "package-lock.json", "bin/pi-web.js"])("requires full manual restart after %s changes", async file => {
  const root = await fixture();
  const loaded = await runtimeFingerprint(root);
  await writeFile(join(root, file), "updated");
  expect(await runtimePreflight(root, loaded)).toMatchObject({ ok: false, code: "FULL_RUNTIME_RESTART_REQUIRED" });
});
it("fails closed on incomplete installation or missing startup identity", async () => {
  const root = await fixture();
  expect((await runtimePreflight(root, undefined)).ok).toBe(false);
  const loaded = await runtimeFingerprint(root);
  await rm(join(root, "package-lock.json"));
  expect((await runtimePreflight(root, loaded)).ok).toBe(false);
});
