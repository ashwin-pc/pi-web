import { vi } from "vitest";

type Unlink = typeof import("node:fs/promises").unlink;

const unlinkRace = vi.hoisted(() => ({
  path: "",
  beforeUnlink: undefined as undefined | ((unlink: Unlink) => Promise<void>),
  cleanupAttempted: undefined as undefined | (() => void),
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    unlink: async (path: Parameters<Unlink>[0]) => {
      let intercepted = false;
      if (String(path) === unlinkRace.path && unlinkRace.beforeUnlink) {
        const beforeUnlink = unlinkRace.beforeUnlink;
        unlinkRace.beforeUnlink = undefined;
        intercepted = true;
        await beforeUnlink(actual.unlink);
      }
      try {
        return await actual.unlink(path);
      } finally {
        if (intercepted) {
          const cleanupAttempted = unlinkRace.cleanupAttempted;
          unlinkRace.cleanupAttempted = undefined;
          cleanupAttempted?.();
        }
      }
    },
  };
});

import {
  access,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "../../server/auth/kernel.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withDeadline<T>(promise: Promise<T>, label: string, ms = 3_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

afterEach(() => {
  unlinkRace.path = "";
  unlinkRace.beforeUnlink = undefined;
  unlinkRace.cleanupAttempted = undefined;
});

describe("public AuthStore legacy lock recovery", () => {
  it("cannot unlink a replacement writer's lock during stale cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-public-race-"));
    const path = join(directory, "auth.json");
    const lockPath = `${path}.lock`;
    const storeA = new AuthStore(path);
    const storeB = new AuthStore(path);
    const bReady = deferred();
    const releaseB = deferred();
    const cleanupAttempted = deferred();
    let updateA: Promise<unknown> | undefined;
    let updateB: Promise<unknown> | undefined;
    let lockSurvivedCleanup = false;
    let finalRevokedAt: number | undefined;

    try {
      await storeA.update((state) => {
        state.credentials.push({
          id: "credential-under-test",
          publicKey: "synthetic-public-key",
          counter: 0,
          name: "Synthetic credential",
          createdAt: 1,
        });
      });
      await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), {
        mode: 0o600,
      });

      unlinkRace.path = lockPath;
      unlinkRace.cleanupAttempted = cleanupAttempted.resolve;
      unlinkRace.beforeUnlink = async (actualUnlink) => {
        await actualUnlink(lockPath);
        updateB = storeB.update(async (state) => {
          const credential = state.credentials.find(
            ({ id }) => id === "credential-under-test",
          );
          if (!credential) throw new Error("Seed credential disappeared");
          credential.revokedAt = 2;
          bReady.resolve();
          await releaseB.promise;
        });
        await withDeadline(bReady.promise, "replacement writer readiness");
      };

      updateA = storeA.update((state) => {
        state.verifiedMethods = ["password"];
      });

      await withDeadline(
        cleanupAttempted.promise,
        "delayed shared-path cleanup",
      );
      lockSurvivedCleanup = await access(lockPath).then(
        () => true,
        () => false,
      );
    } finally {
      releaseB.resolve();
      const updates = [updateA, updateB].filter(
        (update): update is Promise<unknown> => update !== undefined,
      );
      try {
        await withDeadline(Promise.allSettled(updates), "AuthStore updates");
        finalRevokedAt = (await storeA.read()).credentials.find(
          ({ id }) => id === "credential-under-test",
        )?.revokedAt;
      } finally {
        unlinkRace.beforeUnlink = undefined;
        await unlink(lockPath).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }

    expect(lockSurvivedCleanup).toBe(true);
    expect(finalRevokedAt).toBe(2);
  });
});
