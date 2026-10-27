import { createServer, request } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonBodyReader, largeJsonBodyLimit, ordinaryJsonBodyLimit, pipeReadStream, readBytes } from "../server/httpTransport.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return address.port;
}

describe("HTTP transport helpers", () => {
  it("rejects a declared oversized body before reading any chunks", async () => {
    let consumed = false;
    const req = Readable.from((async function* () {
      consumed = true;
      yield "body";
    })()) as unknown as import("node:http").IncomingMessage;
    req.headers = { "content-length": "5" };
    await expect(readBytes(req, 4)).rejects.toMatchObject({ status: 413 });
    expect(consumed).toBe(false);
  });

  it("uses a small JSON default while allowing an explicit workspace-write budget", async () => {
    const readBody = createJsonBodyReader();
    const port = await listen(async (req, res) => {
      try {
        const body = await readBody(req, req.url === "/large" ? largeJsonBodyLimit : undefined);
        res.writeHead(200).end(String((body as { value: string }).value.length));
      } catch (error: any) {
        res.writeHead(error.status || 500).end(error.message);
      }
    });
    const body = JSON.stringify({ value: "x".repeat(ordinaryJsonBodyLimit + 1) });
    expect((await fetch(`http://127.0.0.1:${port}/ordinary`, { method: "POST", body })).status).toBe(413);
    const large = await fetch(`http://127.0.0.1:${port}/large`, { method: "POST", body });
    expect(large.status).toBe(200);
    expect(await large.text()).toBe(String(ordinaryJsonBodyLimit + 1));
  });

  it("turns a pre-header file-stream error into an HTTP response", async () => {
    const port = await listen((_req, res) => {
      pipeReadStream(res, "missing", undefined, (() => {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => stream.destroy(Object.assign(new Error("gone"), { code: "ENOENT" })));
        return stream;
      }) as any);
    });
    const response = await fetch(`http://127.0.0.1:${port}/file`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: "Not found" });
  });

  it("disconnects a partially started response when its file stream fails", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      pipeReadStream(res, "broken", undefined, (() => {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => stream.destroy(new Error("read failed")));
        return stream;
      }) as any);
    });
    await expect(fetch(`http://127.0.0.1:${port}/file`).then((response) => response.arrayBuffer())).rejects.toThrow();
  });

  it("destroys the source stream when the response disconnects", async () => {
    const source = new PassThrough();
    const port = await listen((_req, res) => {
      pipeReadStream(res, "synthetic", undefined, (() => source) as any);
      source.write("first chunk");
    });
    const req = request({ host: "127.0.0.1", port, path: "/" });
    req.on("response", (res) => res.destroy());
    req.end();
    await once(source, "close");
    expect(source.destroyed).toBe(true);
  });
});
