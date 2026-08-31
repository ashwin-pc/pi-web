import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import artifactReference from "../../examples/pi-web-extensions/artifact-reference.js";
import { createGitFooterExtension } from "../../examples/pi-web-extensions/git-footer.js";
import githubRepoPanel from "../../examples/pi-web-extensions/github-repo-panel.js";
import globalNotepad from "../../examples/pi-web-extensions/notepad.js";

const issues = [
  { number: 184, title: "Clarify keyboard shortcuts in onboarding", url: "https://github.com/example/studio/issues/184", author: { login: "sam" }, labels: [{ name: "documentation", color: "4fa7d1" }], assignees: [{ login: "lee" }], comments: [], createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z" },
  { number: 179, title: "Keep attachment drafts after reconnecting", url: "https://github.com/example/studio/issues/179", author: { login: "morgan" }, labels: [{ name: "reliability", color: "7dbf68" }], assignees: [], comments: [], createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z" },
];
const pulls = [
  { number: 192, title: "Improve compact composer controls", url: "https://github.com/example/studio/pull/192", author: { login: "alex" }, labels: [{ name: "ui", color: "b48ead" }], assignees: [], comments: [], headRefName: "composer-controls", baseRefName: "main", isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "CLEAN", additions: 84, deletions: 21, changedFiles: 5, createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z" },
];

function result(stdout = "", code = 0) {
  return { stdout, stderr: "", code, killed: false };
}

export default function recommendedAddonsExtension(pi: any, cwd: string) {
  const runtimeDir = process.env.PI_WEB_SETTINGS_FILE ? dirname(process.env.PI_WEB_SETTINGS_FILE) : join(cwd, ".pi", "visual-fixtures");
  const notepadPath = join(runtimeDir, "recommended-notepad.json");
  mkdirSync(dirname(notepadPath), { recursive: true });
  writeFileSync(notepadPath, JSON.stringify({ version: 1, entries: [
    { id: "n-plan", text: "Review the launch checklist with the team", kind: "task", status: "open", pinned: true, tags: ["launch"], due: "2026-06-12", created: "2026-06-01T09:00:00Z", updated: "2026-06-01T09:00:00Z", source: { by: "user" } },
    { id: "n-decision", text: "Use the compact composer for phone layouts", kind: "decision", status: "open", pinned: false, tags: ["mobile"], created: "2026-06-01T09:05:00Z", updated: "2026-06-01T09:05:00Z", source: { by: "agent", sessionName: "Responsive workspace review" } },
    { id: "n-note", text: "Customer research notes are ready for handoff", kind: "note", status: "open", pinned: false, tags: ["research"], created: "2026-06-01T09:10:00Z", updated: "2026-06-01T09:10:00Z", source: { by: "user" } }
  ] }, null, 2));
  process.env.PI_WEB_NOTEPAD_FILE = notepadPath;

  const originalExec = pi.exec;
  pi.exec = async (command: string, args: string[]) => {
    if (command === "git" && args.includes("rev-parse")) return result("true");
    if (command === "git" && args.includes("config")) return result("remote.origin.url https://github.com/example/studio.git");
    if (command === "gh" && args[0] === "issue" && args[1] === "list") return result(JSON.stringify(issues));
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return result(JSON.stringify(pulls));
    return originalExec?.(command, args) || result("", 1);
  };

  globalNotepad(pi);
  pi.on("session_start", (_event: unknown, ctx: any) => ctx.ui.web.contribute("website-recap-preview", {
    slot: "header-action",
    kind: "rendered",
    icon: "scroll-text",
    title: "Session recap preview",
    label: "Recap",
    render: async () => ({ markdown: "**Launch direction:** faster handoffs, grounded in customer evidence.\n\n**Now:** final accessibility review before sharing." }),
  }));
  artifactReference(pi);
  githubRepoPanel(pi);
  createGitFooterExtension({
    refreshMs: 60_000,
    git: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { ok: true, output: "true" };
      if (args[0] === "branch") return { ok: true, output: "main" };
      if (args[0] === "status") return { ok: true, output: " M website/src/pages/extensions/index.astro\n?? research-notes.md" };
      return { ok: false, output: "" };
    },
  })(pi);
}
