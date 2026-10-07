import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every child server gets its own home; never inherit a developer's live state or auth config. */
export function isolatedAuthEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Include RP ID and future auth options. Empty values also override hosts
  // (e.g. Playwright) that merge this environment over the parent's environment.
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WEB_AUTH_") || key === "PI_WEB_TOKEN" || (key.startsWith("PI_WEB_") && key.endsWith("_FILE"))) env[key] = "";
  }
  const home = mkdtempSync(join(tmpdir(), "pi-web-test-auth-"));
  return { ...env, PI_WEB_HOME: home, PI_WEB_AUTH_STORE: join(home, "auth.json"), PI_WEB_AUTH_MODE: "none" };
}
