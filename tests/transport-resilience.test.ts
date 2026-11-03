import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { RealtimeHub } from "../server/realtime.js";
import { isolatedAuthEnv } from "./auth-isolation.js";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function startServer(dev = false) {
  const port = await freePort();
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-transport-"));
  tempDirs.push(cwd);
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...isolatedAuthEnv(),
      PI_WEB_MOCK: "1",
      PI_WEB_DEV: dev ? "1" : "0",
      NODE_ENV: "test",
      PI_WEB_TOKEN: "",
      PI_WEB_CWD: cwd,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/state`)).ok) return { baseUrl, child, cwd, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

function rawUpgrade(port: number, path: string, protocol?: string, origin?: string) {
  const socket = createConnection(port, "127.0.0.1");
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    ...(origin ? [`Origin: ${origin}`] : []),
    "",
    "",
  ].join("\r\n"));
  return socket;
}

async function firstResponse(socket: ReturnType<typeof rawUpgrade>, timeoutMs = 2_000) {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket response timed out")), timeoutMs);
    socket.once("data", (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
    socket.once("error", reject);
  });
}

function viteClientToken(source: string): string {
  const match = source.match(/\bconst wsToken = ("(?:[^"\\]|\\.)*");/);
  if (!match) throw new Error("Vite client did not contain a WebSocket token");
  const token = JSON.parse(match[1]) as unknown;
  if (typeof token !== "string" || !token) throw new Error("Vite client contained an invalid WebSocket token");
  return token;
}

describe("server transport resilience", { timeout: 30_000 }, () => {
  it("replays a healthy 8MB missed event within the default budget", async () => {
    const server = createHttpServer();
    const sockets = new WebSocketServer({ server });
    const hub = new RealtimeHub(0, 1, () => {});
    sockets.on("connection", (socket, request) => {
      const lastSeq = Number(new URL(request.url || "/", "http://localhost").searchParams.get("lastSeq"));
      hub.attach(socket, lastSeq);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate realtime test port");

    hub.broadcast({ type: "baseline" });
    hub.broadcast({ type: "large", value: "x".repeat(8 * 1024 * 1024) });
    hub.broadcast({ type: "next" });

    const reconnect = new WebSocket(`ws://127.0.0.1:${address.port}/?lastSeq=1`);
    try {
      const replayed = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const messages: Record<string, unknown>[] = [];
        reconnect.on("message", (data) => {
          messages.push(JSON.parse(String(data)) as Record<string, unknown>);
          if (messages.length === 2) resolve(messages);
        });
        reconnect.once("error", reject);
      });
      expect(replayed).toEqual([
        expect.objectContaining({ type: "large", seq: 2, replay: true }),
        expect.objectContaining({ type: "next", seq: 3, replay: true }),
      ]);
      expect(reconnect.readyState).toBe(WebSocket.OPEN);

      const liveMessage = once(reconnect, "message");
      hub.broadcast({ type: "live" });
      const [live] = await liveMessage;
      expect(JSON.parse(String(live))).toMatchObject({ type: "live", seq: 4 });
      expect(reconnect.readyState).toBe(WebSocket.OPEN);
    } finally {
      reconnect.close();
      sockets.close();
      server.close();
    }
  });

  it.each(["vite-hmr", "vite-ping"])("admits Vite's %s protocol on the root development route", async (protocol) => {
    const { baseUrl } = await startServer(true);
    const clientResponse = await fetch(`${baseUrl}/@vite/client`);
    expect(clientResponse.status).toBe(200);
    const token = viteClientToken(await clientResponse.text());
    const url = new URL(baseUrl);
    const socket = new WebSocket(`ws://${url.host}/?token=${encodeURIComponent(token)}`, protocol, { origin: baseUrl });
    try {
      await once(socket, "open");
    } finally {
      socket.close();
    }
  });

  it("rejects unrelated development upgrade routes and protocols", async () => {
    const { port } = await startServer(true);
    for (const [path, protocol] of [["/not-vite", "vite-hmr"], ["/", "unrelated"]]) {
      const socket = rawUpgrade(port, path, protocol);
      try {
        expect(await firstResponse(socket)).toContain("404 Not Found");
      } finally {
        socket.destroy();
      }
    }
  });

  it.each(["vite-hmr", "vite-ping"])("rejects Vite's %s protocol in production", async (protocol) => {
    const { port } = await startServer();
    const socket = rawUpgrade(port, "/", protocol);
    try {
      expect(await firstResponse(socket)).toContain("404 Not Found");
    } finally {
      socket.destroy();
    }
  });

  it("accepts ordinary JSON above 64 KiB, rejects it above 1 MiB, and preserves larger dedicated writes", async () => {
    const { baseUrl, cwd } = await startServer();
    const browserHeaders = { origin: baseUrl, "x-pi-web-client-id": "transport-test" };
    const ordinary = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json", ...browserHeaders },
      body: JSON.stringify({ sessionId: "mock-current", command: "/help", padding: "x".repeat(65_536) }),
    });
    expect(ordinary.status).toBe(200);

    const rejected = await fetch(`${baseUrl}/api/abort`, {
      method: "POST",
      headers: { "content-type": "application/json", ...browserHeaders },
      body: JSON.stringify({ sessionId: "mock-current", padding: "x".repeat(1_048_576) }),
    });
    expect(rejected.status).toBe(413);

    const content = "workspace".repeat(140_000);
    await writeFile(join(cwd, "large.txt"), "");
    const before = await (await fetch(`${baseUrl}/api/files/read?path=large.txt`)).json() as { revision: string };
    const written = await fetch(`${baseUrl}/api/files/write`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...browserHeaders },
      body: JSON.stringify({ path: "large.txt", content, expectedRevision: before.revision }),
    });
    expect(written.status).toBe(200);
    expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(content);

    const attachment = await fetch(`${baseUrl}/api/attachments?sessionId=mock-current&name=large.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...browserHeaders },
      body: Buffer.alloc(1_048_577),
    });
    expect(attachment.status).toBe(201);
  });

  it("rejects static directories without crashing the server", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/assets`);
    expect(response.status).toBe(404);
    expect((await fetch(`${baseUrl}/api/state`)).status).toBe(200);
  });

  it("closes upgrades outside /ws", async () => {
    const { port } = await startServer();
    const socket = rawUpgrade(port, "/not-websocket");
    try {
      expect(await firstResponse(socket)).toContain("404 Not Found");
      await Promise.race([
        once(socket, "close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("upgrade socket stayed open")), 2_000)),
      ]);
    } finally {
      socket.destroy();
    }
  });

  it("survives a malformed frame on an accepted realtime socket", async () => {
    const { baseUrl, child, port } = await startServer();
    const ticketResponse = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: "POST",
      headers: { origin: baseUrl, "x-pi-web-client-id": "transport-test" },
    });
    expect(ticketResponse.status).toBe(201);
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const socket = rawUpgrade(port, `/ws?ticket=${encodeURIComponent(ticket)}`, undefined, baseUrl);
    try {
      expect(await firstResponse(socket)).toContain("101 Switching Protocols");
      socket.write(Buffer.from([0x81, 0x01, 0x78]));
      await Promise.race([
        once(socket, "close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("malformed frame was not disconnected")), 2_000)),
      ]);
      expect(child.exitCode).toBeNull();
      expect((await fetch(`${baseUrl}/api/state`)).status).toBe(200);
    } finally {
      socket.destroy();
    }
  });
});
