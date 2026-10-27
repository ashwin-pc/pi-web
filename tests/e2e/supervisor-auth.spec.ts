import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AuthStore, hashSecret } from "../../server/auth/kernel.js";
import { isolatedAuthEnv } from "../auth-isolation.js";

const projectRoot = new URL("../..", import.meta.url).pathname;
let origin: string;
let home: string | undefined;
let supervisor: ChildProcess | undefined;
let supervisorOutput = "";
let supervisorSpawnError: Error | undefined;

async function reservePort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an isolated supervisor port");
  return address.port;
}

async function allocateSupervisorPorts(): Promise<[number, number]> {
  const publicServer = createServer();
  const childServer = createServer();
  try {
    const [publicPort, childPort] = await Promise.all([
      reservePort(publicServer),
      reservePort(childServer),
    ]);
    return [publicPort, childPort];
  } finally {
    await Promise.all([publicServer, childServer].map((server) =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      })
    ));
  }
}

function startupError(message: string): Error {
  const spawnFailure = supervisorSpawnError ? `\nSpawn error: ${supervisorSpawnError.message}` : "";
  return new Error(`${message}${spawnFailure}\nSupervisor output:\n${supervisorOutput || "<none>"}`);
}

test.beforeAll(async () => {
  const [publicPort, childPort] = await allocateSupervisorPorts();
  origin = `http://127.0.0.1:${publicPort}`;
  home = await mkdtemp(join(tmpdir(), "pi-web-playwright-supervisor-"));
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
  supervisor.stdout?.on("data", (data) => {
    supervisorOutput += data.toString();
  });
  supervisor.stderr?.on("data", (data) => {
    supervisorOutput += data.toString();
  });
  supervisor.once("error", (error) => {
    supervisorSpawnError = error;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (supervisorSpawnError) {
      throw startupError("Supervisor failed to spawn before Playwright setup");
    }
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw startupError(
        `Supervisor exited before Playwright setup: code=${supervisor.exitCode} signal=${supervisor.signalCode}`,
      );
    }
    let ready = false;
    try {
      const statusResponse = await fetch(`${origin}/__supervisor/status`, {
        headers: { authorization: "Bearer synthetic-playwright-token" },
      });
      if (statusResponse.ok) {
        const status = await statusResponse.json() as {
          ok?: boolean;
          childPid?: number;
          childPort?: number;
        };
        if (status.ok === true && typeof status.childPid === "number" && status.childPort === childPort) {
          const response = await fetch(`${origin}/api/state`, {
            headers: { authorization: "Bearer synthetic-playwright-token" },
          });
          ready = response.ok;
        }
      }
    } catch {
      // The supervisor listener can be ready before its child.
    }
    if (ready) {
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        throw startupError(
          `Supervisor exited during Playwright setup: code=${supervisor.exitCode} signal=${supervisor.signalCode}`,
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw startupError("Timed out starting isolated Playwright supervisor");
});

test.afterAll(async () => {
  try {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
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
    }
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
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
