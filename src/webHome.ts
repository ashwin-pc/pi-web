import { join } from "node:path";

/** Resolve pi-web-owned state: explicit legacy override, scoped home, legacy path. */
export function resolveWebHomePath(file: string, legacyPath: string, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return override;
  return env.PI_WEB_HOME ? join(env.PI_WEB_HOME, file) : legacyPath;
}
