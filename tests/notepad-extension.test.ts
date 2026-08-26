import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import globalNotepad, { loadStore, saveStore } from "../examples/pi-web-extensions/notepad.js";

let root = "";
let tool: any;
let handlers: Map<string, (event: unknown, context: any) => unknown>;

function output(value: any) { return value.content.map((part: any) => part.text || "").join("\n"); }
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function install() {
  handlers = new Map();
  globalNotepad({
    registerTool(spec: any) { tool = spec; },
    on(event: string, handler: (event: unknown, context: any) => unknown) { handlers.set(event, handler); },
    getSessionName() { return "test session"; },
  } as any);
}
async function call(params: Record<string, unknown>) {
  return tool.execute("call", params, undefined, undefined, { sessionManager: { getSessionId: () => "session-test" } });
}
async function db() { return loadStore(); }
async function saveDb(value: unknown) { await saveStore(value as any); }
function record(store: any, id: string) { return store.notes.find((note: any) => note.id === id); }
function vaultFile(id: string, archived = false) { return join(process.env.PI_WEB_NOTEPAD_VAULT!, ...(archived ? [".archive"] : []), `${id}.md`); }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-notepad-db-"));
  process.env.PI_WEB_NOTEPAD_DIR = join(root, "markdown-backup");
  process.env.PI_WEB_NOTEPAD_DB = join(root, "notepad-db.json");
  process.env.PI_WEB_NOTEPAD_VAULT = join(root, "vault");
  delete process.env.PI_WEB_NOTEPAD_FORCE_JSON;
  install();
});
afterEach(async () => {
  delete process.env.PI_WEB_NOTEPAD_DIR;
  delete process.env.PI_WEB_NOTEPAD_DB;
  delete process.env.PI_WEB_NOTEPAD_VAULT;
  delete process.env.PI_WEB_NOTEPAD_FORCE_JSON;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("global notepad Markdown vault", () => {
  it("lazily imports a Markdown directory without modifying it, lifting task annotations, activity, pins, and archive state", async () => {
    const md = process.env.PI_WEB_NOTEPAD_DIR!;
    await mkdir(join(md, "oncall"), { recursive: true });
    await mkdir(join(md, ".archive", "old"), { recursive: true });
    const source = [
      "# Oncall — Week 34", "", "Rotation facts.", "", "## Handover",
      "- [ ] Check scanner availability due:2030-08-24 session:oncall waiting:OPS-17",
      "- [x] Confirm old page", "", "## Activity",
      "- 2025-08-20 10:15 UTC · agent(old session) · recorded handover", "",
    ].join("\n");
    await writeFile(join(md, "oncall", "w34.md"), source);
    await writeFile(join(md, ".archive", "old", "done.note.md"), "# Done\n\nHistorical information.\n");
    await writeFile(join(md, ".notepad-meta.json"), JSON.stringify({ pins: ["oncall/w34.md"] }));

    expect(output(await call({ action: "list" }))).toContain("📌 [oncall/w34](#panel:global-notepad:note=oncall%2Fw34) — 1/2 open");
    const store = await db();
    expect(store.version).toBe(3);
    const migrated = record(store, "oncall/w34");
    expect(migrated).toMatchObject({ title: "Oncall — Week 34", pinned: true, archived: false, revision: 1 });
    expect(migrated.body).toContain("Rotation facts.");
    expect(migrated.body).not.toContain("[ ]");
    expect(migrated.body).not.toContain("## Activity");
    expect(migrated.tasks[0]).toMatchObject({ text: "Check scanner availability", group: "Handover", due: "2030-08-24", session: "oncall", waiting: "OPS-17", done: false });
    expect(migrated.tasks[1]).toMatchObject({ text: "Confirm old page", group: "Handover", done: true });
    expect(migrated.tasks[1].completed).toMatch(/^\d{4}-/);
    expect(migrated.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ by: "agent", sessionName: "old session", text: "recorded handover" }),
      expect.objectContaining({ text: "migrated from markdown notepad" }),
    ]));
    expect(record(store, "old/done")).toMatchObject({ archived: true, pinned: false });
    expect(await readFile(join(md, "oncall", "w34.md"), "utf8")).toBe(source);
    expect((await stat(process.env.PI_WEB_NOTEPAD_VAULT!)).mode & 0o777).toBe(0o700);
    expect((await stat(join(process.env.PI_WEB_NOTEPAD_VAULT!, "oncall"))).mode & 0o777).toBe(0o700);
    expect((await stat(vaultFile("oncall/w34"))).mode & 0o777).toBe(0o600);

    await writeFile(join(md, "new.md"), "# Must not import\n");
    await call({ action: "list" });
    expect(record(await db(), "new")).toBeUndefined();
  });

  it("falls back to open legacy-v1 entries in one inbox and leaves the backup untouched", async () => {
    const legacy = { version: 1, entries: [
      { text: "Renew certificate", kind: "task", status: "open", due: "2030-09-01", pinned: true },
      { text: "Architecture decision", kind: "decision", status: "open" },
      { text: "Finished", kind: "task", status: "done" },
    ] };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(join(root, "notepad.json"), raw);

    expect(output(await call({ action: "list" }))).toContain("📌 [inbox](#panel:global-notepad:note=inbox) — 1/1 open");
    const inbox = record(await db(), "inbox");
    expect(inbox.body).toBe("- Architecture decision");
    expect(inbox.tasks).toEqual([expect.objectContaining({ text: "Renew certificate", due: "2030-09-01", done: false })]);
    expect(inbox.activity.at(-1).text).toBe("migrated from legacy notepad.json");
    expect(await readFile(join(root, "notepad.json"), "utf8")).toBe(raw);
  });

  it("round-trips every structured field through Obsidian-compatible note files", async () => {
    const stamp = "2026-08-25T12:34:56.789Z";
    const store = { version: 3 as const, notes: [{
      id: "plans/round-trip", title: "Round trip: all fields", body: "# Verbatim body\n\nTrailing space  \n\n",
      pinned: true, archived: false, revision: 9, created: stamp, updated: "2026-08-25T13:00:00.000Z",
      tasks: [
        { id: "t-source123", text: "Source \\[id:: is prose] with  two spaces", done: false, group: "Launch", due: "2026-08-25", session: "release", waiting: "reviewer", relations: [{ type: "blocks", to: "plans/round-trip#t-target456" }, { type: "relates", to: "plans/round-trip#t-target456" }, { type: "spawned", to: "plans/round-trip#t-target456" }], created: stamp, completed: null },
        { id: "t-target456", text: "Target", done: true, group: "Tasks", due: null, session: null, waiting: null, relations: [], created: stamp, completed: "2026-08-25T14:00:00.000Z" },
        { id: "t-ungrouped", text: "Ungrouped after groups", done: false, due: null, session: null, waiting: null, relations: [], created: stamp, completed: null },
      ],
      activity: [
        { at: stamp, by: "agent" as const, sessionId: "session-123", sessionName: "release room", taskId: "t-source123", text: "linked work [task-id:: is prose]" },
        { at: "2026-08-25T15:00:00.000Z", by: "user" as const, text: "confirmed" },
      ],
    }, {
      id: "history/done", title: "Archived", body: "Historical", pinned: false, archived: true, revision: 2,
      tasks: [], activity: [], created: stamp, updated: stamp,
    }] };

    await saveStore(store);
    const loaded = await loadStore();
    expect([...loaded.notes].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...store.notes].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await readFile(vaultFile("plans/round-trip"), "utf8")).toContain("[blocks:: plans/round-trip#t-target456] [relates:: plans/round-trip#t-target456] [spawned:: plans/round-trip#t-target456]");
    expect(await readFile(vaultFile("history/done", true), "utf8")).toContain('title: "Archived"');
  });

  it("migrates a realistic v3 JSON database once, backs it up, and continues in the vault", async () => {
    const realSource = "/home/ashwinpc/.pi/agent/notepad-db.json";
    const realBefore = await readFile(realSource, "utf8");
    await copyFile(realSource, process.env.PI_WEB_NOTEPAD_DB!);
    const seeded = JSON.parse(realBefore);

    await call({ action: "list" });
    expect(await loadStore()).toEqual(expect.objectContaining({ version: 3 }));
    const loaded = await loadStore();
    const noteDigests = (notes: any[]) => notes.map((note) => ({ id: note.id, digest: digest(note) })).sort((a, b) => a.id.localeCompare(b.id));
    expect(noteDigests(loaded.notes)).toEqual(noteDigests(seeded.notes));
    expect(await readFile(realSource, "utf8")).toBe(realBefore);
    await expect(stat(process.env.PI_WEB_NOTEPAD_DB!)).rejects.toMatchObject({ code: "ENOENT" });
    const backups = (await readdir(root)).filter((name) => /^notepad-db\.json\.migrated-\d{8}-\d{6}(?:-\d+)?$/.test(name));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, backups[0]), "utf8")).toBe(realBefore);

    const created = await call({ action: "create", title: "Vault migration smoke" });
    expect(created.details.note).toBe("vault-migration-smoke");
    expect(await readFile(vaultFile("vault-migration-smoke"), "utf8")).toContain("## Tasks");
    expect(await readdir(root)).toContain(backups[0]);
  });

  it("tolerates external edits, delays missing-id persistence until a write, and preserves unknown YAML", async () => {
    await mkdir(process.env.PI_WEB_NOTEPAD_VAULT!, { recursive: true });
    const source = [
      "---", 'title: "Hand edited"', "revision: 4", 'created: "2026-08-20T10:00:00.000Z"', 'updated: "2026-08-20T11:00:00.000Z"', "aliases:", "  - hand-note", "custom-key: keep me", "---",
      "External prose.", "", "## Tasks", "### Odd spacing", "   -   [ ]   Hand task   [due:: 2026-08-25]   [created:: 2026-08-20T10:30:00.000Z]", "not a valid task line", "", "## Activity", "- 2026-08-20T11:00:00.000Z · user(editor) · edited outside", "not a valid activity line", "",
    ].join("\n");
    const path = vaultFile("hand-edited");
    await writeFile(path, source);

    const firstRead = output(await call({ action: "read", note: "hand-edited" }));
    expect(firstRead).toContain("Hand task");
    expect(firstRead).toContain("not a valid task line");
    expect(await readFile(path, "utf8")).toBe(source);
    expect(record(await loadStore(), "hand-edited").tasks[0].id).toMatch(/^t-[a-f0-9]{12}$/);

    await call({ action: "log", note: "hand-edited", text: "agent saw external edit" });
    const rewritten = await readFile(path, "utf8");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const minted = rewritten.match(/\[id:: (t-[a-f0-9]{12})\]/)?.[1];
    expect(minted).toMatch(/^t-[a-f0-9]{12}$/);
    expect(rewritten).toContain("aliases:\n  - hand-note\ncustom-key: keep me");
    expect(rewritten).toContain("not a valid task line");
    expect(rewritten).toContain("not a valid activity line");
    const parsed = record(await loadStore(), "hand-edited");
    expect(parsed).toMatchObject({ revision: 5, body: expect.stringContaining("External prose."), tasks: [expect.objectContaining({ id: minted, group: "Odd spacing", due: "2026-08-25" })] });
    expect(parsed.body).toContain("not a valid task line");
    expect(parsed.body).toContain("not a valid activity line");
  });

  it("emits lint-clean frontmatter and Dataview task fields without tabs", async () => {
    await call({ action: "create", title: "Obsidian lint", text: "Body" });
    const id = (await call({ action: "add", note: "obsidian-lint", text: "Dataview task", group: "Release", due: "2026-08-25", waiting: "review", session: "launch" })).details.task;
    await call({ action: "check", note: "obsidian-lint", task: id });
    const markdown = await readFile(vaultFile("obsidian-lint"), "utf8");
    expect(markdown).toMatch(/^---\ntitle: "Obsidian lint"\nrevision: \d+\ncreated: "[^"]+"\nupdated: "[^"]+"\n---\n/);
    expect(markdown).not.toContain("\t");
    const taskLines = markdown.split("\n").filter((line) => /^- \[[ x]\]/.test(line));
    expect(taskLines).toHaveLength(1);
    expect(taskLines[0]).toMatch(/^- \[x\] Dataview task \[id:: t-[a-f0-9]{12}\] \[due:: 2026-08-25\] \[waiting:: review\] \[session:: launch\] \[created:: [^\]]+\] \[completed:: [^\]]+\]$/);
    expect(markdown).toMatch(/\n## Tasks\n### Release\n- \[x\]/);
    expect(markdown).toMatch(/\n## Activity\n- \d{4}-\d{2}-\d{2}T[^\n]+ · agent\(test session\) · /);
  });

  it("keeps the temporary forced-JSON backend operational", async () => {
    process.env.PI_WEB_NOTEPAD_FORCE_JSON = "1";
    await call({ action: "create", title: "JSON escape hatch" });
    const raw = JSON.parse(await readFile(process.env.PI_WEB_NOTEPAD_DB!, "utf8"));
    expect(record(raw, "json-escape-hatch")).toMatchObject({ title: "JSON escape hatch", revision: 1 });
    await expect(stat(process.env.PI_WEB_NOTEPAD_VAULT!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("guards body writes by revision, preserves job records, and nudges on inert body checkboxes", async () => {
    const created = await call({ action: "create", title: "Runbook", text: "Facts\n- [ ] inert body row" });
    expect(output(created)).toMatch(/checkboxes are inert information/i);
    await call({ action: "add", note: "runbook", text: "Real job" });
    await expect(call({ action: "write", note: "runbook", revision: 1, body: "stale" })).rejects.toThrow(/Stale revision 1; current revision is 2.*Re-read/i);

    const written = await call({ action: "write", note: "runbook", revision: 2, body: "New facts\n- [x] still inert" });
    expect(output(written)).toMatch(/revision 3.*checkboxes are inert/i);
    const note = record(await db(), "runbook");
    expect(note.body).toContain("still inert");
    expect(note.tasks).toHaveLength(1);
    expect(note.revision).toBe(3);
    await expect(call({ action: "write", note: "runbook", revision: 3 })).rejects.toThrow(/body is required/);
  });

  it("links cross-note jobs, derives blocking, rewrites inbound edges on move, unlinks, validates targets, and lazily prunes dangling edges", async () => {
    await call({ action: "create", title: "Source" });
    await call({ action: "create", title: "Target" });
    const blocker = (await call({ action: "add", note: "source", text: "Open blocker" })).details.task;
    const target = (await call({ action: "add", note: "target", text: "Deploy target" })).details.task;
    await expect(call({ action: "link", note: "source", task: blocker, type: "blocks", to: `missing#${target}` })).rejects.toThrow(/No note matches/);
    await call({ action: "link", note: "source", task: blocker, type: "blocks", to: `target#${target}` });

    expect(output(await call({ action: "tasks", status: "blocked" }))).toContain("Deploy target");
    expect(output(await call({ action: "read", note: "target" }))).toContain(`blocked by source#[${blocker}](#panel:global-notepad:note=source&task=${blocker})`);
    await call({ action: "check", note: "source", task: blocker });
    expect(output(await call({ action: "tasks", status: "blocked" }))).toBe("No tasks match those filters.");
    await call({ action: "uncheck", note: "source", task: blocker });
    await call({ action: "create", title: "Untouched" });
    const sourceInode = (await stat(vaultFile("source"))).ino;
    const untouchedInode = (await stat(vaultFile("untouched"))).ino;

    await call({ action: "move", note: "target", folder: "plans", title: "Release target" });
    await expect(stat(vaultFile("target"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(vaultFile("plans/release-target"))).isFile()).toBe(true);
    expect((await stat(vaultFile("source"))).ino).not.toBe(sourceInode);
    expect((await stat(vaultFile("untouched"))).ino).toBe(untouchedInode);
    let source = record(await db(), "source");
    expect(source.tasks[0].relations).toEqual([{ type: "blocks", to: `plans/release-target#${target}` }]);
    await call({ action: "unlink", note: "source", task: blocker, type: "blocks", to: `plans/release-target#${target}` });
    expect(record(await db(), "source").tasks[0].relations).toEqual([]);

    const store = await db();
    source = record(store, "source");
    source.tasks[0].relations.push({ type: "relates", to: "gone#t-dead" });
    await saveDb(store);
    expect(output(await call({ action: "read", note: "source" }))).toContain("(broken)");
    await call({ action: "log", note: "source", text: "Prune on owning-note write" });
    expect(record(await db(), "source").tasks[0].relations).toEqual([]);
  });

  it("addresses tasks by stable id or unique text substring and reports ambiguity candidates", async () => {
    await call({ action: "create", title: "Jobs" });
    const east = (await call({ action: "add", note: "jobs", text: "Scanner availability east" })).details.task;
    await call({ action: "add", note: "jobs", text: "Scanner availability west" });
    await expect(call({ action: "check", note: "jobs", task: "scanner availability" })).rejects.toThrow(/Ambiguous task[\s\S]*east[\s\S]*west/);
    await call({ action: "check", note: "jobs", task: east });
    expect(record(await db(), "jobs").tasks.find((task: any) => task.id === east).done).toBe(true);
    await expect(call({ action: "check", note: "jobs", task: "missing" })).rejects.toThrow(/Candidates: \(none\)/);
  });

  it("rolls up open, done, overdue, blocked, session, query, folder, and archived filters", async () => {
    await call({ action: "create", title: "Operations", folder: "team" });
    await call({ action: "add", note: "operations", text: "Old job", due: "2000-01-01", session: "alpha" });
    await call({ action: "add", note: "operations", text: "Waiting job", waiting: "TICKET-7", session: "alpha" });
    await call({ action: "add", note: "operations", text: "Future job", due: "2999-01-01", session: "beta" });
    const done = (await call({ action: "add", note: "operations", text: "Completed job", session: "beta" })).details.task;
    await call({ action: "check", note: "operations", task: done });

    expect(output(await call({ action: "tasks", folder: "team", status: "open" }))).not.toContain("Completed job");
    expect(output(await call({ action: "tasks", status: "overdue" }))).toContain("Old job");
    expect(output(await call({ action: "tasks", status: "blocked" }))).toContain("Waiting job");
    expect(output(await call({ action: "tasks", status: "done" }))).toContain("Completed job");
    expect(output(await call({ action: "tasks", session: "alpha" }))).not.toContain("Future job");
    expect(output(await call({ action: "tasks", query: "future" }))).toContain("Future job");
    await call({ action: "archive", note: "operations" });
    await expect(stat(vaultFile("team/operations"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(vaultFile("team/operations", true))).isFile()).toBe(true);
    expect(output(await call({ action: "list" }))).not.toContain("operations");
    expect(output(await call({ action: "list", folder: ".archive" }))).toContain("[team/operations](#panel:global-notepad:note=team%2Foperations) — 3/4 open");
    expect(output(await call({ action: "tasks", query: "future" }))).toBe("No tasks match those filters.");
  });

  it("auto-audits every mutating tool verb with provenance and taskId, and trims activity to 100", async () => {
    await call({ action: "create", title: "Audit" });
    await call({ action: "create", title: "Other" });
    const task = (await call({ action: "add", note: "audit", text: "Alpha" })).details.task;
    const other = (await call({ action: "add", note: "other", text: "Beta" })).details.task;
    await call({ action: "check", note: "audit", task });
    await call({ action: "uncheck", note: "audit", task });
    await call({ action: "update", note: "audit", task, text: "Alpha updated" });
    let revision = record(await db(), "audit").revision;
    await call({ action: "write", note: "audit", revision, body: "Information" });
    await call({ action: "link", note: "audit", task, type: "relates", to: `other#${other}` });
    await call({ action: "unlink", note: "audit", task, type: "relates", to: `other#${other}` });
    await call({ action: "log", note: "audit", task, text: "Communication" });
    await call({ action: "pin", note: "audit" });
    await call({ action: "unpin", note: "audit" });
    await call({ action: "move", note: "audit", folder: "plans", title: "Audit moved" });
    await call({ action: "archive", note: "audit-moved" });

    let note = record(await db(), "plans/audit-moved");
    expect(note.activity.map((entry: any) => entry.text).join("\n")).toMatch(/created note[\s\S]*added task[\s\S]*checked[\s\S]*unchecked[\s\S]*updated task[\s\S]*replaced note body[\s\S]*linked[\s\S]*unlinked[\s\S]*Communication[\s\S]*pinned[\s\S]*unpinned[\s\S]*moved note[\s\S]*archived note/);
    expect(note.activity.filter((entry: any) => /task|checked|linked|Communication/.test(entry.text)).every((entry: any) => entry.taskId === task)).toBe(true);
    expect(note.activity.every((entry: any) => entry.by === "agent" && entry.sessionId === "session-test" && entry.sessionName === "test session")).toBe(true);

    // log is permitted on archived notes and remains freeform communication.
    for (let index = 0; index < 101; index++) await call({ action: "log", note: "audit-moved", text: `tail ${index}` });
    note = record(await db(), "plans/audit-moved");
    expect(note.activity).toHaveLength(100);
    expect(note.activity.at(-1).text).toBe("tail 100");
  });

  it("enforces active-note, body, task/log text, and relation caps", async () => {
    await expect(call({ action: "create", title: "Large", text: "x".repeat(64 * 1024 + 1) })).rejects.toThrow(/64KB/);
    await call({ action: "create", title: "Caps" });
    await call({ action: "create", title: "Cap target" });
    await expect(call({ action: "add", note: "caps", text: "x".repeat(501) })).rejects.toThrow(/500/);
    await expect(call({ action: "log", note: "caps", text: "x".repeat(501) })).rejects.toThrow(/500/);
    const sourceTask = (await call({ action: "add", note: "caps", text: "Source" })).details.task;
    const targetTask = (await call({ action: "add", note: "cap-target", text: "Target" })).details.task;

    let store = await db();
    record(store, "caps").tasks[0].relations = Array.from({ length: 50 }, () => ({ type: "relates", to: `cap-target#${targetTask}` }));
    await saveDb(store);
    await expect(call({ action: "link", note: "caps", task: sourceTask, type: "blocks", to: `cap-target#${targetTask}` })).rejects.toThrow(/50 relations/);

    store = await db();
    const template = record(store, "caps").tasks[0];
    record(store, "caps").tasks = Array.from({ length: 1_000 }, (_, index) => ({ ...template, id: `t-cap-${index}`, relations: [] }));
    await saveDb(store);
    await expect(call({ action: "add", note: "caps", text: "One too many" })).rejects.toThrow(/1000 tasks/);

    store = await db();
    const stamp = new Date().toISOString();
    for (let index = 2; index < 200; index++) store.notes.push({ id: `n-${index}`, title: `N ${index}`, body: "", pinned: false, archived: false, revision: 1, tasks: [], activity: [], created: stamp, updated: stamp });
    await saveDb(store);
    await expect(call({ action: "create", title: "Too many" })).rejects.toThrow(/200 active notes/);
  });

  it("emits readable panel deep links from list, task roll-ups, and reads", async () => {
    await call({ action: "create", title: "Week 34", folder: "oncall", text: "## Handover\nFacts" });
    const noteId = "oncall/week-34";
    const id = (await call({ action: "add", note: noteId, text: "Check scanner" })).details.task;
    const noteLink = `[${noteId}](#panel:global-notepad:note=oncall%2Fweek-34)`;
    const taskLink = `[${id}](#panel:global-notepad:note=oncall%2Fweek-34&task=${id})`;
    expect(output(await call({ action: "list" }))).toContain(noteLink);
    const tasks = output(await call({ action: "tasks" }));
    expect(tasks).toContain(noteLink);
    expect(tasks).toContain(taskLink);
    expect(tasks).not.toContain(`[Check scanner](`);
    const read = output(await call({ action: "read", note: noteId }));
    expect(read).toContain(`ID: ${noteLink}`);
    expect(read).toContain(taskLink);
  });

  it("renders the virtual tree, resolves deep links with closest-anchor fallbacks, and exposes settings and FAB", async () => {
    await call({ action: "create", title: "Panel", folder: "team", text: "## Handover\nFacts\n\n- [ ] informational only" });
    await call({ action: "create", title: "Target" });
    await call({ action: "create", title: "Pinned runbook", folder: "ops" });
    await call({ action: "pin", note: "pinned-runbook" });
    const source = (await call({ action: "add", note: "panel", text: "Live job", group: "Launch", due: "2030-01-01" })).details.task;
    await call({ action: "add", note: "panel", text: "Second launch job", group: "Launch" });
    await call({ action: "add", note: "panel", text: "Ungrouped job" });
    await call({ action: "add", note: "panel", text: "Migrated Tasks job", group: "Tasks" });
    const longDoneText = `Completed verbose task ${"detail ".repeat(65)}`.trim();
    const longDone = (await call({ action: "add", note: "panel", text: longDoneText, group: "Completed" })).details.task;
    await call({ action: "check", note: "panel", task: longDone });
    const target = (await call({ action: "add", note: "target", text: "Destination", session: "test session" })).details.task;
    await call({ action: "pin", note: "target" });
    await call({ action: "link", note: "panel", task: source, type: "relates", to: `target#${target}` });
    const longTitle = `A deliberately long panel title ${"x".repeat(120)}`;
    const longNote = (await call({ action: "create", title: longTitle })).details.note;
    const longRelationText = "Review mobile relation rendering with a deliberately verbose destination task label";
    const longTitleTask = (await call({ action: "add", note: longNote, text: longRelationText })).details.task;
    await call({ action: "link", note: "team/panel", task: source, type: "relates", to: `${longNote}#${longTitleTask}` });
    const seeded = await db();
    record(seeded, "team/panel").activity.push({ at: new Date().toISOString(), by: "agent", sessionId: "panel-session", sessionName: "current panel", text: "viewed from current session" });
    await saveDb(seeded);
    const liveContexts: Array<{ context: any; contributions: Map<string, any> }> = [];
    const freshPanel = async () => {
      const contributions = new Map<string, any>();
      // The live bridge may provide a fresh context/web proxy while the logical
      // session id remains stable. Never rely on object identity for view state.
      const context = { sessionManager: { getSessionId: () => "panel-session" }, ui: { notify() {}, web: {
        capabilities: { apiVersion: 1, slots: ["panel", "fab"], kinds: ["rendered", "static"] },
        contribute: (key: string, value: any) => contributions.set(key, value), update() {}, registerSettings: async () => undefined,
      } } };
      await handlers.get("session_start")?.({}, context);
      liveContexts.push({ context, contributions });
      return contributions.get("global-notepad");
    };
    const panel = await freshPanel();
    const bareRender = async () => {
      const freshContextPanel = await freshPanel();
      // server/extensions/webUi.ts invokes panels with this truthy envelope
      // even when the browser omitted its event entirely.
      return freshContextPanel.render({ action: undefined, payload: undefined, fields: undefined });
    };
    expect(liveContexts[0].contributions.get("global-notepad-launcher")).toMatchObject({ slot: "fab", opens: "global-notepad" });
    const tree = await bareRender();
    const sessionStart = tree.html.indexOf("<span>This session</span>");
    const pinnedStart = tree.html.indexOf("<span>Pinned</span>");
    const notesStart = tree.html.indexOf("<span>Notes</span>");
    expect(sessionStart).toBeGreaterThan(0);
    expect(sessionStart).toBeLessThan(pinnedStart);
    expect(pinnedStart).toBeLessThan(notesStart);
    const sessionSection = tree.html.slice(sessionStart, pinnedStart);
    expect(sessionSection).toContain("<strong>Panel</strong>");
    expect(sessionSection).toContain("<strong>Target</strong>");
    expect(sessionSection).toContain('class="gnpRow gnpRow-session"');
    expect(sessionSection).toContain('class="gnpRow gnpRow-session gnpRow-isPinned"');
    expect(sessionSection).toContain('aria-label="Pinned note. Open Target at the tree root; 1 open task"');
    const pinnedSection = tree.html.slice(pinnedStart, notesStart);
    expect(pinnedSection).toContain('<strong>Pinned runbook</strong><span class="gnpRowPath" title="ops">ops/</span>');
    expect(pinnedSection).toContain('class="gnpRow gnpRow-pinned gnpRow-isPinned"');
    expect(pinnedSection).not.toContain("<strong>Target</strong>");
    expect(tree.html).toContain('class="gnpFolder" role="listitem" aria-label="Folder team, 4 open tasks" style="--gnp-indent:0px"');
    expect(tree.html).toContain('class="gnpRow gnpRow-note" role="listitem" style="--gnp-indent:14px"><button class="gnpOpen" type="button" aria-label="Open Panel in team; 4 open tasks"');
    expect(tree.html.slice(notesStart)).toContain("<strong>Target</strong>");
    expect(tree.html.slice(notesStart)).toContain("<strong>Pinned runbook</strong>");
    expect(tree.html).toContain(".gnpOpen{display:flex;align-items:center;gap:5px;width:100%;min-width:0;height:28px;min-height:28px");
    expect(tree.html).toContain(".gnpToolbar .webPanelButton{height:32px;min-height:32px");
    expect(tree.html).toContain(".gnpFilter input{min-width:0;width:100%;height:32px;min-height:32px");
    expect(tree.html).toContain(".gnpCreate>summary{display:grid;width:32px;height:32px;min-height:32px");
    expect(tree.html).toContain(".gnpRow{min-width:0;border:0");
    expect(tree.html).not.toContain("gnpProgress");
    expect(tree.html).not.toContain(" · 1 done");
    expect(tree.html).not.toContain("📌");
    expect(tree.html).not.toContain("＋");
    expect(tree.html).toContain('<div class="gnpToolbar"><form class="gnpFilter" data-web-panel-action="filter-tree"');
    expect(tree.html).toContain('<input name="query" value=""');
    expect(tree.html).not.toContain('type="submit">Filter</button>');
    expect(tree.html).toContain('data-web-panel-action="show-archive" aria-pressed="false"');
    expect(tree.html).toContain('<summary aria-label="New note" title="New note">');
    expect(tree.html).toContain('data-web-panel-action="create-note"');

    const noMatches = await panel.render({ action: "filter-tree", payload: { archived: false }, fields: { query: "nothing-matches-this" } });
    expect(noMatches.html).not.toContain("<span>This session</span>");
    expect(noMatches.html).toContain("No matching notes.");
    await panel.render({ action: "view" });

    const archiveTree = await panel.render({ action: "show-archive" });
    expect(archiveTree.html).toContain('data-web-panel-action="view" aria-pressed="true" aria-current="page"');
    expect(archiveTree.html).not.toContain("<span>This session</span>");
    const longOpened = await panel.render({ action: "open-note", payload: { note: longNote } });
    expect(longOpened.title.length).toBeLessThanOrEqual(96);
    expect(longOpened.title).toMatch(/…$/);
    expect(longOpened.html).toContain('<div class="gnpBreadcrumb" title="Location: Root">Root /</div>');
    const longEdit = await panel.render({ action: "edit-task", payload: { note: longNote, task: longTitleTask } });
    expect(longEdit.title).toMatch(/… — edit task$/);
    expect(longEdit.title.length).toBeLessThan(longTitle.length);
    await panel.render({ action: "view" });

    const createdView = await panel.render({ action: "create-note", fields: { title: "Browser draft", folder: "scratch" } });
    expect(createdView.title).toBe("Browser draft");
    expect(record(await db(), "scratch/browser-draft")).toMatchObject({ body: "", archived: false });
    expect(record(await db(), "scratch/browser-draft").activity.at(-1)).toMatchObject({ by: "user", text: 'created note "Browser draft"' });
    const createdAfterInvalidation = await bareRender();
    expect(createdAfterInvalidation.title).toBe("Browser draft");
    expect(createdAfterInvalidation.html).toContain("Note created.");

    await panel.render({ action: "back-tree" });
    const filtered = await panel.render({ action: "filter-tree", payload: { archived: false }, fields: { query: "Live" } });
    expect(filtered.html).toContain('value="Live"');
    expect(filtered.html).toContain("1 note");
    const opened = await panel.render({ action: "open-note", payload: { note: "team/panel" } });
    expect(opened.html).toContain('type="checkbox"  disabled');
    expect(opened.html).toContain('data-web-panel-action="toggle-task"');
    expect(opened.html).toContain('data-web-panel-action="jump-task"');
    expect(opened.html).toContain('data-web-panel-action="quick-add"');
    expect(opened.html).toContain('data-web-panel-action="edit-task"');
    expect(opened.html).toContain('<button class="webPanelButton gnpBackButton" type="button" data-web-panel-action="back-tree">Back to notes</button>');
    expect(opened.html).toContain('<div class="gnpBreadcrumb" title="Location: team">team /</div>');
    expect(opened.html).toContain('class="gnpInlineIcon"');
    expect(opened.html).not.toContain(">✎</button>");
    expect(opened.html.match(/<h4 class="gnpTaskGroup">Launch<\/h4>/g)).toHaveLength(1);
    expect(opened.html).not.toContain(">Tasks</h4>");
    expect(opened.html).toContain("Activity");
    expect(opened.html).toContain(".gnpDoc h1{font-size:18px}");
    expect(opened.html).not.toContain(".gnp h3{");
    expect(opened.html).toContain("-webkit-line-clamp:2");
    expect(opened.html).toContain(".gnpRelation{display:block;height:auto;min-height:40px;max-width:100%;overflow:hidden");
    expect(opened.html).toContain(".gnpRelationLabel{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden");
    expect(opened.html).toContain(".gnpCheckTarget,.gnpIconButton{width:44px;height:44px}");
    expect(opened.html).toContain(".gnpBar input,.gnpEditGrid input,.gnpCreateForm input{min-height:44px}");
    expect(opened.html).toContain(".gnpCreate>summary{width:44px;height:44px;min-height:44px}");
    expect(opened.html).toContain(".gnpOpen{height:44px;min-height:44px}");
    expect(opened.html).toContain(".gnpToolbar .webPanelButton{height:44px;min-height:44px}");
    expect(opened.html).toContain(".gnpRelation{flex:1 1 100%;min-height:44px}");
    expect(opened.html).toContain(".gnp .webPanelButton,.gnp .gnpTextButton{min-height:44px");
    expect(opened.html).toContain(`class="gnpTaskText" title="${longDoneText}"`);
    expect(opened.html).toContain('<span class="gnpRelationLabel">relates: Review mobile relation rendering with a d…</span>');
    expect(opened.html).not.toContain(`<span class="gnpRelationLabel">relates: ${longTitle}`);
    expect(opened.html).toContain(`title="${longTitle} — ${longRelationText} (${longNote}#${longTitleTask})"`);
    expect(opened.html.match(/gnpActivityActor" title="test session">agent \(test session\)<\/span>/g)).toHaveLength(1);
    expect(opened.html).toContain('class="gnpActivitySummary">added 5 tasks</span>');
    expect(opened.html).toContain('class="gnpActivitySummary">linked 2 task relations</span>');
    expect(opened.html).toMatch(/gnpActivityGroup" title="[^"]*added task &quot;Completed verbose task[\s\S]*added task &quot;Live job&quot;[^"]*"/);
    expect(opened.html).toContain(" · checked · <span class=\"gnpActivityTask\"");
    expect(opened.html).not.toContain("added task “Live job”");
    expect(record(await db(), "team/panel").activity.filter((entry: any) => entry.text.startsWith("added task"))).toHaveLength(5);

    const jumped = await panel.render({ action: "jump-task", payload: { to: `target#${target}` } });
    expect(jumped.html).toContain(`id="task-${target}" data-web-panel-highlight`);
    expect((await bareRender()).html).not.toContain("data-web-panel-highlight");
    await panel.render({ action: "open-note", payload: { note: "team/panel" } });

    const edit = await panel.render({ action: "edit-task", payload: { note: "team/panel", task: source } });
    expect(edit.html).toContain('data-web-panel-action="save-task-edit"');
    expect((await bareRender()).html).toContain('data-web-panel-action="save-task-edit"');
    const saved = await panel.render({ action: "save-task-edit", payload: { note: "team/panel", task: source }, fields: { text: "Edited live job", group: "Delivery", due: "2031-02-03", session: "beta", waiting: "review" } });
    expect(saved.title).toBe("Panel");
    expect(saved.html).toContain("Task saved.");
    expect(saved.html).toContain(`id="task-${source}" data-web-panel-highlight`);
    const savedAfterInvalidation = await bareRender();
    expect(savedAfterInvalidation.title).toBe("Panel");
    expect(savedAfterInvalidation.html).toContain("Task saved.");
    expect(savedAfterInvalidation.html).not.toContain("data-web-panel-highlight");
    const edited = record(await db(), "team/panel").tasks.find((task: any) => task.id === source);
    expect(edited).toMatchObject({ text: "Edited live job", group: "Delivery", due: "2031-02-03", session: "beta", waiting: "review" });
    expect(record(await db(), "team/panel").activity.at(-1)).toMatchObject({ by: "user", taskId: source, text: 'updated task "Edited live job"' });

    const toggled = await panel.render({ action: "toggle-task", payload: { note: "team/panel", task: source } });
    expect(toggled.title).toBe("Panel");
    expect(toggled.html).toContain("Task completed.");
    expect(toggled.html).toContain(`id="task-${source}" data-web-panel-highlight`);
    expect(toggled.html).toMatch(new RegExp(`id="task-${source}"[\\s\\S]{0,240}<input type="checkbox" checked`));
    const toggledAfterInvalidation = await bareRender();
    expect(toggledAfterInvalidation.title).toBe("Panel");
    expect(toggledAfterInvalidation.html).toContain("Task completed.");
    expect(toggledAfterInvalidation.html).not.toContain("data-web-panel-highlight");
    expect(toggledAfterInvalidation.html).toMatch(new RegExp(`id="task-${source}"[\\s\\S]{0,240}<input type="checkbox" checked`));

    const added = await panel.render({ action: "quick-add", payload: { note: "team/panel" }, fields: { text: "Panel-added task" } });
    expect(added.title).toBe("Panel");
    expect(added.html).toContain("Task added.");
    expect(added.html).toMatch(/data-web-panel-highlight[\s\S]*Panel-added task/);
    const addedAfterInvalidation = await bareRender();
    expect(addedAfterInvalidation.html).toContain("Task added.");
    expect(addedAfterInvalidation.html).not.toContain("data-web-panel-highlight");

    const filteredBack = await panel.render({ action: "back-tree" });
    expect(filteredBack.html).toContain('value="Live"');
    expect(filteredBack.html).toContain("1 note");
    expect((await bareRender()).html).toContain('value="Live"');

    await panel.render({ action: "view" });
    await panel.render({ action: "open-note", payload: { note: "scratch/browser-draft" } });
    const archived = await panel.render({ action: "archive-note", payload: { note: "scratch/browser-draft" } });
    expect(archived.title).toBe("Global notepad");
    expect(archived.html).toContain("Archived Browser draft.");
    expect(archived.html).toContain('data-web-panel-action="unarchive-note"');
    const archivedAfterInvalidation = await bareRender();
    expect(archivedAfterInvalidation.html).toContain("Archived Browser draft.");
    expect(archivedAfterInvalidation.html).toContain('data-web-panel-action="unarchive-note"');
    const unarchived = await panel.render({ action: "unarchive-note", payload: { note: "scratch/browser-draft" } });
    expect(unarchived.title).toBe("Browser draft");
    expect(unarchived.html).toContain("Archive undone.");
    expect((await bareRender()).title).toBe("Browser draft");
    expect(record(await db(), "scratch/browser-draft")).toMatchObject({ archived: false });
    expect(record(await db(), "scratch/browser-draft").activity.at(-1)).toMatchObject({ by: "user", text: 'unarchived note "Browser draft"' });

    const taskDeepLink = await panel.render({ action: "deep-link", payload: { note: "team/panel", task: source, h: "handover" } });
    expect(taskDeepLink.html).toContain(`id="task-${source}" data-web-panel-highlight`);
    const deepLinkAfterInvalidation = await bareRender();
    expect(deepLinkAfterInvalidation.title).toBe("Panel");
    expect(deepLinkAfterInvalidation.html).not.toContain("data-web-panel-highlight");
    const headingFallback = await panel.render({ action: "deep-link", payload: { note: "team/panel", task: "t-gone", h: "handover" } });
    expect(headingFallback.html).toContain("<h2 data-web-panel-highlight>Handover</h2>");
    const topFallback = await panel.render({ action: "deep-link", payload: { note: "team/panel", task: "t-gone", h: "gone" } });
    expect(topFallback.html).toContain('<article class="gnpDoc" data-web-panel-highlight>');
    const unknown = await panel.render({ action: "deep-link", payload: { note: "gone" } });
    expect(unknown.title).toBe("Global notepad");
    expect(unknown.html).toContain("Deep link target not found: gone.");

    for (const live of liveContexts) await handlers.get("session_shutdown")?.({}, live.context);
    expect(liveContexts[0].contributions.get("global-notepad")).toBeUndefined();
  });
});
