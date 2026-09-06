import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every child server gets its own store; never inherit a developer's live auth config. */
export function isolatedAuthEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_WEB_AUTH_STORE: join(mkdtempSync(join(tmpdir(), "pi-web-test-auth-")), "auth.json"), PI_WEB_AUTH_MODE: "none", PI_WEB_AUTH_POLICY: "", PI_WEB_AUTH_METHODS: "", PI_WEB_AUTH_ORIGIN: "", PI_WEB_AUTH_TRUSTED_HEADER: "" };
}
