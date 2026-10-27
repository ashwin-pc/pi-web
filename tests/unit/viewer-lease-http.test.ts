import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "../../server/auth/kernel.js";
import { isolatedAuthEnv } from "../auth-isolation.js";

type Lifecycle = {
  liveSessions: Array<{ sessionId: string; viewerLeases: number }>;
  viewerLeases: Array<{
    clientId: string;
    sessionId: string;
    sockets: number;
  }>;
};

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function waitForServer(origin: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${output()}`);
    try {
      const response = await fetch(`${origin}/api/auth/challenge`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Retry while the TypeScript server process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start:\n${output()}`);
}

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected browser session cookie");
  return value.split(";")[0];
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBeLessThan(300);
  return JSON.parse(body) as T;
}

function browserHeaders(cookie: string, clientId: string, origin: string, seq?: number) {
  return {
    cookie,
    origin,
    "content-type": "application/json",
    "x-pi-web-client-id": clientId,
    ...(seq === undefined ? {} : { "x-pi-web-viewer-seq": String(seq) }),
  };
}

async function openSocket(
  origin: string,
  ticket: string,
  clientId: string,
  sessionId: string,
) {
  const url = new URL(origin);
  const socket = new WebSocket(
    `ws://${url.host}/ws?ticket=${encodeURIComponent(ticket)}&clientId=${encodeURIComponent(clientId)}&sessionId=${encodeURIComponent(sessionId)}`,
    { origin },
  );
  const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type === "hello") resolve(message);
    });
  });
  return { socket, hello };
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === socket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

function expectPrivateLifecycle(
  lifecycle: Lifecycle,
  ownClientIds: string[],
  foreignClientIds: string[],
) {
  expect(lifecycle.viewerLeases.map((lease) => lease.clientId).sort()).toEqual(
    [...ownClientIds].sort(),
  );
  const serialized = JSON.stringify(lifecycle);
  for (const clientId of foreignClientIds) expect(serialized).not.toContain(clientId);

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      expect(isAbsolute(value)).toBe(false);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(lifecycle);
}

