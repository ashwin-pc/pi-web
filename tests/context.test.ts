import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function text(path: string) {
  return readFile(join(root, path), "utf-8");
}

describe("agent context organization", () => {
  it("keeps web UI artifact instructions in the always-injected context", async () => {
    const context = await text("contexts/web-ui.md");

    expect(context).toContain("pi-web UI context");
    expect(context).toContain(".pi/web/artifacts/");
    expect(context).toContain("/api/artifacts/<path>/<filename>");
    expect(context).toContain("Markdown image syntax");
  });

  it("keeps pi-web project instructions in AGENTS.md", async () => {
    const agents = await text("AGENTS.md");

    expect(agents).toContain("pi-web instructions");
    expect(agents).toContain("npm run typecheck");
    expect(agents).toContain("npm run build");
    expect(agents).toContain("POST /api/restart");
  });

  it("does not keep stale or project-specific context files in the global web context path", () => {
    expect(existsSync(join(root, "pi-web-agent-context.md"))).toBe(false);
    expect(existsSync(join(root, "contexts/pi-web-development.md"))).toBe(false);
  });

  it("the self-contained session service injects only generic web UI context and relies on Pi to load AGENTS.md", async () => {
    const service = await text("server/session/service.ts");

    expect(service).toContain('new URL("../../contexts/web-ui.md", import.meta.url)');
    expect(service).toContain("appendSystemPromptOverride");
    expect(service).toContain("webUiContext");

    expect(service).not.toContain("piWebDevelopmentContextFile");
    expect(service).not.toContain("pi-web-development.md");
    expect(service).not.toContain("piCwd === appDir ?");
    expect(service).not.toContain("pi-web-agent-context.md");
  });
});
