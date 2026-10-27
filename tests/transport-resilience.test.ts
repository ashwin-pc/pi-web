import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

async function startServer() {
  const port = await freePort();
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-transport-"));
  tempDirs.push(cwd);
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...isolatedAuthEnv(),
      PI_WEB_MOCK: "1",
      PI_WEB_DEV: "0",
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

function rawUpgrade(port: number, path: string) {
  const socket = createConnection(port, "127.0.0.1");
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
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

describe("server transport resilience", () => {
  it("rejects oversized control JSON but preserves large workspace writes and attachments", async () => {
    const { baseUrl, cwd } = await startServer();
    const oversized = JSON.stringify({ sessionId: "mock-current", padding: "x".repeat(65_536) });
    const rejected = await fetch(`${baseUrl}/api/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(rejected.status).toBe(413);

    const content = "workspace".repeat(140_000);
    await writeFile(join(cwd, "large.txt"), "");
    const before = await (await fetch(`${baseUrl}/api/files/read?path=large.txt`)).json() as { revision: string };
    const written = await fetch(`${baseUrl}/api/files/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "large.txt", content, expectedRevision: before.revision }),
    });
    expect(written.status).toBe(200);
    expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(content);

    const attachment = await fetch(`${baseUrl}/api/attachments?sessionId=mock-current&name=large.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
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
    const socket = rawUpgrade(port, "/ws");
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
