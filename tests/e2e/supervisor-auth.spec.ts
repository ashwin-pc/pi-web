import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AuthStore, hashSecret } from "../../server/auth/kernel.js";
import { isolatedAuthEnv } from "../auth-isolation.js";

const projectRoot = new URL("../..", import.meta.url).pathname;
const publicPort = Number(process.env.PLAYWRIGHT_PORT || 9980);
const childPort = publicPort + 1;
const origin = `http://127.0.0.1:${publicPort}`;
let supervisor: ChildProcess | undefined;

test.beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-web-playwright-supervisor-"));
  const store = new AuthStore(join(home, "auth.json"));
  await store.update((state) => {
    state.config = { policy: "authenticated", methods: [] };
    state.apiTokens.push({
      id: "playwright-machine",
      name: "Playwright machine",
      hash: hashSecret("synthetic-playwright-token"),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
  });
  const env = {
    ...isolatedAuthEnv(),
    HOST: "127.0.0.1",
    PORT: String(publicPort),
    PI_WEB_CHILD_PORT: String(childPort),
    PI_WEB_HOME: home,
    PI_WEB_AUTH_STORE: store.path,
    PI_WEB_AUTH_MODE: "none",
    PI_WEB_AUTH_POLICY: "authenticated",
    PI_WEB_AUTH_METHODS: "",
    PI_WEB_AUTH_ORIGIN: origin,
    PI_WEB_DEV: "1",
    PI_WEB_MOCK: "1",
    PI_WEB_NO_SESSION: "1",
  };
  delete env.PI_WEB_TOKEN;
  supervisor = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw new Error(`Supervisor exited before Playwright setup: ${supervisor.exitCode ?? supervisor.signalCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/state`, {
        headers: { authorization: "Bearer synthetic-playwright-token" },
      });
      if (response.ok) return;
    } catch {
      // The supervisor listener can be ready before its child.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out starting isolated Playwright supervisor");
});

test.afterAll(async () => {
  if (!supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  supervisor.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      supervisor?.kill("SIGKILL");
      resolve();
    }, 5_000);
    supervisor?.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

test("dev source requires auth while the authenticated browser app remains usable", async ({ page, request }) => {
  expect((await request.get(`${origin}/src/main.ts`)).status()).toBe(401);
  expect((await request.get(`${origin}/src/main.ts`, {
    headers: { authorization: "Bearer synthetic-playwright-token" },
  })).status()).toBe(200);

  await page.setExtraHTTPHeaders({ authorization: "Bearer synthetic-playwright-token" });
  await page.goto(origin);
  await expect(page.locator("#statusBar")).toBeVisible();
});
