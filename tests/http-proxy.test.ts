import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { proxyHttpRequest } from "../server/shared/httpProxy.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for proxy socket state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("supervisor HTTP proxy", () => {
  it("retains a valid public Host when preserveHost is enabled", async () => {
    let receivedHost: string | undefined;
    const upstreamPort = await listen(createServer((req, res) => {
      receivedHost = req.headers.host;
      res.end("ok");
    }));
    const proxyPort = await listen(createServer((req, res) => {
      proxyHttpRequest(req, res, { host: "127.0.0.1", port: upstreamPort, preserveHost: true });
    }));

    await new Promise<void>((resolve, reject) => {
      const client = request({
        host: "127.0.0.1",
        port: proxyPort,
        path: "/",
        headers: { host: "public.synthetic.invalid" },
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      client.once("error", reject);
      client.end();
    });

    expect(receivedHost).toBe("public.synthetic.invalid");
  });

  it("falls back to the upstream authority when preserveHost has no Host header", async () => {
    let receivedHost: string | undefined;
    const upstreamPort = await listen(createServer((req, res) => {
      receivedHost = req.headers.host;
      res.end("ok");
    }));
    const proxyPort = await listen(createServer((req, res) => {
      proxyHttpRequest(req, res, { host: "127.0.0.1", port: upstreamPort, preserveHost: true });
    }));

    const response = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.0\r\nConnection: close\r\n\r\n");
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    expect(response).toContain("200 OK");
    expect(receivedHost).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it("closes the upstream socket when a client disconnects while awaiting a response", async () => {
    const upstreamSockets = new Set<Socket>();
    const upstream = createServer(() => {
      // Deliberately leave the response pending so the client can disconnect first.
    });
    upstream.on("connection", (socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
    });
    const upstreamPort = await listen(upstream);

    const proxy = createServer((req, res) => {
      proxyHttpRequest(req, res, { host: "127.0.0.1", port: upstreamPort });
    });
    const proxyPort = await listen(proxy);

    const client = request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/pending",
    });
    client.on("error", () => undefined);
    client.end();

    await waitFor(() => upstreamSockets.size === 1);
    client.destroy();
    await waitFor(() => upstreamSockets.size === 0);

    expect(upstreamSockets.size).toBe(0);
  });
});
