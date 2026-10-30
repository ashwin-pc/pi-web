import { isolatedAuthEnv } from "./auth-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { AuthStore } from "../server/auth/kernel.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mintStoredApiToken } from "./auth-fixture.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const supervisors = new Set<ChildProcess>();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  supervisor: ChildProcess,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw new Error(`Supervisor exited early: code=${supervisor.exitCode} signal=${supervisor.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function status(port: number, supervisor: ChildProcess, token: string) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__supervisor/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<{ childPid?: number; childGeneration: number }>;
  }, supervisor);
}

async function apiReady(port: number, supervisor: ChildProcess, token: string) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok ? true : undefined;
  }, supervisor);
}

async function exitOutput(supervisor: ChildProcess) {
  let output = "";
  supervisor.stdout?.on("data", chunk => { output += chunk; });
  supervisor.stderr?.on("data", chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.once("exit", resolve);
  });
  return { code, output };
}

async function stopSupervisor(supervisor: ChildProcess) {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  supervisor.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      supervisor.kill("SIGKILL");
      resolve();
    }, 5_000);
    supervisor.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(Array.from(supervisors, async (supervisor) => {
    supervisors.delete(supervisor);
    await stopSupervisor(supervisor);
  }));
});

describe("pi-web supervisor", () => {
  it.each([
    {
      label: "keeps the default loopback launch usable over plain HTTP",
      configuredOrigin: undefined,
      secure: false,
    },
    {
      label: "permits non-Secure cookies for explicit HTTP loopback origins",
      configuredOrigin: "loopback",
      secure: false,
    },
  ])("$label", async ({ configuredOrigin, secure }) => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const explicitOrigin = configuredOrigin === "loopback"
      ? `http://localhost:${publicPort}`
      : undefined;
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "external",
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
        ...(explicitOrigin ? { PI_WEB_AUTH_ORIGIN: explicitOrigin } : {}),
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);

    const response = await waitFor(async () => {
      const candidate = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { "x-amzn-tunnel-user": "synthetic-owner", "x-pi-web-client-id": "cookie-regression" },
      });
      return candidate.ok ? candidate : undefined;
    }, supervisor);
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("pi_web_session=");
    if (secure) expect(setCookie).toMatch(/;\s*Secure(?:;|$)/i);
    else expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
  }, 20_000);

  it("preserves the synthetic deployment auth contract through the supervisor", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const publicOrigin = `https://public.example.test:${publicPort}`;
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update((state) => {
      state.config = { policy: "authenticated", methods: ["external"] };
    });
    const { secret: machineToken } = await mintStoredApiToken(store, "Machine");
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "external",
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_AUTH_METHODS: "external",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
        PI_WEB_AUTH_ORIGIN: publicOrigin,
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    await waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${publicPort}/api/state`,
        { headers: { authorization: `Bearer ${machineToken}` } },
      );
      return response.ok ? true : undefined;
    }, supervisor);

    const external = await fetch(`http://127.0.0.1:${publicPort}/api/auth/info`, {
      headers: { "x-amzn-tunnel-user": "synthetic-owner" },
    });
    expect(await external.json()).toMatchObject({
      identity: { id: "external:synthetic-owner" },
    });

    const machineHeaders = {
      authorization: `Bearer ${machineToken}`,
    };
    expect(
      (await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: machineHeaders,
      })).status,
    ).toBe(200);

    const sessionResponse = await fetch(
      `http://127.0.0.1:${publicPort}/api/state`,
      {
        headers: {
          "x-amzn-tunnel-user": "synthetic-owner",
          "x-pi-web-client-id": "browser",
          "x-forwarded-proto": "http",
        },
      },
    );
    expect(sessionResponse.headers.get("set-cookie")).toContain("Secure");
    const cookie = sessionResponse.headers.get("set-cookie")!.split(";")[0];
    const browserHeaders = {
      cookie,
      origin: publicOrigin,
      "x-pi-web-client-id": "browser",
    };
    expect(
      (await fetch(`http://127.0.0.1:${publicPort}/api/auth/authorize`, {
        method: "POST",
        headers: browserHeaders,
      })).status,
    ).toBe(200);
    expect(
      (await fetch(`http://127.0.0.1:${publicPort}/api/auth/authorize`, {
        method: "POST",
        headers: { ...browserHeaders, origin: "http://other.example.test" },
      })).status,
    ).toBe(403);

    const connect = async () => {
      const ticketResponse = await fetch(
        `http://127.0.0.1:${publicPort}/api/ws-ticket`,
        { method: "POST", headers: browserHeaders },
      );
      expect(ticketResponse.status).toBe(201);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(ticket)}`,
          { origin: publicOrigin },
        );
        ws.once("message", () => {
          ws.close();
          resolve();
        });
        ws.once("error", reject);
      });
    };
    await connect();
    await connect();

    expect(
      (await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
        method: "POST",
        headers: browserHeaders,
      })).status,
    ).toBe(202);
  }, 25_000);

  it("restarts an unexpectedly terminated child without double-spawning on intentional restart", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    const token = await mintStoredApiToken(store, "supervisor");
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);

    const initial = await status(publicPort, supervisor, token.secret);
    expect(initial.childPid).toBeTypeOf("number");
    process.kill(initial.childPid!, "SIGTERM");

    const recovered = await waitFor(async () => {
      const current = await status(publicPort, supervisor, token.secret);
      if (current.childGeneration <= initial.childGeneration || current.childPid === initial.childPid) return undefined;
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { authorization: `Bearer ${token.secret}` },
      });
      return response.ok ? current : undefined;
    }, supervisor);
    expect(recovered.childGeneration).toBe(initial.childGeneration + 1);

    // A stopped child cannot answer auth requests; the supervisor verifies the
    // same persistent store directly and observes revocation immediately.
    const restartToken = await mintStoredApiToken(store, "restart");
    process.kill(recovered.childPid!, "SIGSTOP");
    try {
      const allowed = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: `Bearer ${restartToken.secret}` }, signal: AbortSignal.timeout(2000) });
      expect(allowed.status).toBe(200);
      await store.update(state => {
        const record = state.apiTokens.find(item => item.id === restartToken.id);
        if (record) record.revokedAt = Date.now();
      });
      const denied = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: `Bearer ${restartToken.secret}` }, signal: AbortSignal.timeout(2000) });
      expect(denied.status).toBe(401);
    } finally { process.kill(recovered.childPid!, "SIGCONT"); }

    const restartResponse = await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(restartResponse.status).toBe(202);

    const intentionallyRestarted = await waitFor(async () => {
      const current = await status(publicPort, supervisor, token.secret);
      return current.childGeneration > recovered.childGeneration && current.childPid !== recovered.childPid
        ? current
        : undefined;
    }, supervisor);
    expect(intentionallyRestarted.childGeneration).toBe(recovered.childGeneration + 1);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await status(publicPort, supervisor, token.secret)).childGeneration).toBe(intentionallyRestarted.childGeneration);
  }, 20_000);

  it("preserves the authenticated deployment contract through the supervisor", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    const token = await mintStoredApiToken(store, "deployment contract");
    await store.update(state => {
      state.config = { policy: "authenticated", methods: ["external"] };
    });
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "external",
        PI_WEB_AUTH_POLICY: "authenticated",
        PI_WEB_AUTH_ORIGIN: "https://owner.example",
        PI_WEB_AUTH_TRUSTED_HEADER: "x-test-user",
        PI_WEB_AUTH_PROXY_PEERS: "127.0.0.1",
        PI_WEB_TOKEN: "stale-removed-secret",
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    let output = "";
    supervisor.stdout?.on("data", chunk => { output += chunk; });
    supervisor.stderr?.on("data", chunk => { output += chunk; });
    await status(publicPort, supervisor, token.secret);
    await apiReady(publicPort, supervisor, token.secret);
    await waitFor(
      async () => output.includes("PI_WEB_TOKEN is ignored") ? true : undefined,
      supervisor,
    );
    const base = `http://127.0.0.1:${publicPort}`;
    const browserHeaders = {
      origin: "https://owner.example",
      "x-forwarded-host": "owner.example",
      "x-test-user": "owner@example.test",
      "x-pi-web-client-id": "deployment-contract",
    };

    const external = await fetch(`${base}/api/state`, { headers: browserHeaders });
    expect(external.status).toBe(200);
    const browserCookie = external.headers.get("set-cookie")?.split(";")[0];
    expect(browserCookie).toMatch(/^pi_web_session=/);
    const bearer = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(bearer.status).toBe(200);
    expect(
      (await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer stale-removed-secret" },
      })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/api/state?token=stale-removed-secret`)).status,
    ).toBe(401);

    const wrongOrigin = await fetch(`${base}/api/restart`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.secret}`,
        origin: "https://wrong.example",
        "x-forwarded-host": "owner.example",
      },
    });
    expect(wrongOrigin.status).toBe(403);

    for (let attempt = 0; attempt < 2; attempt++) {
      const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
        method: "POST",
        headers: { ...browserHeaders, cookie: browserCookie! },
      });
      expect(ticketResponse.status).toBe(201);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${publicPort}/ws?ticket=${ticket}`, {
          origin: "https://owner.example",
          headers: {
            cookie: browserCookie!,
            "x-forwarded-host": "owner.example",
          },
        });
        socket.once("message", data => {
          expect(JSON.parse(String(data)).type).toBe("hello");
          socket.close();
          resolve();
        });
        socket.once("error", reject);
      });
    }

    const beforeRestart = await status(publicPort, supervisor, token.secret);
    const restart = await fetch(`${base}/api/restart`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.secret}`,
        origin: "https://owner.example",
        "x-forwarded-host": "owner.example",
        "x-pi-web-client-id": "deployment-contract",
      },
    });
    expect(restart.status).toBe(202);
    const afterRestart = await waitFor(async () => {
      const current = await status(publicPort, supervisor, token.secret);
      return current.childGeneration > beforeRestart.childGeneration ? current : undefined;
    }, supervisor);
    expect(afterRestart.childGeneration).toBe(beforeRestart.childGeneration + 1);
  }, 20_000);

  it.each([
    { PI_WEB_TOKEN: "removed-secret" },
    { PI_WEB_AUTH_MODE: "legacy" },
  ])("fails startup clearly for explicit legacy authentication", async legacyEnv => {
    const authEnv = isolatedAuthEnv();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: { ...authEnv, ...legacyEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    const result = await exitOutput(supervisor);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Legacy token authentication has been removed");
  });

  it("fails startup clearly when the saved store still enables legacy authentication", async () => {
    const authEnv = isolatedAuthEnv();
    await writeFile(authEnv.PI_WEB_AUTH_STORE!, JSON.stringify({
      version: 1,
      config: { policy: "authenticated", methods: ["legacy"] },
      credentials: [],
      sessions: [],
      apiTokens: [],
    }));
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: authEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);
    const result = await exitOutput(supervisor);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("pi-web auth recover");
  });

  it("preserves the public auth contract across proxying and restart", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const publicOrigin = "https://public.example";
    const authEnv = isolatedAuthEnv();
    const supervisor = spawn(
      process.execPath,
      ["--import", "tsx", "supervisor.ts"],
      {
        cwd: projectRoot,
        env: {
          ...authEnv,
          HOST: "127.0.0.1",
          PORT: String(publicPort),
          PI_WEB_CHILD_PORT: String(childPort),
          PI_WEB_AUTH_MODE: "external",
          PI_WEB_AUTH_METHODS: "external",
          PI_WEB_AUTH_TRUSTED_HEADER: "x-amzn-tunnel-user",
          PI_WEB_AUTH_ORIGIN: publicOrigin,
          PI_WEB_MOCK: "1",
          PI_WEB_NO_SESSION: "1",
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    supervisors.add(supervisor);
    let output = "";
    supervisor.stdout?.on("data", (chunk) => (output += chunk));
    supervisor.stderr?.on("data", (chunk) => (output += chunk));
    const base = `http://127.0.0.1:${publicPort}`;
    const externalHeaders = {
      "x-amzn-tunnel-user": "synthetic-owner",
      "x-pi-web-client-id": "compatibility-test",
    };

    try {
      const signedIn = await waitFor(async () => {
        const response = await fetch(`${base}/api/state`, {
          headers: externalHeaders,
        });
        return response.ok && response.headers.get("set-cookie")
          ? response
          : undefined;
      }, supervisor, 20_000);
      const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
      const browserHeaders = {
        cookie,
        origin: publicOrigin,
        "x-pi-web-client-id": "compatibility-test",
        "content-type": "application/json",
      };

      expect(
        (
          await fetch(`${base}/api/auth/authorize`, {
            method: "POST",
            headers: browserHeaders,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${base}/api/auth/authorize`, {
            method: "POST",
            headers: { ...browserHeaders, origin: "https://other.example" },
          })
        ).status,
      ).toBe(403);

      const tokenResponse = await fetch(`${base}/api/auth/tokens`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ name: "Synthetic machine" }),
      });
      expect(tokenResponse.status).toBe(201);
      const machine = (await tokenResponse.json()) as {
        secret: string;
      };
      const machineHeaders = { authorization: `Bearer ${machine.secret}` };
      expect(
        (await fetch(`${base}/api/state`, { headers: machineHeaders })).status,
      ).toBe(200);

      const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
        method: "POST",
        headers: machineHeaders,
      });
      expect(ticketResponse.status).toBe(201);
      const ticket = (await ticketResponse.json()) as { ticket: string };
      const socket = new WebSocket(
        `ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(ticket.ticket)}`,
        { origin: publicOrigin },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );

      const before = (await (
        await fetch(`${base}/__supervisor/status`, {
          headers: externalHeaders,
        })
      ).json()) as { childGeneration: number };
      const restart = await fetch(`${base}/api/restart`, {
        method: "POST",
        headers: browserHeaders,
      });
      expect(restart.status).toBe(202);
      await closed;
      await waitFor(async () => {
        const response = await fetch(`${base}/__supervisor/status`, {
          headers: externalHeaders,
        });
        if (!response.ok) return undefined;
        const current = (await response.json()) as {
          childGeneration: number;
          childPid?: number;
        };
        if (
          current.childGeneration <= before.childGeneration ||
          !current.childPid
        )
          return undefined;
        return (await fetch(`${base}/api/state`, { headers: machineHeaders }))
          .ok
          ? current
          : undefined;
      }, supervisor, 20_000);

      const reconnectTicket = (await (
        await fetch(`${base}/api/ws-ticket`, {
          method: "POST",
          headers: machineHeaders,
        })
      ).json()) as { ticket: string };
      const reconnected = new WebSocket(
        `ws://127.0.0.1:${publicPort}/ws?ticket=${encodeURIComponent(reconnectTicket.ticket)}`,
        { origin: publicOrigin },
      );
      await new Promise<void>((resolve, reject) => {
        reconnected.once("open", resolve);
        reconnected.once("error", reject);
      });
      reconnected.close();
    } catch (error) {
      throw new Error(`${String(error)}\n${output}`);
    }
  }, 35_000);
});
