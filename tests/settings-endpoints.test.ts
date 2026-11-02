import { isolatedAuthEnv } from "./auth-isolation.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/settings`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${baseUrl}`);
}

function startServer(port: number, cwd: string, settingsFile: string, agentDir: string, mock: boolean) {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...isolatedAuthEnv(),
      ...(mock ? { PI_WEB_MOCK: "1" } : { PI_WEB_NO_SESSION: "1" }),
      PI_WEB_DEV: "0", // HTTP contracts do not need a Vite optimizer.
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_TOKEN: "",
      PI_WEB_CWD: cwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_SETTINGS_FILE: settingsFile,
      PI_WEB_SESSION_UI_STATE_FILE: join(cwd, "session-ui-state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (data) => process.stderr.write(data));
  return child;
}

async function jsonRequest(baseUrl: string, path: string, method: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: baseUrl, "x-pi-web-client-id": "settings-endpoints-test" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function chunkedJsonRequest(port: number, path: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        origin: `http://127.0.0.1:${port}`,
        "x-pi-web-client-id": "settings-endpoints-test",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on("error", reject);
    const serialized = JSON.stringify(body);
    for (let offset = 0; offset < serialized.length; offset += 32 * 1024) {
      req.write(serialized.slice(offset, offset + 32 * 1024));
    }
    req.end();
  });
}

function rawRequest(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "PATCH", headers: { origin: `http://127.0.0.1:${port}`, "x-pi-web-client-id": "settings-endpoints-test" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

const OWNER = "test.settings";
const OWNER_PATH = `/api/settings/extensions/${encodeURIComponent(OWNER)}`;
const REVISION_ERROR = { ok: false, error: "expectedRevision must be a non-negative integer" };

describe("extension settings HTTP endpoints with a live schema", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let port: number;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pi-web-settings-endpoints-"));
    const extensionsDir = join(workspace, ".pi", "web", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "settings-test.js"), `
export default function settingsTest(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.web.registerSettings({
      id: "${OWNER}",
      title: "Endpoint test settings",
      schemaVersion: 1,
      fields: [{ key: "label", type: "text", label: "Label" }],
    });
  });
}
`);

    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const settingsFile = join(workspace, "settings.json");
    const agentDir = join(workspace, "agent");
    new ProjectTrustStore(agentDir).set(workspace, true);
    child = startServer(port, workspace, settingsFile, agentDir, false);
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("requires a non-negative integer expectedRevision for PATCH and reset", async () => {
    const invalidBodies = [
      {},
      { expectedRevision: -1 },
      { expectedRevision: 0.5 },
      { expectedRevision: "0" },
      { expectedRevision: Number.NaN }, // JSON serializes NaN as null.
    ];
    for (const body of invalidBodies) {
      const patch = await jsonRequest(baseUrl, OWNER_PATH, "PATCH", { values: { label: "next" }, ...body });
      expect(patch, `PATCH body ${JSON.stringify(body)}`).toEqual({ status: 400, body: REVISION_ERROR });

      const reset = await jsonRequest(baseUrl, `${OWNER_PATH}/reset`, "POST", body);
      expect(reset, `reset body ${JSON.stringify(body)}`).toEqual({ status: 400, body: REVISION_ERROR });
    }
  });

  it("returns the actual revision when PATCH detects a conflict", async () => {
    const first = await jsonRequest(baseUrl, OWNER_PATH, "PATCH", {
      values: { label: "first" },
      expectedRevision: 0,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, revision: 1 });

    const conflict = await jsonRequest(baseUrl, OWNER_PATH, "PATCH", {
      values: { label: "stale" },
      expectedRevision: 0,
    });
    expect(conflict).toEqual({
      status: 409,
      body: { ok: false, error: "revision conflict", actualRevision: 1 },
    });
  });

  it("rejects PATCH when the requested extension has no live schema", async () => {
    const result = await jsonRequest(baseUrl, "/api/settings/extensions/not-loaded.settings", "PATCH", {
      values: {},
      expectedRevision: 0,
    });
    expect(result).toEqual({ status: 409, body: { ok: false, error: "extension not loaded" } });
  });

  it("rejects a malformed percent-encoded owner id", async () => {
    const result = await rawRequest(port, "/api/settings/extensions/%E0%A4%A");
    expect(result).toEqual({ status: 400, body: { ok: false, error: "malformed owner id" } });
  });

  it("bounds generic settings bodies and fields while preserving the previous settings", async () => {
    const before = await (await fetch(`${baseUrl}/api/settings`)).json();
    const beforeUi = await (await fetch(`${baseUrl}/api/session-ui-state`)).json();
    const longField = await jsonRequest(baseUrl, "/api/settings", "PATCH", {
      defaults: { thinkingLevel: "x".repeat(33) },
    });
    expect(longField).toMatchObject({ status: 413, body: { ok: false, error: expect.stringContaining("defaults.thinkingLevel") } });

    const largeBody = await chunkedJsonRequest(port, "/api/settings", "PATCH", {
      padding: "x".repeat(256 * 1024),
    });
    expect(largeBody).toMatchObject({ status: 413, body: { ok: false, error: "Request body is too large" } });
    expect(await (await fetch(`${baseUrl}/api/settings`)).json()).toEqual(before);

    const largeUiBody = await chunkedJsonRequest(port, "/api/session-ui-state", "PATCH", {
      padding: "x".repeat(8 * 1024 * 1024),
    });
    expect(largeUiBody).toMatchObject({ status: 413, body: { ok: false, error: "Request body is too large" } });
    expect(await (await fetch(`${baseUrl}/api/session-ui-state`)).json()).toEqual(beforeUi);

    const identity = await fetch(`${baseUrl}/identity/config.json`);
    expect(identity.status).toBe(200);
    expect(child.exitCode).toBeNull();
  });
});

describe("extension settings reset HTTP endpoint without a live schema", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pi-web-settings-unloaded-"));
    const settingsFile = join(workspace, "settings.json");
    await writeFile(settingsFile, JSON.stringify({
      version: 1,
      extensions: {
        "stored.only": { schemaVersion: 1, revision: 3, values: { label: "saved" } },
      },
    }));
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = startServer(port, workspace, settingsFile, join(workspace, "agent"), true);
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("reports reset revision conflicts for stored settings whose extension is unloaded", async () => {
    const result = await jsonRequest(baseUrl, "/api/settings/extensions/stored.only/reset", "POST", {
      expectedRevision: 2,
    });
    expect(result).toEqual({
      status: 409,
      body: { ok: false, error: "revision conflict", actualRevision: 3 },
    });
  });

  it("resets stored settings even when their extension is unloaded", async () => {
    const result = await jsonRequest(baseUrl, "/api/settings/extensions/stored.only/reset", "POST", {
      expectedRevision: 3,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(result.body.settings.extensions?.["stored.only"]).toBeUndefined();

    const persisted = await (await fetch(`${baseUrl}/api/settings`)).json();
    expect(persisted.settings.extensions?.["stored.only"]).toBeUndefined();
  });
});
