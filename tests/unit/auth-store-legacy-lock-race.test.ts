import { vi } from "vitest";

const fsRace = vi.hoisted(() => ({
  unlinkPath: "",
  replaceBeforeUnlink: undefined as undefined | (() => Promise<void>),
  unlinkError: "",
  renameDestination: "",
  renameError: "",
  renameErrorObserved: undefined as undefined | (() => void),
  disappearBeforeLstat: undefined as undefined | (() => Promise<void>),
  lstatPath: "",
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (String(path) === fsRace.unlinkPath && fsRace.replaceBeforeUnlink) {
        const replace = fsRace.replaceBeforeUnlink;
        fsRace.replaceBeforeUnlink = undefined;
        await replace();
        if (fsRace.unlinkError) {
          throw Object.assign(new Error(fsRace.unlinkError), {
            code: fsRace.unlinkError,
          });
        }
      }
      return actual.unlink(path);
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (
        String(newPath) === fsRace.renameDestination &&
        fsRace.renameError
      ) {
        const code = fsRace.renameError;
        fsRace.renameError = "";
        fsRace.renameErrorObserved?.();
        throw Object.assign(new Error(code), { code });
      }
      return actual.rename(oldPath, newPath);
    },
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (String(path) === fsRace.lstatPath && fsRace.disappearBeforeLstat) {
        const disappear = fsRace.disappearBeforeLstat;
        fsRace.disappearBeforeLstat = undefined;
        await disappear();
      }
      return actual.lstat(path);
    },
  };
});

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireAuthStoreLock,
  recoverStaleAuthStoreLock,
  releaseAuthStoreLock,
} from "../../server/auth/storeLock.js";

afterEach(() => {
  vi.useRealTimers();
  fsRace.unlinkPath = "";
  fsRace.replaceBeforeUnlink = undefined;
  fsRace.unlinkError = "";
  fsRace.renameDestination = "";
  fsRace.renameError = "";
  fsRace.renameErrorObserved = undefined;
  fsRace.lstatPath = "";
  fsRace.disappearBeforeLstat = undefined;
});

describe("legacy auth store lock migration races", () => {
  it("leaves a modern nonempty replacement directory and owner intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-lock-race-"));
    const lockPath = join(directory, "auth.json.lock");
    const displacedPath = join(directory, "legacy.lock");
    const nonce = "f".repeat(32);
    const ownerFile = `${process.pid}-${nonce}.owner`;
    const ownerRecord = JSON.stringify({ pid: process.pid, nonce });
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), {
      mode: 0o600,
    });

    fsRace.unlinkPath = lockPath;
    fsRace.replaceBeforeUnlink = async () => {
      await rename(lockPath, displacedPath);
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, ownerFile), ownerRecord, { mode: 0o400 });
    };

    expect(await recoverStaleAuthStoreLock(lockPath)).toBe(false);
    expect(await readdir(lockPath)).toEqual([ownerFile]);
    expect(await readFile(join(lockPath, ownerFile), "utf8")).toBe(ownerRecord);
    expect(JSON.parse(await readFile(displacedPath, "utf8"))).toEqual({
      pid: 2_147_483_647,
    });
  });

  it("tolerates a Windows file cleanup error when its replacement disappears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-lock-race-"));
    const lockPath = join(directory, "auth.json.lock");
    const displacedPath = join(directory, "legacy.lock");
    const ownerFile = `${process.pid}-${"e".repeat(32)}.owner`;
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), {
      mode: 0o600,
    });

    fsRace.unlinkPath = lockPath;
    fsRace.unlinkError = "EPERM";
    fsRace.replaceBeforeUnlink = async () => {
      await rename(lockPath, displacedPath);
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, ownerFile),
        JSON.stringify({ pid: process.pid, nonce: "e".repeat(32) }),
        { mode: 0o400 },
      );
      fsRace.lstatPath = lockPath;
      fsRace.disappearBeforeLstat = async () => {
        await unlink(join(lockPath, ownerFile));
        await rmdir(lockPath);
      };
    };

    expect(await recoverStaleAuthStoreLock(lockPath)).toBe(false);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(displacedPath, "utf8"))).toEqual({
      pid: 2_147_483_647,
    });
  });
});

describe("Windows auth store rename collisions", () => {
  it("does not treat EACCES as contention when no shared lock exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-lock-race-"));
    const lockPath = join(directory, "auth.json.lock");
    fsRace.renameDestination = lockPath;
    fsRace.renameError = "EACCES";

    await expect(acquireAuthStoreLock(lockPath)).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an empty leftover directory after EACCES", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-lock-race-"));
    const lockPath = join(directory, "auth.json.lock");
    await mkdir(lockPath, { mode: 0o700 });
    fsRace.renameDestination = lockPath;
    fsRace.renameError = "EACCES";

    const lock = await acquireAuthStoreLock(lockPath);
    expect(await readdir(lockPath)).toEqual([lock.ownerFile]);
    await releaseAuthStoreLock(lock);
  });

  it("preserves a live populated replacement after EPERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-lock-race-"));
    const lockPath = join(directory, "auth.json.lock");
    const nonce = "d".repeat(32);
    const ownerFile = `${process.pid}-${nonce}.owner`;
    const ownerRecord = JSON.stringify({ pid: process.pid, nonce });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, ownerFile), ownerRecord, { mode: 0o400 });
    fsRace.renameDestination = lockPath;
    fsRace.renameError = "EPERM";
    const collision = new Promise<void>((resolve) => {
      fsRace.renameErrorObserved = resolve;
    });

    const acquisition = acquireAuthStoreLock(lockPath);
    await collision;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await readdir(lockPath)).toEqual([ownerFile]);
    expect(await readFile(join(lockPath, ownerFile), "utf8")).toBe(ownerRecord);

    await unlink(join(lockPath, ownerFile));
    await rmdir(lockPath);
    const lock = await acquisition;
    await releaseAuthStoreLock(lock);
  });
});
