import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { isolatedAuthEnv } from "../auth-isolation.js";

afterEach(() => vi.unstubAllEnvs());

it("isolates all inherited auth configuration, including RP ID and future options", () => {
  vi.stubEnv("PI_WEB_AUTH_RP_ID", "production.example");
  vi.stubEnv("PI_WEB_AUTH_STORE", "/production/auth.json");
  vi.stubEnv("PI_WEB_AUTH_FUTURE_OPTION", "production");
  vi.stubEnv("PI_WEB_TOKEN", "production-token");
  const env = isolatedAuthEnv();
  try {
    expect(env.PI_WEB_AUTH_RP_ID).toBe("");
    expect(env.PI_WEB_AUTH_FUTURE_OPTION).toBe("");
    expect(env.PI_WEB_TOKEN).toBe("");
    expect(env.PI_WEB_AUTH_MODE).toBe("none");
    expect(env.PI_WEB_AUTH_STORE).not.toBe("/production/auth.json");
    expect(process.env.PI_WEB_AUTH_STORE).toBe("/production/auth.json");
    expect(process.env.PI_WEB_AUTH_RP_ID).toBe("production.example");
  } finally { rmSync(dirname(env.PI_WEB_AUTH_STORE!), { recursive: true, force: true }); }
});
