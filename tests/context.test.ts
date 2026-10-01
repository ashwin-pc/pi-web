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
    expect(context).toContain("pi-web-attachments-v2");
    expect(context).toContain("Reference attachments are pointers rather than embedded content");
    expect(context).toContain("`gh issue view`");
  });

  it("describes response formatting as optional capabilities while retaining safety rules", async () => {
    const context = await text("contexts/web-ui.md");

    expect(context).toContain("## Response formatting capabilities");
    expect(context).toContain("standard Markdown, including headings, lists, tables, code blocks, and blockquotes");
    expect(context).toContain("available tools, not required response structures");
    expect(context).toContain("Do not add a table, diagram, or interactive preview solely because the format is available");
    expect(context).toContain("`html-preview` blocks render in a sandboxed opaque-origin iframe");
    expect(context).toContain("guard access to `localStorage` or `sessionStorage` with `try`/`catch`");
    expect(context).toContain("When drawing a diagram, use a fenced Mermaid block instead of ASCII art");
    expect(context).toContain("Do not turn prose, lists, or tables into diagrams merely to use Mermaid");

    expect(context).not.toContain("at most two sentences");
    expect(context).not.toContain("give each concept 2–3 sentences");
    expect(context).not.toContain("Use one concept per widget");
    expect(context).not.toContain("If a visual could be a Mermaid diagram, it must be Mermaid");
    expect(context).not.toContain("Example of an appropriate interactive figure");
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
    expect(service).toContain("pi-web extension documentation (read when asked to build pi-web extensions or browser UI)");
    expect(service).toContain('join(appDir, "docs/pi-web-extensions.md")');
    expect(service).toContain('join(appDir, "examples/pi-web-extensions")');
    expect(service).toContain("notepad.ts shows the current contribute() API");

    expect(service).not.toContain("piWebDevelopmentContextFile");
    expect(service).not.toContain("pi-web-development.md");
    expect(service).not.toContain("piCwd === appDir ?");
    expect(service).not.toContain("pi-web-agent-context.md");
  });

  it("teaches the canonical contribution API throughout the first-party UI examples", async () => {
    const uiExamples = ["git-footer.ts", "recap.ts", "artifact-reference.ts", "github-repo-panel.ts", "notepad.ts"];
    for (const filename of uiExamples) {
      const example = await text(`examples/pi-web-extensions/${filename}`);
      expect(example).toContain(".contribute(");
      expect(example).not.toMatch(/\.set(?:Footer|HeaderAction|ArtifactAction|GitTab|Panel|FabAction)\(/);
    }
  });
});
