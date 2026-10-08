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
    expect(env.PI_WEB_HOME).toBe(dirname(env.PI_WEB_AUTH_STORE!));
    expect(process.env.PI_WEB_AUTH_STORE).toBe("/production/auth.json");
    expect(process.env.PI_WEB_AUTH_RP_ID).toBe("production.example");
  } finally { rmSync(dirname(env.PI_WEB_AUTH_STORE!), { recursive: true, force: true }); }
});

it("isolates inherited home and per-file overrides for every child without mutating the parent", () => {
  vi.stubEnv("PI_WEB_HOME", "/production/web");
  for (const key of ["PI_WEB_SETTINGS_FILE", "PI_WEB_SESSION_UI_STATE_FILE", "PI_WEB_PUSH_FILE", "PI_WEB_NOTEPAD_FILE"]) {
    vi.stubEnv(key, `/production/${key}.json`);
  }
  const first = isolatedAuthEnv();
  const second = isolatedAuthEnv();
  try {
    expect(first.PI_WEB_HOME).not.toBe("/production/web");
    expect(second.PI_WEB_HOME).not.toBe(first.PI_WEB_HOME);
    for (const key of ["PI_WEB_SETTINGS_FILE", "PI_WEB_SESSION_UI_STATE_FILE", "PI_WEB_PUSH_FILE", "PI_WEB_NOTEPAD_FILE"]) {
      expect(first[key]).toBe("");
      expect(process.env[key]).toBe(`/production/${key}.json`);
    }
    expect(process.env.PI_WEB_HOME).toBe("/production/web");
  } finally {
    for (const env of [first, second]) rmSync(env.PI_WEB_HOME!, { recursive: true, force: true });
  }
});
