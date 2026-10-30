import { execFile } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { hashSecret } from "../server/auth/kernel.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

const execFileAsync = promisify(execFile);

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", [
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=always",
    ...args,
  ], { cwd });
}

async function commit(cwd: string, name: string, contents: string) {
  await writeFile(join(cwd, name), contents);
  await git(cwd, "add", name);
  await git(cwd, "commit", "-m", name);
}

async function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* Preserve non-JSON diagnostics. */ }
        resolve({ status: response.statusCode || 0, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForServer(child: ChildProcess, port: number, output: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output());
    try {
      if ((await get(port, "/api/state")).status === 200) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start:\n${output()}`);
}

describe("Git fetch request intent at the HTTP route", () => {
  let child: ChildProcess;
  let port: number;
  let root: string;
  let workspace: string;
  let publisher: string;
  let output = "";

  const sessionSecret = "synthetic-browser-session";
  const apiToken = "synthetic-api-token";
  // Models the configured-origin contract without encoding a real deployment profile.
  const browserOrigin = "https://private-pi.example.test";

  beforeAll(async () => {
    const env = isolatedAuthEnv();
    root = env.PI_WEB_HOME!;
    workspace = join(root, "workspace");
    publisher = join(root, "publisher");
    const remote = join(root, "remote.git");
    const authStore = join(root, "auth.json");
    const now = Date.now();

    await git(root, "init", "--bare", "--initial-branch=main", remote);
    await git(root, "init", "--initial-branch=main", workspace);
    await git(workspace, "config", "user.name", "Pi Web Test");
    await git(workspace, "config", "user.email", "pi-web@example.test");
    await commit(workspace, "base.txt", "base\n");
    await git(workspace, "remote", "add", "origin", remote);
    await git(workspace, "push", "-u", "origin", "main");

    await git(root, "clone", remote, publisher);
    await git(publisher, "config", "user.name", "Pi Web Publisher");
    await git(publisher, "config", "user.email", "publisher@example.test");
    await commit(publisher, "remote-one.txt", "remote one\n");
    await git(publisher, "push", "origin", "main");

    await writeFile(authStore, JSON.stringify({
      version: 1,
      // External callers authenticate first; callers without credentials exercise the open profile.
      config: { policy: "open", methods: ["external"] },
      credentials: [],
      sessions: [{
        hash: hashSecret(sessionSecret),
        identity: { id: "session:browser" },
        method: "external",
        createdAt: now,
        authenticatedAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
      }],
      apiTokens: [{
        id: "automation",
        name: "automation",
        hash: hashSecret(apiToken),
        createdAt: now,
        expiresAt: now + 60_000,
      }],
    }));

    port = await freePort();
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: {
        ...env,
        NODE_ENV: "test",
        PI_WEB_MOCK: "1",
        PI_WEB_DEV: "0",
        PI_WEB_CWD: workspace,
        PI_WEB_AUTH_STORE: authStore,
        PI_WEB_AUTH_MODE: "external",
        PI_WEB_AUTH_POLICY: "open",
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-test-user",
        PI_WEB_AUTH_ORIGIN: browserOrigin,
        PI_WEB_TOKEN: "",
        PI_WEB_SETTINGS_FILE: join(root, "settings.json"),
        PI_WEB_SESSION_UI_STATE_FILE: join(root, "session-ui-state.json"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => { output += data; });
    child.stderr?.on("data", (data) => { output += data; });
    await waitForServer(child, port, () => output);
  }, 70_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("requires browser intent while preserving non-browser API-token fetches", async () => {
    const cookie = `pi_web_session=${sessionSecret}`;
    const trustedBrowser = {
      cookie,
      origin: browserOrigin,
      "sec-fetch-site": "same-origin",
      "x-pi-web-client-id": "synthetic-browser",
    };

    const ordinary = await get(port, "/api/git/status", { cookie });
    expect(ordinary).toMatchObject({ status: 200, body: { ok: true, isRepo: true, behind: 0 } });

    const missingIntent = await get(port, "/api/git/status?fetch=1", {
      cookie,
      origin: browserOrigin,
      "sec-fetch-site": "same-origin",
    });
    expect(missingIntent).toMatchObject({ status: 403, body: { ok: false, error: "CSRF validation failed" } });

    for (const { via, headers } of [
      { via: "external", headers: { "x-test-user": "owner", origin: "https://cross-site.example.test", "sec-fetch-site": "cross-site", "x-pi-web-client-id": "synthetic-browser" } },
      { via: "open", headers: { origin: "https://cross-site.example.test", "sec-fetch-site": "cross-site", "x-pi-web-client-id": "synthetic-browser" } },
    ]) {
      const rejected = await get(port, "/api/git/status?fetch=1", headers);
      expect(rejected.status, via).toBe(403);
      expect(rejected.body.error, via).toContain("Origin does not match Host");
    }

    const stillUnfetched = await get(port, "/api/git/status", { cookie });
    expect(stillUnfetched).toMatchObject({ status: 200, body: { behind: 0 } });

    const browserFetch = await get(port, "/api/git/status?fetch=1", trustedBrowser);
    expect(browserFetch).toMatchObject({ status: 200, body: { ok: true, isRepo: true, behind: 1 } });

    await commit(publisher, "remote-two.txt", "remote two\n");
    await git(publisher, "push", "origin", "main");

    const tokenFetch = await get(port, "/api/git/status?fetch=1", {
      authorization: `Bearer ${apiToken}`,
    });
    expect(tokenFetch).toMatchObject({ status: 200, body: { ok: true, isRepo: true, behind: 2 } });
  }, 30_000);
});
