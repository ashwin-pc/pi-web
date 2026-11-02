import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthStore } from "../../server/auth/kernel.js";
import {
  recoverStaleAuthStoreLock,
  releaseAuthStoreLock,
} from "../../server/auth/storeLock.js";

const run = promisify(execFile);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-lock-"));
  return new AuthStore(join(dir, "auth.json"));
}

async function installDirectoryLock(
  lockPath: string,
  pid: number,
  nonce: string,
  processStart?: string,
) {
  const ownerFile = `${pid}-${nonce}.owner`;
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    `${lockPath}/${ownerFile}`,
    JSON.stringify({ pid, nonce, processStart }),
    { mode: 0o400 },
  );
  return ownerFile;
}

describe("auth store directory lock", () => {
  it("installs only a populated lock directory and releases it after a write", async () => {
    const store = await fixture();
    let entries: string[] = [];
    await store.update(async (state) => {
      entries = await readdir(`${store.path}.lock`);
      state.verifiedMethods = ["password"];
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\d+-[a-f0-9]{32}\.owner$/);
    await expect(access(`${store.path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("automatically recovers a dead owner but refuses a live owner", async () => {
    const store = await fixture();
    const lockPath = `${store.path}.lock`;
    await installDirectoryLock(lockPath, 2_147_483_647, "a".repeat(32));
    await store.update((state) => {
      state.verifiedMethods = ["password"];
    });
    expect((await store.read()).verifiedMethods).toEqual(["password"]);

    const liveOwner = await installDirectoryLock(
      lockPath,
      process.pid,
      "b".repeat(32),
    );
    expect(await recoverStaleAuthStoreLock(lockPath)).toBe(false);
    expect(await readdir(lockPath)).toEqual([liveOwner]);
  });

  it.runIf(process.platform === "linux")(
    "does not confuse a reused live PID with the dead owner",
    async () => {
      const store = await fixture();
      const lockPath = `${store.path}.lock`;
      await installDirectoryLock(
        lockPath,
        process.pid,
        "c".repeat(32),
        "not-this-process-start",
      );
      expect(await recoverStaleAuthStoreLock(lockPath)).toBe(true);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cannot remove a substituted writer or resurrect a reaped owner", async () => {
    const store = await fixture();
    const lockPath = `${store.path}.lock`;
    const staleOwner = await installDirectoryLock(
      lockPath,
      2_147_483_647,
      "d".repeat(32),
    );
    const recoveries = await Promise.all([
      recoverStaleAuthStoreLock(lockPath),
      recoverStaleAuthStoreLock(lockPath),
    ]);
    expect(recoveries.some(Boolean)).toBe(true);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const replacementOwner = await installDirectoryLock(
      lockPath,
      process.pid,
      "e".repeat(32),
    );
    await releaseAuthStoreLock({ path: lockPath, ownerFile: staleOwner });
    expect(await readdir(lockPath)).toEqual([replacementOwner]);
  });

  it("never removes a live legacy regular-file lock", async () => {
    const store = await fixture();
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    expect(await recoverStaleAuthStoreLock(lockPath)).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({
      pid: process.pid,
    });
  });

  it("migrates a dead legacy regular-file lock through AuthStore.update", async () => {
    const store = await fixture();
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), {
      mode: 0o600,
    });
    await store.update((state) => {
      state.verifiedMethods = ["password"];
    });
    expect((await store.read()).verifiedMethods).toEqual(["password"]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ pid: 0 }),
    JSON.stringify({ pid: "1" }),
  ])(
    "never removes a malformed legacy regular-file lock: %s",
    async (record) => {
      const store = await fixture();
      const lockPath = `${store.path}.lock`;
      await writeFile(lockPath, record, { mode: 0o600 });
      expect(await recoverStaleAuthStoreLock(lockPath)).toBe(false);
      expect(await readFile(lockPath, "utf8")).toBe(record);
    },
  );

  it("serializes multiprocess writes and leaves no lock resurrection", async () => {
    const store = await fixture();
    const worker = `
      import { AuthStore } from "./server/auth/kernel.ts";
      const store = new AuthStore(process.env.PI_TEST_AUTH_STORE);
      const prefix = process.env.PI_TEST_AUTH_PREFIX;
      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        store.update(state => {
          state.apiTokens.push({
            id: prefix + index,
            name: prefix,
            hash: prefix,
            createdAt: index,
            expiresAt: Date.now() + 60000
          });
        })
      ));
    `;
    await Promise.all(
      ["first-", "second-"].map((prefix) =>
        run(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", worker],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PI_TEST_AUTH_STORE: store.path,
              PI_TEST_AUTH_PREFIX: prefix,
            },
          },
        ),
      ),
    );
    expect((await store.read()).apiTokens).toHaveLength(16);
    await expect(access(`${store.path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await store.update((state) => {
      state.verifiedMethods = ["password"];
    });
    expect((await store.read()).verifiedMethods).toEqual(["password"]);
  }, 15_000);
});
