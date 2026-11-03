import { rmSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { isolatedAuthEnv } from "./auth-isolation.js";

it("defaults child fixtures to production even under an inherited development harness", () => {
  vi.stubEnv("PI_WEB_DEV", "1");
  vi.stubEnv("NODE_ENV", "development");
  const env = isolatedAuthEnv();
  try {
    expect(env.PI_WEB_DEV).toBe("0");
    expect({ ...env, PI_WEB_DEV: "1" }.PI_WEB_DEV).toBe("1");
    expect(process.env.PI_WEB_DEV).toBe("1");
  } finally {
    rmSync(env.PI_WEB_HOME!, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
