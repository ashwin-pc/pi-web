import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedAuthEnv } from "../auth-isolation.js";
import { openSessionDrawerFooterAction } from "./helpers/sessionDrawer.js";

test("legacy owner enrolls password and passkey, verifies login, and retires legacy", async ({
  browser,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "One isolated Chromium authentication flow",
  );
  test.setTimeout(60_000);
  const portServer = createServer();
  await new Promise<void>((resolve) =>
    portServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), "pi-multi-auth-e2e-")),
    origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...isolatedAuthEnv(),
      PI_WEB_AUTH_STORE: join(dir, "auth.json"),
      PI_WEB_AUTH_MODE: "legacy",
      PI_WEB_TOKEN: "owner-token",
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
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const owner = await browser.newContext({ serviceWorkers: "block" }),
    fresh = await browser.newContext({ serviceWorkers: "block" });
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(output);
          return fetch(origin)
            .then((r) => r.status)
            .catch(() => 0);
        },
        { timeout: 15_000 },
      )
      .toBe(200);
    const page = await owner.newPage();
    await page.goto(`${origin}/?token=owner-token`);
    await expect(page.locator("#prompt")).toBeVisible();
    await page.locator("#sessionButton").click();
    await openSessionDrawerFooterAction(page, "Settings");
    await page.locator("#settingsNavAccess").click();
    const security = page.locator("#securitySettings");
    await security
      .getByPlaceholder("New password (12+ characters)")
      .fill("my secure replacement password");
    await security
      .getByRole("button", { name: "Set password", exact: true })
      .click();
    await expect(
      security.getByRole("button", { name: "Change password" }),
    ).toBeVisible();
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
    await security.getByPlaceholder("Passkey name").fill("Test authenticator");
    await security
      .getByRole("button", { name: "Add passkey", exact: true })
      .click();
    await expect(
      security.getByText("Test authenticator", { exact: true }),
    ).toBeVisible();
    const login = await fresh.newPage();
    await login.goto(`${origin}/api/auth/login`);
    await login
      .getByLabel("Password", { exact: true })
      .fill("my secure replacement password");
    await login.locator('form[data-method="password"] button').click();
    await expect(login).toHaveURL(`${origin}/`);
    await expect(login.locator("#prompt")).toBeVisible();
    await page.locator("#settingsCloseButton").click();
    await page.locator("#sessionButton").click();
    await openSessionDrawerFooterAction(page, "Settings");
    await page.locator("#settingsNavAccess").click();
    const methods = security.locator("section", {
      has: page.getByRole("heading", { name: "Sign-in methods", exact: true }),
    });
    await methods
      .locator(".securityRow", {
        has: page.getByText("legacy", { exact: true }),
      })
      .getByRole("button", { name: "Disable" })
      .click();
    await expect(
      methods
        .locator(".securityRow", {
          has: page.getByText("legacy", { exact: true }),
        })
        .getByRole("button", { name: "Enable", exact: true }),
    ).toBeVisible();
    expect(
      (
        await fetch(`${origin}/api/state`, {
          headers: { authorization: "Bearer owner-token" },
        })
      ).status,
    ).toBe(401);
    const inventory = await page.evaluate(async () =>
      (await fetch("/api/auth/security")).json(),
    );
    expect(
      inventory.sessions.some(
        (s: { method: string; current: boolean }) =>
          s.method === "password" && !s.current,
      ),
    ).toBe(true);
    const device = inventory.sessions.find(
      (s: { method: string }) => s.method === "password",
    );
    await page.evaluate(async (id) => {
      await fetch(`/api/auth/sessions/${id}`, {
        method: "DELETE",
        headers: { "x-pi-web-client-id": "test" },
      });
    }, device.id);
    expect((await fresh.request.get(`${origin}/api/state`)).status()).toBe(401);
    await page.goto(`${origin}/api/auth/passkey-login`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    const verified = await page.evaluate(async () =>
      (await fetch("/api/auth/security")).json(),
    );
    expect(verified.verifiedMethods).toContain("passkey");
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    await owner.close();
    await fresh.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
