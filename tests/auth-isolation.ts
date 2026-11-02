import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every child server gets its own home; never inherit a developer's live state or auth config. */
export function isolatedAuthEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Include RP ID and future auth options. Empty values also override hosts
  // (e.g. Playwright) that merge this environment over the parent's environment.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("PI_WEB_AUTH_") ||
      key === "PI_WEB_TOKEN" ||
      key === "PI_WEB_TUNNEL_SOCKET" ||
      key === "PI_WEB_SUPERVISOR_SECRET" ||
      key === "PI_WEB_SUPERVISED" ||
      (key.startsWith("PI_WEB_") && key.endsWith("_FILE"))
    ) env[key] = "";
  }
  const home = mkdtempSync(join(tmpdir(), "pi-web-test-auth-"));
  // Production is the fixture default, including direct Vitest runs from a dev
  // harness. Development-mode fixtures can explicitly override this afterward.
  return { ...env, PI_WEB_DEV: "0", PI_WEB_HOME: home, PI_WEB_AUTH_STORE: join(home, "auth.json"), PI_WEB_AUTH_MODE: "none" };
}