describe("viewer lease credential plumbing over HTTP and WebSocket", () => {
  const apiSecrets = { first: "api-token-first", second: "api-token-second" };
  let child: ChildProcess;
  let origin: string;
  let home: string;
  let output = "";

  beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const env = isolatedAuthEnv();
    home = env.PI_WEB_HOME!;
    const now = Date.now();
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        version: 1,
        config: { policy: "authenticated", methods: ["external"] },
        verifiedMethods: ["external"],
        credentials: [],
        sessions: [],
        apiTokens: [
          {
            id: "first",
            name: "first automation token",
            hash: hashSecret(apiSecrets.first),
            createdAt: now,
            expiresAt: now + 60_000,
          },
          {
            id: "second",
            name: "second automation token",
            hash: hashSecret(apiSecrets.second),
            createdAt: now,
            expiresAt: now + 60_000,
          },
        ],
      }),
    );
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: {
        ...env,
        NODE_ENV: "test",
        PI_WEB_MOCK: "1",
        PI_WEB_DEV: "0",
        PI_WEB_AUTH_MODE: "external",
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-test-user",
        PI_WEB_AUTH_ORIGIN: origin,
        PI_WEB_AUTH_STORE: join(home, "auth.json"),
        PI_WEB_SETTINGS_FILE: join(home, "settings.json"),
        PI_WEB_SESSION_UI_STATE_FILE: join(home, "session-ui-state.json"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => {
      output += String(data);
    });
    child.stderr?.on("data", (data) => {
      output += String(data);
    });
    await waitForServer(origin, child, () => output);
  }, 30_000);

  afterAll(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    if (home) await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const response = await fetch(`${origin}/api/mock/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiSecrets.first}` },
    });
    expect(response.status).toBe(200);
  });

  async function bootstrapBrowser(
    user: string,
    clientId: string,
    sessionId: string,
    seq = 1,
  ) {
    const response = await fetch(`${origin}/api/state?sessionId=${sessionId}`, {
      headers: {
        "x-test-user": user,
        "x-pi-web-client-id": clientId,
        "x-pi-web-viewer-seq": String(seq),
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).sessionId).toBe(sessionId);
    return cookieFrom(response);
  }

  async function lifecycle(headers: Record<string, string>) {
    return json<Lifecycle>(
      await fetch(`${origin}/api/session/lifecycle`, { headers }),
    );
  }

  async function acquireBrowser(
    cookie: string,
    clientId: string,
    sessionId: string,
    seq = 1,
  ) {
    const response = await fetch(`${origin}/api/state?sessionId=${sessionId}`, {
      headers: {
        cookie,
        "x-pi-web-client-id": clientId,
        "x-pi-web-viewer-seq": String(seq),
      },
    });
    expect(response.status).toBe(200);
  }

  it("keeps an external-header browser lease through cookie issuance, WS ticketing, and reconnect", async () => {
    const clientId = "browser-reconnect";
    const cookie = await bootstrapBrowser("alice", clientId, "mock-current");
    const headers = browserHeaders(cookie, clientId, origin);

    const firstTicket = await json<{ ticket: string }>(
      await fetch(`${origin}/api/ws-ticket`, { method: "POST", headers }),
    );
    const first = await openSocket(origin, firstTicket.ticket, clientId, "mock-current");
    expect(first.hello.sessionId).toBe("mock-current");
    await closeSocket(first.socket);

    const secondTicket = await json<{ ticket: string }>(
      await fetch(`${origin}/api/ws-ticket`, { method: "POST", headers }),
    );
    const second = await openSocket(origin, secondTicket.ticket, clientId, "mock-current");
    try {
      expect(second.hello.sessionId).toBe("mock-current");
      expect(await lifecycle({ cookie })).toMatchObject({
        viewerLeases: [
          { clientId, sessionId: "mock-current", sockets: 1 },
        ],
      });
    } finally {
      await closeSocket(second.socket);
    }
  });

  it("isolates equal browser client IDs by credential and rejects foreign-origin lease mutation", async () => {
    const shared = "same-browser-client";
    const aliceCookie = await bootstrapBrowser("alice", shared, "mock-current", 1);
    const bobCookie = await bootstrapBrowser("bob", shared, "mock-older", 100);
    await acquireBrowser(aliceCookie, "alice-private", "mock-current");
    await acquireBrowser(bobCookie, "bob-private", "mock-older");

    const aliceMove = await fetch(`${origin}/api/sessions/open`, {
      method: "POST",
      headers: browserHeaders(aliceCookie, shared, origin, 2),
      body: JSON.stringify({ sessionId: "mock-older" }),
    });
    expect(aliceMove.status).toBe(200);

    const rejectedBobMove = await fetch(`${origin}/api/sessions/open`, {
      method: "POST",
      headers: browserHeaders(bobCookie, shared, "https://foreign.example", 101),
      body: JSON.stringify({ sessionId: "mock-current" }),
    });
    expect(rejectedBobMove.status).toBe(403);

    const alice = await lifecycle({ cookie: aliceCookie });
    expect(alice.viewerLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: shared, sessionId: "mock-older" }),
      ]),
    );
    const bobBeforeTrustedMove = await lifecycle({ cookie: bobCookie });
    expect(bobBeforeTrustedMove.viewerLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: shared, sessionId: "mock-older" }),
      ]),
    );

    const trustedBobMove = await fetch(`${origin}/api/sessions/open`, {
      method: "POST",
      headers: browserHeaders(bobCookie, shared, origin, 101),
      body: JSON.stringify({ sessionId: "mock-current" }),
    });
    expect(trustedBobMove.status).toBe(200);

    expectPrivateLifecycle(
      await lifecycle({ cookie: aliceCookie }),
      [shared, "alice-private"],
      ["bob-private"],
    );
    const bob = await lifecycle({ cookie: bobCookie });
    expect(bob.viewerLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: shared, sessionId: "mock-current" }),
      ]),
    );
    expectPrivateLifecycle(bob, [shared, "bob-private"], ["alice-private"]);
  });

  it("isolates equal client IDs for Bearer principals without requiring Origin", async () => {
    const shared = "same-api-client";
    const first = { authorization: `Bearer ${apiSecrets.first}` };
    const second = { authorization: `Bearer ${apiSecrets.second}` };

    for (const [headers, sessionId, seq, privateId] of [
      [first, "mock-current", 1, "api-first-private"],
      [second, "mock-older", 100, "api-second-private"],
    ] as const) {
      expect(
        (
          await fetch(`${origin}/api/state?sessionId=${sessionId}`, {
            headers: {
              ...headers,
              "x-pi-web-client-id": shared,
              "x-pi-web-viewer-seq": String(seq),
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${origin}/api/state?sessionId=${sessionId}`, {
            headers: { ...headers, "x-pi-web-client-id": privateId },
          })
        ).status,
      ).toBe(200);
    }

    expect(
      (
        await fetch(`${origin}/api/sessions/open`, {
          method: "POST",
          headers: {
            ...first,
            "content-type": "application/json",
            "x-pi-web-client-id": shared,
            "x-pi-web-viewer-seq": "2",
          },
          body: JSON.stringify({ sessionId: "mock-older" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${origin}/api/sessions/open`, {
          method: "POST",
          headers: {
            ...second,
            "content-type": "application/json",
            "x-pi-web-client-id": shared,
            "x-pi-web-viewer-seq": "101",
          },
          body: JSON.stringify({ sessionId: "mock-current" }),
        })
      ).status,
    ).toBe(200);

    const firstLifecycle = await lifecycle(first);
    expect(firstLifecycle.viewerLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: shared, sessionId: "mock-older" }),
      ]),
    );
    expectPrivateLifecycle(
      firstLifecycle,
      [shared, "api-first-private"],
      ["api-second-private"],
    );

    const secondLifecycle = await lifecycle(second);
    expect(secondLifecycle.viewerLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: shared, sessionId: "mock-current" }),
      ]),
    );
    expectPrivateLifecycle(
      secondLifecycle,
      [shared, "api-second-private"],
      ["api-first-private"],
    );
  });
});
