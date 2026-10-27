import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AuthStore } from "../server/auth/kernel.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

const children = new Set<ChildProcess>();
const projectRoot = process.env.PI_WEB_TEST_SOURCE_ROOT || new URL("..", import.meta.url).pathname;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function waitForServer(origin: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output.join(""));
    if (await fetch(`${origin}/api/state`).then(response => response.ok).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start:\n${output.join("")}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

afterEach(async () => {
  await Promise.all(Array.from(children, async child => {
    children.delete(child);
    await stop(child);
  }));
});

describe("mock WebSocket authentication policy", () => {
  it("requires real tickets and revokes an open-policy socket when saved policy closes", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const authEnv = isolatedAuthEnv();
    const env = {
      ...authEnv,
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_AUTH_MODE: "none",
      PI_WEB_AUTH_ORIGIN: origin,
      PI_WEB_MOCK: "1",
      PI_WEB_DEV: "0",
      NODE_ENV: "test",
    };
    delete env.PI_WEB_TOKEN;
    const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const output: string[] = [];
    child.stdout?.on("data", data => output.push(String(data)));
    child.stderr?.on("data", data => output.push(String(data)));
    await waitForServer(origin, child, output);

    await expect(new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(origin.replace(/^http/, "ws") + "/ws", { origin });
      socket.once("unexpected-response", (_request, response) => {
        expect(response.statusCode).toBe(401);
        socket.terminate();
        resolve();
      });
      socket.once("open", () => reject(new Error("Ticketless mock WebSocket opened")));
      socket.once("error", reject);
    })).resolves.toBeUndefined();

    const ticketResponse = await fetch(`${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { origin, "x-pi-web-client-id": "ws-policy-test" },
    });
    expect(ticketResponse.status).toBe(201);
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const staleTicketResponse = await fetch(`${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { origin, "x-pi-web-client-id": "ws-policy-test" },
    });
    expect(staleTicketResponse.status).toBe(201);
    const { ticket: staleTicket } = await staleTicketResponse.json() as { ticket: string };
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`, { origin });
    await once(socket, "open");

    const closed = new Promise<number>(resolve => socket.once("close", resolve));
    await new AuthStore(authEnv.PI_WEB_AUTH_STORE!).update(state => {
      state.config = { policy: "authenticated", methods: [] };
    });
    await expect(new Promise<void>((resolve, reject) => {
      const staleSocket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(staleTicket)}`, { origin });
      staleSocket.once("unexpected-response", (_request, response) => {
        expect(response.statusCode).toBe(401);
        staleSocket.terminate();
        resolve();
      });
      staleSocket.once("open", () => reject(new Error("Open-policy ticket survived a saved policy change")));
      staleSocket.once("error", reject);
    })).resolves.toBeUndefined();
    await expect(Promise.race([
      closed,
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("Open-policy socket was not revoked")), 20_000)),
    ])).resolves.toBe(1008);

    const denied = await fetch(`${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { origin, "x-pi-web-client-id": "ws-policy-test" },
    });
    expect(denied.status).toBe(401);
  }, 40_000);
});
