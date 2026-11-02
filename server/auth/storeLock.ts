import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";

type LockOwner = {
  pid: number;
  nonce: string;
  processStart?: string;
};

type LegacyLock = {
  pid: number;
  identity: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  };
};

export type AuthStoreLock = {
  path: string;
  ownerFile: string;
};

const RETRIES = 100;
const RETRY_MS = 50;

function ownerFileName(owner: LockOwner) {
  return `${owner.pid}-${owner.nonce}.owner`;
}

async function lockCollision(error: unknown, lockPath: string) {
  const code = (error as NodeJS.ErrnoException).code || "";
  if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(code)) return true;
  if (!["EACCES", "EPERM"].includes(code)) return false;
  try {
    await lstat(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processIsDefinitelyDead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function ownerIsAlive(owner: LockOwner) {
  if (!processExists(owner.pid)) return false;
  if (!owner.processStart) return true;
  const currentStart = await processStartIdentity(owner.pid);
  return !currentStart || currentStart === owner.processStart;
}

async function readDirectoryOwner(
  lockPath: string,
): Promise<{ owner: LockOwner; ownerFile: string } | undefined> {
  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    // Regular files are locks created by older pi-web versions and are
    // considered separately by the file-only migration path.
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return undefined;
    throw error;
  }
  if (entries.length !== 1 || !entries[0].isFile()) return undefined;
  const ownerFile = entries[0].name;
  try {
    const owner = JSON.parse(
      await readFile(`${lockPath}/${ownerFile}`, "utf8"),
    ) as LockOwner;
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !/^[a-f0-9]{32}$/.test(owner.nonce) ||
      ownerFile !== ownerFileName(owner)
    )
      return undefined;
    return { owner, ownerFile };
  } catch {
    return undefined;
  }
}

async function readLegacyLock(lockPath: string): Promise<LegacyLock | undefined> {
  let initial: Stats;
  try {
    initial = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!initial.isFile()) return undefined;
  let contents: string;
  try {
    contents = await readFile(lockPath, "utf8");
  } catch (error) {
    if (
      ["ENOENT", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return undefined;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (
    typeof record !== "object" ||
    record === null ||
    !("pid" in record) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0
  )
    return undefined;
  return {
    pid: record.pid as number,
    identity: {
      dev: initial.dev,
      ino: initial.ino,
      size: initial.size,
      mtimeMs: initial.mtimeMs,
    },
  };
}

async function isSameLegacyFile(lockPath: string, pending: LegacyLock) {
  try {
    const current = await lstat(lockPath);
    return (
      current.isFile() &&
      current.dev === pending.identity.dev &&
      current.ino === pending.identity.ino &&
      current.size === pending.identity.size &&
      current.mtimeMs === pending.identity.mtimeMs
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectoryOrMissing(lockPath: string) {
  try {
    return (await lstat(lockPath)).isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function recoverLegacyLock(lockPath: string) {
  const pending = await readLegacyLock(lockPath);
  if (
    !pending ||
    !processIsDefinitelyDead(pending.pid) ||
    !(await isSameLegacyFile(lockPath, pending))
  )
    return false;
  try {
    // File-only migration is the race-safety boundary: unlink cannot remove a
    // modern writer's nonempty lock directory if it replaces the old record.
    await unlink(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || "";
    if (code === "ENOENT" || code === "EISDIR") return false;
    if (code === "EPERM" && (await isDirectoryOrMissing(lockPath))) return false;
    throw error;
  }
}

async function recoverEmptyDirectory(lockPath: string) {
  try {
    // Current writers only publish populated directories. A replacement that
    // wins this race is nonempty and therefore cannot be removed by rmdir.
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return false;
    throw error;
  }
}

export async function releaseAuthStoreLock(lock: AuthStoreLock) {
  try {
    await unlink(`${lock.path}/${lock.ownerFile}`);
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      throw error;
  }
  try {
    await rmdir(lock.path);
  } catch (error) {
    // A new writer may atomically replace the now-empty directory. Its
    // different owner filename remains intact, and its nonempty directory
    // cannot be removed here.
    if (
      !["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      throw error;
  }
}

export async function recoverStaleAuthStoreLock(lockPath: string) {
  const pending = await readDirectoryOwner(lockPath);
  if (pending) {
    if (await ownerIsAlive(pending.owner)) return false;
    await releaseAuthStoreLock({
      path: lockPath,
      ownerFile: pending.ownerFile,
    });
    return true;
  }
  if (await recoverLegacyLock(lockPath)) return true;
  return recoverEmptyDirectory(lockPath);
}

export async function acquireAuthStoreLock(
  lockPath: string,
): Promise<AuthStoreLock> {
  const owner: LockOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    processStart: await processStartIdentity(process.pid),
  };
  const ownerFile = ownerFileName(owner);
  const preparedPath = `${lockPath}.${owner.nonce}.pending`;
  await mkdir(preparedPath, { mode: 0o700 });
  await writeFile(`${preparedPath}/${ownerFile}`, JSON.stringify(owner), {
    flag: "wx",
    mode: 0o400,
  });
  try {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        await rename(preparedPath, lockPath);
        return { path: lockPath, ownerFile };
      } catch (error) {
        if (!(await lockCollision(error, lockPath))) throw error;
        if (await recoverStaleAuthStoreLock(lockPath)) continue;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
    throw new Error(`Auth store is locked: ${lockPath}`);
  } finally {
    try {
      await unlink(`${preparedPath}/${ownerFile}`);
      await rmdir(preparedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
