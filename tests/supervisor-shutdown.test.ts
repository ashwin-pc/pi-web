import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedAuthEnv } from "./auth-isolation.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const token = "supervisor-shutdown-test-token";
const processes = new Set<ChildProcess>();
const childPids = new Set<number>();
const clients = new Set<net.Socket>();
const temporaryDirectories = new Set<string>();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForStatus(
  supervisor: ChildProcess,
  publicPort: number,
): Promise<{ childPid: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null)
      throw new Error(`Supervisor exited early: code=${supervisor.exitCode} signal=${supervisor.signalCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${publicPort}/__supervisor/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return await response.json() as { childPid: number };
    } catch {
      // Startup races are expected until the listener and child are ready.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Supervisor did not become ready");
}

async function openIncompleteRequest(options: net.NetConnectOpts): Promise<net.Socket> {
  const socket = net.connect(options);
  clients.add(socket);
  socket.once("close", () => clients.delete(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.write("GET / HTTP/1.1\r\nHost: pi.example.invalid\r\n", error => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  return socket;
}

async function waitForExit(process: ChildProcess, timeoutMs = 7_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off("exit", onExit);
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once("exit", onExit);
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function startSupervisor(withTunnel: boolean) {
  const publicPort = await freePort();
  const childPort = await freePort();
  const authEnv = isolatedAuthEnv();
  temporaryDirectories.add(authEnv.PI_WEB_HOME!);
  let socketPath: string | undefined;
  if (withTunnel) {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-shutdown-test-"));
    temporaryDirectories.add(parent);
    await chmod(parent, 0o700);
    socketPath = join(parent, "pi-web.sock");
  }
  const supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
    cwd: projectRoot,
    env: {
      ...authEnv,
      HOST: "127.0.0.1",
      PORT: String(publicPort),
      PI_WEB_CHILD_PORT: String(childPort),
      PI_WEB_AUTH_MODE: "legacy",
      PI_WEB_TOKEN: token,
      PI_WEB_MOCK: "1",
      PI_WEB_NO_SESSION: "1",
      ...(socketPath ? { PI_WEB_TUNNEL_SOCKET: socketPath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(supervisor);
  const { childPid } = await waitForStatus(supervisor, publicPort);
  childPids.add(childPid);
  return { supervisor, childPid, publicPort, socketPath };
}

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.all([...processes].map(async process => {
    processes.delete(process);
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await waitForExit(process).catch(() => undefined);
    }
  }));
  for (const pid of childPids) {
    childPids.delete(pid);
    if (isRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The child may exit between the liveness check and cleanup.
      }
    }
  }
  await Promise.all([...temporaryDirectories].map(async directory => {
    temporaryDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("supervisor shutdown", () => {
  it.each(["SIGTERM", "SIGHUP"] as const)(
    "bounds %s shutdown with incomplete TCP and Unix HTTP headers",
    async signal => {
      const instance = await startSupervisor(true);
      await openIncompleteRequest({ host: "127.0.0.1", port: instance.publicPort });
      await openIncompleteRequest({ path: instance.socketPath! });

      instance.supervisor.kill(signal);
      await waitForExit(instance.supervisor);

      processes.delete(instance.supervisor);
      expect(instance.supervisor.exitCode).toBe(0);
      expect(isRunning(instance.childPid)).toBe(false);
      childPids.delete(instance.childPid);
    },
    20_000,
  );

  it("bounds shutdown without PI_WEB_TUNNEL_SOCKET", async () => {
    const instance = await startSupervisor(false);
    await openIncompleteRequest({ host: "127.0.0.1", port: instance.publicPort });

    instance.supervisor.kill("SIGTERM");
    await waitForExit(instance.supervisor);

    processes.delete(instance.supervisor);
    expect(instance.supervisor.exitCode).toBe(0);
    expect(isRunning(instance.childPid)).toBe(false);
    childPids.delete(instance.childPid);
  }, 20_000);
});
