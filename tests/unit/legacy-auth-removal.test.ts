import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { legacyAuthMigration, resolveAuthConfig } from "../../server/auth/config.js";
import { AuthKernel, AuthStore } from "../../server/auth/kernel.js";

describe("removed legacy token authentication", () => {
  it.each([
    { PI_WEB_TOKEN: "secret" },
    { PI_WEB_AUTH_MODE: "legacy" },
    { PI_WEB_AUTH_METHODS: "password,legacy" },
  ])("fails explicit legacy configuration with migration guidance", (env) => {
    expect(() => resolveAuthConfig(env)).toThrow(legacyAuthMigration);
  });

  it("defaults fresh installs to authenticated bootstrap with no enabled method", () => {
    expect(resolveAuthConfig({})).toMatchObject({
      policy: "authenticated",
      methods: [],
    });
  });

  it("ignores a stale token only when valid saved canonical settings prove retirement", () => {
    const warn = vi.fn();
    expect(
      resolveAuthConfig(
        { PI_WEB_TOKEN: "stale" },
        { policy: "authenticated", methods: ["password", "passkey"] },
        warn,
      ),
    ).toMatchObject({
      policy: "authenticated",
      methods: [],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored"));
    for (const saved of [
      { policy: "authenticated", methods: ["legacy"] },
      { policy: "invalid", methods: ["password"] },
      { policy: "authenticated", methods: ["password", "password"] },
    ]) {
      expect(() =>
        resolveAuthConfig({ PI_WEB_TOKEN: "stale" }, saved, warn),
      ).toThrow(legacyAuthMigration);
    }
    expect(() =>
      resolveAuthConfig(
        { PI_WEB_AUTH_MODE: "legacy", PI_WEB_TOKEN: "stale" },
        { policy: "authenticated", methods: ["password"] },
        warn,
      ),
    ).toThrow(legacyAuthMigration);
  });

  it("fails closed on saved legacy settings with recovery guidance", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pi-web-legacy-store-")), "auth.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      config: { policy: "authenticated", methods: ["legacy"] },
      credentials: [],
      sessions: [],
      apiTokens: [],
    }));
    const kernel = new AuthKernel("passkey", new AuthStore(path), false);
    await expect(kernel.startupDiagnostics()).rejects.toThrow("pi-web auth recover");
    expect(await readFile(path, "utf8")).toContain('"legacy"');
  });

  it("has no browser token persistence, replay, overlay, or scanner redirect code", () => {
    const root = new URL("../../", import.meta.url);
    const sourceFiles = [
      "src/app/types.ts",
      "src/app/api.ts",
      "src/composer/composer.ts",
      "src/app/elements.ts",
      "index.html",
    ];
    const sources = sourceFiles.map(path => readFileSync(new URL(path, root), "utf8")).join("\n");
    expect(sources).not.toMatch(/pi-web-token|tokenOverlay|tokenScan|extractTokenFromScannedText|authorization:\s*`Bearer \$\{state\.token\}`/);
    const main = readFileSync(new URL("src/main.ts", root), "utf8");
    expect(main.match(/pi-web-token/g)).toHaveLength(1);
    expect(main).toContain('localStorage.removeItem("pi-web-token")');
    expect(main).not.toMatch(/localStorage\.(?:getItem|setItem)\(\s*["']pi-web-token/);
  });
});
