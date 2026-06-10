import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

function execFilePromise(file: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    execFile(file, args, { cwd }, (error) => error ? reject(error) : resolve());
  });
}

async function initGitRepo(path: string) {
  await mkdir(path, { recursive: true });
  await execFilePromise("git", ["init"], path);
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${baseUrl}`);
}

describe("pi-web mock API", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let settingsDir: string;

  beforeAll(async () => {
    settingsDir = await mkdtemp(join(tmpdir(), "pi-web-api-settings-"));
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_SETTINGS_FILE: join(settingsDir, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(settingsDir, "session-ui-state.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
  });

  it("returns state, models, messages, and sessions", async () => {
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(state.sessionId).toBe("mock-current");
    expect(state.model.provider).toBe("mock");

    const models = await (await fetch(`${baseUrl}/api/models`)).json();
    expect(models.models).toHaveLength(1);
    expect(models.thinkingLevels).toContain("medium");

    const messages = await (await fetch(`${baseUrl}/api/messages`)).json();
    expect(messages.messages[0].text).toContain("image attachments");

    const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.every((item: any) => item.isCurrent === false)).toBe(true);
  });

  it("deletes a requested session", async () => {
    try {
      const deleteRes = await fetch(`${baseUrl}/api/sessions/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "mock-older" }),
      });
      expect(deleteRes.status).toBe(200);
      const deleted = await deleteRes.json();
      expect(deleted).toMatchObject({ ok: true, id: "mock-older", disposition: "deleted" });

      const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
      expect(sessions.sessions.map((item: any) => item.id)).toEqual(["mock-current"]);
    } finally {
      await fetch(`${baseUrl}/api/mock/reset`, { method: "POST" });
    }
  });

  it("creates folders from the directory picker API", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-picker-"));
    try {
      const res = await fetch(`${baseUrl}/api/fs/dirs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent, name: "new-project" }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.path).toBe(join(parent, "new-project"));
      expect(data.parent).toBe(parent);

      const listed = await (await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(parent)}`)).json();
      expect(listed.dirs.some((dir: any) => dir.name === "new-project")).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("returns and navigates the conversation tree", async () => {
    const tree = await (await fetch(`${baseUrl}/api/session/tree`)).json();
    expect(tree.sessionId).toBe("mock-current");
    expect(tree.leafId).toBe("mock-a1");
    expect(tree.entryCount).toBeGreaterThanOrEqual(4);
    expect(tree.branchPointCount).toBeGreaterThanOrEqual(1);

    const navigateRes = await fetch(`${baseUrl}/api/session/tree/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mock-current", targetId: "mock-u1" }),
    });
    expect(navigateRes.status).toBe(200);
    const navigate = await navigateRes.json();
    expect(navigate.editorText).toContain("image attachments");
    expect(navigate.leafId).toBeNull();

    const messages = await (await fetch(`${baseUrl}/api/messages`)).json();
    expect(messages.messages).toHaveLength(0);

    await fetch(`${baseUrl}/api/mock/reset`, { method: "POST" });
  });

  it("accepts text and image prompts", async () => {
    const res = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "describe this",
        images: [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), name: "tiny.png" }],
      }),
    });
    expect(res.status).toBe(202);

    const messages = await (await fetch(`${baseUrl}/api/messages`)).json();
    expect(messages.messages.at(-2).text).toContain("describe this");
    expect(messages.messages.at(-1).text).toContain("with image");
  });

  it("persists and returns settings", async () => {
    const initial = await (await fetch(`${baseUrl}/api/settings`)).json();
    expect(initial.settings.composer.queueMode).toBe("steer");

    const patchedRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appearance: { density: "compact" },
        composer: { queueMode: "followUp", expanded: true },
        defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low" },
      }),
    });
    expect(patchedRes.status).toBe(200);
    const patched = await patchedRes.json();
    expect(patched.settings).toMatchObject({
      appearance: { density: "compact" },
      composer: { queueMode: "followUp", expanded: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low" },
    });

    const current = await (await fetch(`${baseUrl}/api/settings`)).json();
    expect(current.settings.composer.queueMode).toBe("followUp");
  });

  it("persists and returns server session UI state", async () => {
    const initial = await (await fetch(`${baseUrl}/api/session-ui-state`)).json();
    expect(initial.sessionUiState.pinnedSessions).toEqual([]);
    expect(initial.sessionUiState.pinnedFolders).toEqual([]);
    expect(initial.sessionUiState.selectedMarkerColor).toBe("blue");

    const patchedRes = await fetch(`${baseUrl}/api/session-ui-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pinnedSessions: [{ id: "mock-current", label: "Current mock session", cwd: "." }],
        pinnedFolders: ["/work/repo-a", "/work/repo-b", "/work/repo-a", "", "  "],
        sessionMarkers: [{ sessionId: "mock-older", color: "green", updatedAt: "2026-01-01T00:00:00.000Z" }],
        selectedMarkerColor: "green",
      }),
    });
    expect(patchedRes.status).toBe(200);
    const patched = await patchedRes.json();
    expect(patched.sessionUiState).toMatchObject({
      pinnedSessions: [{ id: "mock-current", label: "Current mock session", cwd: "." }],
      pinnedFolders: ["/work/repo-a", "/work/repo-b"],
      sessionMarkers: [{ sessionId: "mock-older", color: "green" }],
      selectedMarkerColor: "green",
    });

    const current = await (await fetch(`${baseUrl}/api/session-ui-state`)).json();
    expect(current.sessionUiState.selectedMarkerColor).toBe("green");
    expect(current.sessionUiState.pinnedFolders).toEqual(["/work/repo-a", "/work/repo-b"]);

    // Reset for downstream tests.
    await fetch(`${baseUrl}/api/session-ui-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinnedFolders: [] }),
    });
  });

  it("applies saved defaults to new sessions", async () => {
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "high", sessionBucketColor: "red" } }),
      });

      const newRes = await fetch(`${baseUrl}/api/sessions/new`, { method: "POST" });
      expect(newRes.status).toBe(200);
      const data = await newRes.json();
      expect(data.model.provider).toBe("mock");
      expect(data.thinkingLevel).toBe("high");

      const uiState = await (await fetch(`${baseUrl}/api/session-ui-state`)).json();
      expect(uiState.sessionUiState.sessionMarkers).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: data.sessionId, color: "red" }),
      ]));
    } finally {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { sessionBucketColor: null } }),
      });
      await fetch(`${baseUrl}/api/mock/reset`, { method: "POST" });
    }
  });

  it("renames the current session", async () => {
    const res = await fetch(`${baseUrl}/api/session/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mock-current", name: "Renamed mock session" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionName).toBe("Renamed mock session");

    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(state.sessionName).toBe("Renamed mock session");

    const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    expect(sessions.sessions.find((item: any) => item.id === "mock-current").name).toBe("Renamed mock session");
  });

  it("rejects empty prompts", async () => {
    const res = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("executes supported slash commands", async () => {
    const reloadRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/reload" }),
    });
    expect(reloadRes.status).toBe(200);
    expect((await reloadRes.json()).message).toContain("Reloaded");

    const modelListRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/model" }),
    });
    expect(modelListRes.status).toBe(200);
    expect((await modelListRes.json()).message).toContain("mock/model");

    const thinkingRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/thinking low" }),
    });
    expect(thinkingRes.status).toBe(200);
    const thinking = await thinkingRes.json();
    expect(thinking.message).toContain("low");
    expect(thinking.state.thinkingLevel).toBe("low");

    const invalidRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/does-not-exist" }),
    });
    expect(invalidRes.status).toBe(500);
  });

  it("keeps background sessions running when another session is opened", async () => {
    const promptRes = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "slow background task" }),
    });
    expect(promptRes.status).toBe(202);

    const openRes = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mock-older" }),
    });
    expect(openRes.status).toBe(200);
    expect((await openRes.json()).sessionId).toBe("mock-older");

    const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const current = sessions.sessions.find((item: any) => item.id === "mock-current");
    const older = sessions.sessions.find((item: any) => item.id === "mock-older");
    expect(current.runtime.isRunning).toBe(true);
    expect(older.isCurrent).toBe(false);
    expect(older.runtime.isRunning).toBe(false);

    const defaultState = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(defaultState.sessionId).toBe("mock-current");
    const olderState = await (await fetch(`${baseUrl}/api/state?sessionId=mock-older`)).json();
    expect(olderState.sessionId).toBe("mock-older");
  });

  it("routes prompts to the requested session id without relying on a server-active session", async () => {
    const openRes = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mock-older" }),
    });
    expect(openRes.status).toBe(200);

    const promptRes = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mock-current", message: "slow background task" }),
    });
    expect(promptRes.status).toBe(202);
    expect((await promptRes.json()).sessionId).toBe("mock-current");

    const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const current = sessions.sessions.find((item: any) => item.id === "mock-current");
    const older = sessions.sessions.find((item: any) => item.id === "mock-older");
    expect(current.runtime.isRunning).toBe(true);
    expect(current.isCurrent).toBe(false);
    expect(older.isCurrent).toBe(false);
  });

  it("creates and opens sessions through validated session APIs", async () => {
    const newRes = await fetch(`${baseUrl}/api/sessions/new`, { method: "POST" });
    expect(newRes.status).toBe(200);
    expect((await newRes.json()).sessionId).toMatch(/^mock-/);

    const openRes = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mock-older" }),
    });
    expect(openRes.status).toBe(200);
    expect((await openRes.json()).sessionId).toBe("mock-older");

    const invalid = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/not-allowed.jsonl" }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe("git repo discovery API", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pi-web-git-repos-"));
    await initGitRepo(join(workspace, "repo-a"));
    await writeFile(join(workspace, "repo-a", "a.txt"), "a\n");
    await initGitRepo(join(workspace, "repo-b"));
    await writeFile(join(workspace, "repo-b", "b.txt"), "b\n");
    await initGitRepo(join(workspace, "parent", "nested-repo"));
    await initGitRepo(join(workspace, "node_modules", "stray-repo"));

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_CWD: workspace },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    await waitForServer(baseUrl);
  }, 25_000);

  afterAll(async () => {
    child?.kill();
    await rm(workspace, { recursive: true, force: true });
  });

  it("discovers only the current folder and direct child repos by default", async () => {
    const res = await fetch(`${baseUrl}/api/git/repos`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.depth).toBe(1);
    expect(data.repos.map((repo: any) => repo.path).sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("runs git status in the selected repo and rejects paths outside the workspace", async () => {
    const statusRes = await fetch(`${baseUrl}/api/git/status?repo=repo-b`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.isRepo).toBe(true);
    expect(status.files.map((file: any) => file.path)).toContain("b.txt");
    expect(status.files.map((file: any) => file.path)).not.toContain("a.txt");

    const invalid = await fetch(`${baseUrl}/api/git/status?repo=../repo-b`);
    expect(invalid.status).toBe(400);
  });
});

describe("artifact serving", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let artifactDir: string;
  let legacyArtifactDir: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    artifactDir = join(process.cwd(), ".pi", "web", "artifacts");
    legacyArtifactDir = join(process.cwd(), ".pi-web-uploads", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(legacyArtifactDir, { recursive: true });
    await writeFile(join(artifactDir, "test.png"), Buffer.from("PNG"));
    await writeFile(join(legacyArtifactDir, "legacy.png"), Buffer.from("LEGACY"));

    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    await rm(join(artifactDir, "test.png"), { force: true });
    await rm(join(artifactDir, "e2e-test.png"), { force: true });
    await rm(join(legacyArtifactDir, "legacy.png"), { force: true });
  });

  it("serves an artifact file without authentication", async () => {
    const res = await fetch(`${baseUrl}/api/artifacts/test.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("PNG");
  });

  it("serves legacy artifacts as a read-only fallback", async () => {
    const res = await fetch(`${baseUrl}/api/artifacts/legacy.png`);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("LEGACY");
  });

  it("serves artifacts even when a token is configured", async () => {
    const port = await freePort();
    const tokenChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      // wait for server using the artifact endpoint itself (no auth needed)
      const tokenBaseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${tokenBaseUrl}/api/artifacts/test.png`);
          if (r.status === 200 || r.status === 404) break;
        } catch { /* retry */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // artifact accessible without token
      const artifactRes = await fetch(`${tokenBaseUrl}/api/artifacts/test.png`);
      expect(artifactRes.status).toBe(200);
      // api route still requires token
      const apiRes = await fetch(`${tokenBaseUrl}/api/state`);
      expect(apiRes.status).toBe(401);
    } finally {
      tokenChild.kill();
    }
  }, 25_000);

  it("returns 404 for missing artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/artifacts/does-not-exist.png`);
    expect(res.status).toBe(404);
  });

  it("rejects path traversal attempts", async () => {
    const port = Number(baseUrl.split(":").at(-1));
    // Use raw HTTP to bypass URL normalization that would happen with fetch
    for (const path of [
      "/api/artifacts/..%2fserver.ts",
      "/api/artifacts/..%2F..%2Fserver.ts",
      "/api/artifacts/%2e%2e%2fserver.ts",
    ]) {
      const res = await rawGet(port, path);
      expect(res.status, `expected 400 for traversal: ${path}`).toBe(400);
    }
  });
});

