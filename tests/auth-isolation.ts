import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every child server gets its own store; never inherit a developer's live auth config. */
export function isolatedAuthEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Include RP ID and future auth options. Empty values also override hosts
  // (e.g. Playwright) that merge this environment over the parent's environment.
  for (const key of Object.keys(env)) if (key.startsWith("PI_WEB_AUTH_") || key === "PI_WEB_TOKEN") env[key] = "";
  return { ...env, PI_WEB_AUTH_STORE: join(mkdtempSync(join(tmpdir(), "pi-web-test-auth-")), "auth.json"), PI_WEB_AUTH_MODE: "none" };
}
