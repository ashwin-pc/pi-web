import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStore } from "../../server/auth/kernel.js";

function waitForReady(child: ChildProcess, stderr: () => string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for child writer readiness")),
      10_000,
    );
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "lock-held"
      )
        finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `Child writer exited before readiness (${code ?? signal}): ${stderr()}`,
        ),
      );
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for child writer to exit")),
      5_000,
    );
    const onExit = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.on("exit", onExit);
  });
}

describe("AuthStore crash recovery", () => {
  it("automatically recovers a SIGKILLed writer without losing committed state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-recovery-"));
    const store = new AuthStore(join(directory, "auth.json"));
    const revokedAt = Date.now();
    await store.update((state) => {
      state.credentials.push({
        id: "revoked-passkey",
        publicKey: "stored-public-key",
        counter: 7,
        name: "Revoked passkey",
        createdAt: revokedAt - 1,
        revokedAt,
      });
      state.verifiedMethods = ["passkey"];
    });

    const writer = `
      import { AuthStore } from "./server/auth/kernel.ts";
      const store = new AuthStore(process.env.PI_TEST_AUTH_STORE);
      const keepAlive = setInterval(() => {}, 1000);
      void store.update(async state => {
        const credential = state.credentials.find(
          item => item.id === "revoked-passkey"
        );
        if (credential?.revokedAt !== Number(process.env.PI_TEST_REVOKED_AT))
          throw new Error("Child did not read the committed revocation");
        state.apiTokens.push({
          id: "uncommitted-child-token",
          name: "Uncommitted child token",
          hash: "uncommitted",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000
        });
        process.send({ type: "lock-held" });
        await new Promise(resolve => process.once("message", resolve));
      }).then(
        () => {
          clearInterval(keepAlive);
          process.exit(0);
        },
        error => {
          console.error(error);
          clearInterval(keepAlive);
          process.exit(1);
        }
      );
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", writer],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_TEST_AUTH_STORE: store.path,
          PI_TEST_REVOKED_AT: String(revokedAt),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await waitForReady(child, () => stderr);
      await expect(access(`${store.path}.lock`)).resolves.toBeUndefined();

      expect(child.kill("SIGKILL")).toBe(true);
      await waitForExit(child);

      await store.update((state) => {
        state.apiTokens.push({
          id: "recovered-parent-token",
          name: "Recovered parent token",
          hash: "recovered",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
      });

      const recovered = await store.read();
      expect(recovered.verifiedMethods).toEqual(["passkey"]);
      expect(recovered.credentials).toEqual([
        expect.objectContaining({
          id: "revoked-passkey",
          publicKey: "stored-public-key",
          counter: 7,
          revokedAt,
        }),
      ]);
      expect(recovered.credentials.filter((credential) => !credential.revokedAt))
        .toEqual([]);
      expect(recovered.apiTokens.map((token) => token.id)).toEqual([
        "recovered-parent-token",
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
  }, 20_000);
});