describe("additional API coverage", () => {
  let child: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(() => {
    child?.kill();
  });

  it("state includes tokenRequired field", async () => {
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(state).toHaveProperty("tokenRequired");
    expect(state.tokenRequired).toBe(false);
  });

  it("state includes tokenRequired:true when token is configured", async () => {
    const port = await freePort();
    const tokenChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "mytoken" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const u = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${u}/api/state`, { headers: { authorization: "Bearer mytoken" } });
          if (r.ok) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      const state = await (await fetch(`${u}/api/state`, { headers: { authorization: "Bearer mytoken" } })).json();
      expect(state.tokenRequired).toBe(true);
    } finally {
      tokenChild.kill();
    }
  }, 25_000);

  it("aborts the current session via POST /api/abort", async () => {
    // Start a slow prompt so the session is streaming
    void fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "slow background task" }),
    });

    // Allow the mock to begin streaming
    await new Promise((r) => setTimeout(r, 100));

    const abortRes = await fetch(`${baseUrl}/api/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(abortRes.status).toBe(202);
    expect((await abortRes.json()).ok).toBe(true);

    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(state.isStreaming).toBe(false);
  });

  it("switches model via POST /api/model", async () => {
    const res = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", id: "model", thinkingLevel: "high" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model.provider).toBe("mock");
    expect(data.model.id).toBe("model");
    expect(data.thinkingLevel).toBe("high");
  });

  it("rejects /api/model with missing provider or id", async () => {
    const noProvider = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "model" }),
    });
    expect(noProvider.status).toBe(400);

    const noId = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock" }),
    });
    expect(noId.status).toBe(400);

    const notFound = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", id: "does-not-exist" }),
    });
    expect(notFound.status).toBe(404);
  });

  it("returns messages for a non-current session via ?sessionId query param", async () => {
    // Open older session to make it non-current first
    await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mock-older" }),
    });

    const res = await fetch(`${baseUrl}/api/messages?sessionId=mock-current`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.messages)).toBe(true);
    // mock-current has initial messages about image attachments
    expect(data.messages.some((m: any) => /image attachments/i.test(m.text))).toBe(true);
  });

  it("returns 404 for unknown sessionId in /api/messages", async () => {
    const res = await fetch(`${baseUrl}/api/messages?sessionId=does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("lists slash commands from web and pi resources", async () => {
    const res = await fetch(`${baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const names = data.commands.map((command: any) => command.name);
    expect(names).toContain("reload");
    expect(names).toContain("compact");
    expect(names).toContain("clear");
    expect(names).not.toContain("new-chat");
    expect(names).toContain("mock-extension");
    expect(names).toContain("mock-prompt");
    expect(names).toContain("skill:mock-skill");
  });

  it("executes /help slash command", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/help" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain("/reload");
    expect(data.message).toContain("/thinking");
    expect(data.message).toContain("/abort");
  });

  it("executes /model <provider/id> slash command to switch model", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/model mock/model" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain("mock/model");
    expect(data.state.model.provider).toBe("mock");
  });

  it("executes /thinking without args to show current level", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/thinking" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain("Thinking level:");
    expect(data.message).toContain("Available:");
  });

  it("executes /new slash command to create a fresh session", async () => {
    const stateBefore = await (await fetch(`${baseUrl}/api/state`)).json();
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/new" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain("New session");
    // Session id should have changed
    expect(data.state.sessionId).not.toBe(stateBefore.sessionId);
  });

  it("executes /abort slash command", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/abort" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("Aborted");
  });
});

