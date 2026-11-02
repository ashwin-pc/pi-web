import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import webPush from "web-push";
import { AuthStore } from "../server/auth/kernel.js";
import { mintStoredApiToken } from "./auth-fixture.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

it("retains browser push registration when authenticated access is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-push-auth-transition-"));
  const file = join(root, "push.json");
  const authEnv = isolatedAuthEnv();
  const { secret: token } = await mintStoredApiToken(new AuthStore(authEnv.PI_WEB_AUTH_STORE!), "push transition");
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-installation",
    keys: { p256dh: "synthetic-encryption-key", auth: "synthetic-auth-key" },
  };
  const vapid = webPush.generateVAPIDKeys();
  await writeFile(file, JSON.stringify({
    version: 1,
    vapid,
    subscriptions: [{
      id: createHash("sha256").update(subscription.endpoint).digest("hex").slice(0, 24),
      installationId: "same-browser",
      identityId: "none",
      subscription,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));

  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  let child: ChildProcess | undefined;
  let stderr = "";
  try {
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: process.cwd(),
      env: {
        ...authEnv,
        NODE_ENV: "test",
        PI_WEB_DEV: "0",
        PI_WEB_MOCK: "1",
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_PUSH_FILE: file,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => { stderr += String(data); });
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited: ${stderr}`);
      try {
        if ((await fetch(`${base}/api/state`, { headers, signal: AbortSignal.timeout(1_000) })).ok) {
          ready = true;
          break;
        }
      } catch { /* wait for this isolated server */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, stderr).toBe(true);

    const body = JSON.stringify({ installationId: "same-browser", subscription });
    expect((await fetch(`${base}/api/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    })).status).toBe(401);
    const refreshed = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers, body });
    expect(refreshed.status, await refreshed.text()).toBe(200);
    const refreshedState = JSON.parse(await readFile(file, "utf8"));
    expect(refreshedState.vapid).toEqual(vapid);
    expect(refreshedState.subscriptions).toHaveLength(1);

    const remove = (installationId: string) => fetch(`${base}/api/push/subscribe`, {
      method: "DELETE", headers,
      body: JSON.stringify({ installationId, endpoint: subscription.endpoint }),
    });
    expect((await remove("another-browser")).status).toBe(200);
    expect(JSON.parse(await readFile(file, "utf8")).subscriptions).toHaveLength(1);
    expect((await remove("same-browser")).status).toBe(200);
    expect(JSON.parse(await readFile(file, "utf8")).subscriptions).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
