import { createServer, type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createUpgradeProxy } from "../server/shared/upgradeProxy.js";

const servers: Array<Server | net.Server> = [];
const sockets = new Set<Socket>();

async function listen(server: Server | net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServers(): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
}

afterEach(closeServers);

function upgradeRequest(port: number, path: string, head = ""): Promise<{ socket: Socket; response: () => string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLXJlbGF5\r\n\r\n${head}`,
      );
      resolve({ socket, response: () => Buffer.concat(chunks).toString("latin1") });
    });
    sockets.add(socket);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function proxyOptions(upstreamPort: number) {
  return {
    host: "127.0.0.1",
    port: upstreamPort,
    expectedPath: "/ws",
    handshakeTimeoutMs: 100,
    maxPending: 1,
    maxPendingPerPeer: 1,
    accept: () => true,
    prepare: () => undefined,
    rejectionBody: "rejected",
  };
}

describe("bounded supervisor upgrade proxy", () => {
  it("rejects non-/ws upgrades before opening an upstream connection", async () => {
    let connections = 0;
    const upstreamPort = await listen(net.createServer(() => { connections += 1; }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);

    const client = await upgradeRequest(proxyPort, "/not-ws");
    await waitForClose(client.socket);
    expect(connections).toBe(0);
  });

  it("supports request-aware path admission without widening unrelated upgrades", async () => {
    let connections = 0;
    const upstreamPort = await listen(net.createServer(() => { connections += 1; }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy({
      ...proxyOptions(upstreamPort),
      expectedPath: (req, url) => url.pathname === "/ws"
        || (url.pathname === "/" && req.headers["sec-websocket-protocol"] === "vite-hmr"),
    }));
    const proxyPort = await listen(proxy);

    const unrelatedPath = await upgradeRequest(proxyPort, "/other?token=fake");
    await waitForClose(unrelatedPath.socket);
    const unrelatedProtocol = await upgradeRequest(proxyPort, "/");
    await waitForClose(unrelatedProtocol.socket);
    expect(connections).toBe(0);
  });

  it("flushes and force-closes rejected clients even when they keep sending", async () => {
    let connections = 0;
    const upstreamPort = await listen(net.createServer(() => { connections += 1; }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy({
      ...proxyOptions(upstreamPort),
      accept: () => false,
    }));
    const proxyPort = await listen(proxy);
    const client = await upgradeRequest(proxyPort, "/ws");
    const sender = setInterval(() => client.socket.write("ignored"), 5);

    await waitForClose(client.socket);
    clearInterval(sender);
    expect(client.response()).toContain("403 Forbidden");
    expect(client.response()).toContain("rejected");
    expect(connections).toBe(0);
  });

  it("caps pending handshakes and releases both sockets when a handshake stalls", async () => {
    const upstreamSockets = new Set<Socket>();
    const upstreamPort = await listen(net.createServer((socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
      socket.resume();
    }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);

    const first = await upgradeRequest(proxyPort, "/ws");
    await waitFor(() => upstreamSockets.size === 1);
    const second = await upgradeRequest(proxyPort, "/ws");
    await waitForClose(second.socket);
    expect(second.response()).toContain("503 Service Unavailable");
    await waitForClose(first.socket);
    await waitFor(() => upstreamSockets.size === 0);
    expect(upstreamSockets.size).toBe(0);
  });

  it("forwards a failed handshake response, closes both ends, and releases its pending slot", async () => {
    const upstreamSockets = new Set<Socket>();
    const upstreamPort = await listen(net.createServer((socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
      socket.once("data", () => {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: keep-alive\r\n\r\nunauthorized");
      });
    }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);

    const first = await upgradeRequest(proxyPort, "/ws");
    await waitForClose(first.socket);
    expect(first.response()).toContain("401 Unauthorized");
    expect(first.response()).toContain("unauthorized");
    await waitFor(() => upstreamSockets.size === 0);

    const second = await upgradeRequest(proxyPort, "/ws");
    await waitForClose(second.socket);
    expect(second.response()).toContain("401 Unauthorized");
  });

  it("preserves head bytes and pauses later client bytes until the upstream accepts", async () => {
    let received = Buffer.alloc(0);
    let upstreamSocket: Socket | undefined;
    const upstreamPort = await listen(net.createServer((socket) => {
      upstreamSocket = socket;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", (chunk) => { received = Buffer.concat([received, chunk]); });
    }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);
    const client = await upgradeRequest(proxyPort, "/ws", "initial-head-bytes");

    await waitFor(() => received.toString("latin1").includes("initial-head-bytes"));
    expect(received.toString("latin1")).toContain("\r\n\r\ninitial-head-bytes");
    client.socket.write("pre-auth-later-bytes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.toString("latin1")).not.toContain("pre-auth-later-bytes");

    upstreamSocket!.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await waitFor(() => received.toString("latin1").includes("pre-auth-later-bytes"));
  });

  it("accepts a small 101 header coalesced with a frame larger than the header limit", async () => {
    const frame = Buffer.alloc(80 * 1024, 0x61);
    const upstreamPort = await listen(net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(Buffer.concat([
          Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
          frame,
        ]));
      });
    }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);
    const client = await upgradeRequest(proxyPort, "/ws");

    await waitFor(() => Buffer.byteLength(client.response(), "latin1") >= frame.length);
    expect(client.socket.destroyed).toBe(false);
    expect(client.response()).toContain("101 Switching Protocols");
    expect(Buffer.byteLength(client.response(), "latin1")).toBeGreaterThan(frame.length);
  });

  it("removes the handshake deadline after 101 and keeps relaying", async () => {
    const upstreamPort = await listen(net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString("latin1");
        if (request.includes("\r\n\r\n") && !request.includes("synthetic-ping")) {
          socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        }
        if (request.includes("synthetic-ping")) socket.write("synthetic-pong");
      });
    }));
    const proxy = createServer();
    proxy.on("upgrade", createUpgradeProxy(proxyOptions(upstreamPort)));
    const proxyPort = await listen(proxy);
    const client = await upgradeRequest(proxyPort, "/ws");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.socket.destroyed).toBe(false);
    client.socket.write("synthetic-ping");
    const deadline = Date.now() + 1_000;
    while (!client.response().includes("synthetic-pong") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(client.response()).toContain("synthetic-pong");
  });
});
