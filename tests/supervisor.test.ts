import { isolatedAuthEnv } from "./auth-isolation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { AuthStore, hashSecret } from "../server/auth/kernel.js";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("..", import.meta.url).pathname;
const token = "supervisor-test-token";
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

async function status(port: number, supervisor: ChildProcess) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__supervisor/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<{ childPid?: number; childGeneration: number }>;
  }, supervisor);
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
  it("restarts an unexpectedly terminated child without double-spawning on intentional restart", async () => {
    const publicPort = await freePort();
    const childPort = await freePort();
    const authEnv = isolatedAuthEnv();
    const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
      cwd: projectRoot,
      env: {
        ...authEnv,
        HOST: "127.0.0.1",
        PORT: String(publicPort),
        PI_WEB_CHILD_PORT: String(childPort),
        PI_WEB_AUTH_MODE: "legacy", PI_WEB_TOKEN: token,
        PI_WEB_MOCK: "1",
        PI_WEB_NO_SESSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisors.add(supervisor);

    const initial = await status(publicPort, supervisor);
    expect(initial.childPid).toBeTypeOf("number");
    process.kill(initial.childPid!, "SIGTERM");

    const recovered = await waitFor(async () => {
      const current = await status(publicPort, supervisor);
      if (current.childGeneration <= initial.childGeneration || current.childPid === initial.childPid) return undefined;
      const response = await fetch(`http://127.0.0.1:${publicPort}/api/state`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok ? current : undefined;
    }, supervisor);
    expect(recovered.childGeneration).toBe(initial.childGeneration + 1);

    // A stopped child cannot answer auth requests; the supervisor must verify
    // the same persistent store directly, including legacy retirement.
    const store = new AuthStore(authEnv.PI_WEB_AUTH_STORE!);
    await store.update(s => { s.config = { policy: "authenticated", methods: [] }; s.apiTokens.push({ id: "restart", name: "restart", hash: hashSecret("machine-restart"), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }); });
    process.kill(recovered.childPid!, "SIGSTOP");
    try {
      const denied = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: `Bearer ${token}` } });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, { headers: { authorization: "Bearer machine-restart" }, signal: AbortSignal.timeout(2000) });
      expect(allowed.status).toBe(200);
      await store.update(s => { s.config = { policy: "authenticated", methods: ["legacy"] }; });
    } finally { process.kill(recovered.childPid!, "SIGCONT"); }

    const restartResponse = await fetch(`http://127.0.0.1:${publicPort}/api/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(restartResponse.status).toBe(202);

    const intentionallyRestarted = await waitFor(async () => {
      const current = await status(publicPort, supervisor);
      return current.childGeneration > recovered.childGeneration && current.childPid !== recovered.childPid
        ? current
        : undefined;
    }, supervisor);
    expect(intentionallyRestarted.childGeneration).toBe(recovered.childGeneration + 1);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await status(publicPort, supervisor)).childGeneration).toBe(intentionallyRestarted.childGeneration);
  }, 20_000);

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
          PI_WEB_TOKEN: "",
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
