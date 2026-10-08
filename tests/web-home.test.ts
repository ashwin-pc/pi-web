import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import { resolveWebHomePath } from "../server/shared/webHome.js";
import { createSettingsStore } from "../server/settings.js";
import { resolvePiWebExtensionPaths } from "../server/extensions.js";
import { archivePath, storePath } from "../examples/pi-web-extensions/notepad.js";

afterEach(() => vi.unstubAllEnvs());
const agent = join(homedir(), ".pi", "agent");
const paths = [
  ["web/auth.json", join(agent, "web", "auth.json")],
  ["pi-web-session-ui-state.json", join(agent, "pi-web-session-ui-state.json")],
  ["pi-web-push.json", join(agent, "pi-web-push.json")],
  ["pi-web-settings.json", join(agent, "pi-web-settings.json")],
  ["extensions", join(homedir(), ".pi", "web", "extensions")],
  ["notepad.json", join(agent, "notepad.json")],
  ["notepad.md", join(agent, "notepad.md")],
];

describe("resolveWebHomePath", () => {
  it.each(paths)("preserves the legacy %s default", (file, legacy) => {
    expect(resolveWebHomePath(file, legacy, undefined, {})).toBe(legacy);
    expect(resolveWebHomePath(file, legacy, "", { PI_WEB_HOME: "" })).toBe(legacy);
  });
  it.each(paths)("roots %s under PI_WEB_HOME, below explicit overrides", (file, legacy) => {
    expect(resolveWebHomePath(file, legacy, undefined, { PI_WEB_HOME: "/tmp/web" })).toBe(join("/tmp/web", file));
    expect(resolveWebHomePath(file, legacy, "/custom/file", { PI_WEB_HOME: "/tmp/web" })).toBe("/custom/file");
    expect(resolveWebHomePath(file, legacy, "/custom/file", {})).toBe("/custom/file");
  });
  it("keeps notepad's legacy home independent of PI_CODING_AGENT_DIR and scopes its archive too", () => {
    vi.stubEnv("PI_WEB_HOME", ""); vi.stubEnv("PI_WEB_NOTEPAD_FILE", ""); vi.stubEnv("PI_CODING_AGENT_DIR", "/agent-only");
    expect(storePath()).toBe(join(agent, "notepad.json")); expect(archivePath()).toBe(join(agent, "notepad-archive.jsonl"));
    vi.stubEnv("PI_WEB_HOME", "/web");
    expect(storePath()).toBe("/web/notepad.json"); expect(archivePath()).toBe("/web/notepad-archive.jsonl");
    vi.stubEnv("PI_WEB_NOTEPAD_FILE", "/override/custom.json");
    expect(storePath()).toBe("/override/custom.json"); expect(archivePath()).toBe("/override/custom-archive.jsonl");
  });
  it("discovers scoped global extensions alongside project extensions and writes settings to the scoped home", async () => {
    const home = mkdtempSync(join(tmpdir(), "web-home-"));
    vi.stubEnv("PI_WEB_HOME", home); vi.stubEnv("PI_WEB_SETTINGS_FILE", "");
    try {
      const globalExtension = join(home, "extensions", "global.ts");
      const projectExtension = join(home, "project", ".pi", "web", "extensions", "project.ts");
      for (const file of [globalExtension, projectExtension]) {
        mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "export default () => {};");
      }
      expect(resolvePiWebExtensionPaths(join(home, "project"))).toEqual([projectExtension, globalExtension]);
      const store = createSettingsStore(resolveWebHomePath("pi-web-settings.json", "/legacy/settings.json", process.env.PI_WEB_SETTINGS_FILE));
      await store.patch({ appearance: { density: "compact" } });
      expect(existsSync(join(home, "pi-web-settings.json"))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
