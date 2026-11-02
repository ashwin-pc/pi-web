import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { AuthStore, hashSecret, randomSecret } from "../../server/auth/kernel.js";
import { isolatedAuthEnv } from "../auth-isolation.js";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function openSocket(url: string, origin: string) {
  const socket = new WebSocket(url, { origin });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test("owner bootstraps password, enrolls passkey, and retains supported auth protections", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "isolated", "One isolated Chromium authentication flow");
  test.setTimeout(60_000);
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "pi-multi-auth-e2e-"));
  const origin = `http://localhost:${port}`;
  const authPath = join(dir, "auth.json");
  const setupToken = randomSecret();
  const store = new AuthStore(authPath);
  await store.update(state => {
    state.config = { policy: "authenticated", methods: [] };
    state.bootstrap = {
      hash: hashSecret(setupToken),
      expiresAt: Date.now() + 60_000,
    };
  });
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...isolatedAuthEnv(),
      PI_WEB_AUTH_STORE: authPath,
      PI_WEB_AUTH_POLICY: "authenticated",
      PI_WEB_AUTH_ORIGIN: origin,
      PI_WEB_MOCK: "1",
      PI_WEB_CWD: process.cwd(),
      PI_WEB_DEV: "0",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_SETTINGS_FILE: join(dir, "settings.json"),
      PI_WEB_SESSION_UI_STATE_FILE: join(dir, "sessions.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => (output += data));
  child.stderr.on("data", data => (output += data));
  const owner = await browser.newContext({ serviceWorkers: "block" });
  const fresh = await browser.newContext({ serviceWorkers: "block" });
  const second = await browser.newContext({ serviceWorkers: "block" });
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(output);
      return fetch(`${origin}/api/state`).then(response => response.status).catch(() => 0);
    }, { timeout: 15_000 }).toBe(401);

    const page = await owner.newPage();
    await page.goto(`${origin}/api/auth/bootstrap?token=${encodeURIComponent(setupToken)}`);
    await page.getByLabel("New password (12+ characters)").fill("my secure replacement password");
    await page.getByLabel("Confirm password").fill("my secure replacement password");
    await page.getByRole("button", { name: "Set password", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator("#prompt")).toBeVisible();

    const passkey = await owner.newCDPSession(page);
    await passkey.send("WebAuthn.enable");
    await passkey.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.locator("#sessionButton").click();
    await openSessionDrawerFooterAction(page, "System");
    await page.locator("#settingsNavAccess").click();
    const security = page.locator("#securitySettings");
    await security.locator(".securityRow", { hasText: "Passkeys" }).getByRole("button", { name: "Manage" }).click();
    await security.getByPlaceholder("Passkey name").fill("Test authenticator");
    await security.getByRole("button", { name: "Add passkey", exact: true }).click();
    await expect(security.getByText("Test authenticator", { exact: true })).toBeVisible();

    const cookie = (await owner.cookies(origin)).map(item => `${item.name}=${item.value}`).join("; ");
    const headers = {
      cookie,
      origin,
      "x-pi-web-client-id": "regression",
      "content-type": "application/json",
    };
    expect((await fetch(`${origin}/api/auth/authorize`, { method: "POST", headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/auth/authorize`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example", "x-forwarded-host": "evil.example" },
    })).status).toBe(403);

    const machine = await (await fetch(`${origin}/api/auth/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ws-regression" }),
    })).json() as { id: string; secret: string };
    expect(machine.secret).toMatch(/^piw_/);
    expect((await fetch(`${origin}/api/auth/security`, {
      headers: { authorization: `Bearer ${machine.secret}` },
    })).status).toBe(200);
    expect((await fetch(`${origin}/api/auth/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${machine.secret}`, "content-type": "application/json" },
      body: "{}",
    })).status).toBe(403);
    const ticket = await (await fetch(`${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${machine.secret}` },
    })).json() as { ticket: string };
    const socket = await openSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket.ticket}`, origin);
    const closed = new Promise<number>(resolve => socket.once("close", resolve));
    expect((await fetch(`${origin}/api/auth/tokens/${machine.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await closed).toBe(1008);

    const retained = await (await fetch(`${origin}/api/auth/tokens`, {
      method: "POST",
      headers,
      body: "{}",
    })).json() as { secret: string };
    const retainedTicket = await (await fetch(`${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${retained.secret}` },
    })).json() as { ticket: string };
    const retainedSocket = await openSocket(`ws://127.0.0.1:${port}/ws?ticket=${retainedTicket.ticket}`, origin);
    const retainedClosed = new Promise<number>(resolve => retainedSocket.once("close", resolve));
    expect((await fetch(`${origin}/api/auth/sessions`, { method: "DELETE", headers, body: "{}" })).status).toBe(200);
    expect(await retainedClosed).toBe(1008);
    expect((await fetch(`${origin}/api/state`, {
      headers: { authorization: `Bearer ${retained.secret}` },
    })).status).toBe(401);
    expect((await fetch(`${origin}/api/state`, { headers: { cookie } })).status).toBe(401);

    const login = await fresh.newPage();
    await login.goto(`${origin}/api/auth/login`);
    await login.getByRole("button", { name: "Use a password", exact: true }).click();
    await login.getByLabel("Password", { exact: true }).fill("my secure replacement password");
    await login.locator('form[data-method="password"] button').click();
    await expect(login).toHaveURL(`${origin}/`);

    const other = await second.newPage();
    await other.goto(`${origin}/api/auth/login`);
    await other.getByRole("button", { name: "Use a password", exact: true }).click();
    await other.getByLabel("Password", { exact: true }).fill("my secure replacement password");
    await other.locator('form[data-method="password"] button').click();
    await expect(other).toHaveURL(`${origin}/`);

    const inventory = await login.evaluate(async () => (await fetch("/api/auth/security")).json());
    const device = inventory.sessions.find((session: { current: boolean }) => !session.current);
    expect(device).toBeTruthy();
    await login.evaluate(async (id: string) => {
      await fetch(`/api/auth/sessions/${id}`, {
        method: "DELETE",
        headers: { "x-pi-web-client-id": "test" },
      });
    }, device.id);
    expect((await second.request.get(`${origin}/api/state`)).status()).toBe(401);
    await other.goto(`${origin}/api/auth/login`);
    await other.getByRole("button", { name: "Use a password", exact: true }).click();
    await other.getByLabel("Password", { exact: true }).fill("my secure replacement password");
    await other.locator('form[data-method="password"] button').click();
    await expect(other).toHaveURL(`${origin}/`);

    await page.goto(`${origin}/api/auth/login`);
    await page.route("**/api/auth/passkey/options", route =>
      route.fulfill({ status: 503, json: { error: "Authenticator temporarily unavailable" } }));
    const signIn = page.getByRole("button", { name: "Sign in with passkey", exact: true });
    await signIn.click();
    await expect(page.getByRole("status")).toHaveText("Authenticator temporarily unavailable");
    await expect(signIn).toBeEnabled();
    await page.unroute("**/api/auth/passkey/options");
    await signIn.click();
    await expect(page).toHaveURL(`${origin}/`);
    const verified = await page.evaluate(async () => (await fetch("/api/auth/security")).json());
    expect(verified.verifiedMethods).toContain("passkey");

    const logoutCookie = (await owner.cookies(origin)).map(item => `${item.name}=${item.value}`).join("; ");
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: logoutCookie, origin, "x-pi-web-client-id": "logout" },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${origin}/api/state`, { headers: { cookie: logoutCookie } })).status).toBe(401);
    expect(await (await fetch(`${origin}/api/auth/challenge`, { headers: { cookie: logoutCookie } })).json()).toMatchObject({
      mode: "redirect",
      url: "/api/auth/login",
    });
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    await owner.close();
    await fresh.close();
    await second.close();
    child.kill("SIGTERM");
    await new Promise<void>(resolve =>
      child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