describe("WebSocket authentication", () => {
  it("rejects WebSocket upgrade without a valid token when token is configured", async () => {
    const port = await freePort();
    const tokenChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      // Wait for the server to be ready by polling the artifact endpoint (no auth)
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/artifacts/nonexistent`);
          break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 100));
      }

      // Attempt WS without token — expect 401
      await expect(
        new Promise<void>((_resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          ws.on("unexpected-response", (_req, res) => {
            expect(res.statusCode).toBe(401);
            ws.terminate();
            _resolve();
          });
          ws.on("open", () => { ws.terminate(); reject(new Error("WS should have been rejected")); });
          ws.on("error", (err) => reject(err));
        })
      ).resolves.toBeUndefined();

      // Attempt WS with correct token — expect hello message
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data));
          expect(msg.type).toBe("hello");
          ws.close();
          resolve();
        });
        ws.on("error", reject);
      });
    } finally {
      tokenChild.kill();
    }
  }, 25_000);

  it("sends a hello message with session info on WebSocket connect (no token)", async () => {
    const port = await freePort();
    const noTokenChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data));
          expect(msg.type).toBe("hello");
          expect(msg.sessionId).toBeTruthy();
          expect(msg.model).toBeTruthy();
          ws.close();
          resolve();
        });
        ws.on("error", reject);
      });
    } finally {
      noTokenChild.kill();
    }
  }, 25_000);
});
