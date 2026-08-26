/*
 * global-notepad — an opinionated, machine-global Markdown vault for pi-web.
 *
 * Markdown is information only. Tasks and activity are structured records so
 * agents can safely query, relate, and mutate work across conversations.
 */

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { PiWebExtensionAPI, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

const PANEL_KEY = "global-notepad";
const SETTINGS_ID = "global-notepad.settings";
const ARCHIVE = ".archive";
const MAX_ACTIVE_NOTES = 200;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASK_TEXT = 500;
const MAX_TASKS = 1_000;
const MAX_ACTIVITY = 100;
const MAX_RELATIONS = 50;
const MAX_PROMPT_LINES = 10;

type Actor = { by: "user" | "agent"; sessionId?: string; sessionName?: string };
type RelationType = "blocks" | "relates" | "spawned";
type Relation = { type: RelationType; to: string };
type TaskRecord = {
  id: string;
  text: string;
  done: boolean;
  group?: string;
  due: string | null;
  session: string | null;
  waiting: string | null;
  relations: Relation[];
  created: string;
  completed: string | null;
};
type ActivityRecord = Actor & { at: string; taskId?: string; text: string };
type NoteRecord = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  archived: boolean;
  revision: number;
  tasks: TaskRecord[];
  activity: ActivityRecord[];
  created: string;
  updated: string;
};
type Store = { version: 3; notes: NoteRecord[] };
type LegacyEntry = { text: string; kind?: string; status?: string; pinned?: boolean; due?: string; tags?: string[] };
type NoteFileMeta = { sourcePath: string; sourceContent: string; unknownFrontmatter: string[]; snapshot: string };

const noteFileMeta = new WeakMap<NoteRecord, NoteFileMeta>();
const MANAGED_MARKER = "<!-- pi-web-notepad: managed sections -->";
const KNOWN_FRONTMATTER = new Set(["title", "pinned", "revision", "created", "updated"]);

function mdDir() { return process.env.PI_WEB_NOTEPAD_DIR || join(homedir(), ".pi", "agent", "notepad"); }
function dbPath() { return process.env.PI_WEB_NOTEPAD_DB || join(homedir(), ".pi", "agent", "notepad-db.json"); }
function vaultRoot() { return process.env.PI_WEB_NOTEPAD_VAULT || join(homedir(), ".pi", "agent", "notepad-vault"); }
// TODO(remove): rollout-only escape hatch; Markdown vault storage is the permanent backend.
function forceJsonStorage() { return process.env.PI_WEB_NOTEPAD_FORCE_JSON === "1"; }
function legacyPath() { return join(dirname(mdDir()), "notepad.json"); }
function now() { return new Date().toISOString(); }
function today() { return now().slice(0, 10); }
function taskId() { return `t-${randomBytes(6).toString("hex")}`; }
function describeError(error: unknown) { return error instanceof Error ? error.message : String(error); }

let noteQueue: Promise<unknown> = Promise.resolve();
function withNoteQueue<T>(work: () => Promise<T>): Promise<T> {
  const next = noteQueue.then(work, work);
  noteQueue = next.catch(() => undefined);
  return next;
}

const storeInvalidators = new Set<() => void>();
const invalidatorByWebUi = new WeakMap<object, () => void>();
const MAX_PANEL_VIEW_STATES = 128;
const panelStateBySession = new Map<string, PanelViewState>();
function rememberPanelState(sessionId: string, state: PanelViewState) {
  panelStateBySession.delete(sessionId);
  panelStateBySession.set(sessionId, state);
  while (panelStateBySession.size > MAX_PANEL_VIEW_STATES) panelStateBySession.delete(panelStateBySession.keys().next().value!);
}
function invalidatePanels() { for (const invalidate of storeInvalidators) invalidate(); }

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

async function atomicWrite(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function cleanId(value: unknown, label: string, root = false) {
  const input = String(value ?? "").trim().replace(/(?:\.note)?\.md$/i, "");
  if (!input && root) return "";
  if (!input) throw new Error(`${label} is required`);
  if (input.includes("\0") || input.includes("\\") || isAbsolute(input)) throw new Error(`${label} must be a relative logical path`);
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must not contain empty, ".", or ".." path segments`);
  if (parts.some((part) => part.startsWith("."))) throw new Error(`${label} cannot contain hidden path segments`);
  if (input.length > 500 || parts.some((part) => part.length > 100)) throw new Error(`${label} is too long`);
  return parts.join("/");
}

function slugify(title: string) {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note";
}

function shortText(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > MAX_TASK_TEXT) throw new Error(`${label} is limited to ${MAX_TASK_TEXT} characters`);
  if (/[\r\n]/.test(text)) throw new Error(`${label} must be a single line`);
  return text;
}

function optionalText(value: unknown, label: string, max = 200): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max || /[\r\n]/.test(text)) throw new Error(`${label} must be a single line of at most ${max} characters`);
  return text;
}

function dueValue(value: unknown): string | null | undefined {
  const due = optionalText(value, "due", 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must be formatted as "YYYY-MM-DD"');
  return due;
}

function groupValue(value: unknown): string | undefined {
  const group = optionalText(value, "group", 100);
  return group || undefined;
}

function assertBody(body: string) {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) throw new Error(`Body would be ${bytes.toLocaleString()} bytes; note bodies are limited to 64KB`);
}
function hasChecklist(body: string) { return /^\s*[-*+]\s+\[[ xX]\]\s+/m.test(body); }
function checklistNudge(body: string) {
  return hasChecklist(body) ? " Body checkboxes are inert information, not job records; use action \"add\" to create tasks." : "";
}

function appendActivity(note: NoteRecord, actor: Actor, text: string, id?: string) {
  const entry: ActivityRecord = { at: now(), by: actor.by, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}), ...(actor.sessionName ? { sessionName: actor.sessionName } : {}), ...(id ? { taskId: id } : {}), text: shortText(text, "activity text") };
  note.activity.push(entry);
  if (note.activity.length > MAX_ACTIVITY) note.activity.splice(0, note.activity.length - MAX_ACTIVITY);
}

function bump(note: NoteRecord) { note.revision += 1; note.updated = now(); }
function reference(noteId: string, id: string) { return `${noteId}#${id}`; }
function splitReference(value: string) {
  const index = value.lastIndexOf("#");
  return index > 0 ? { noteId: value.slice(0, index), taskId: value.slice(index + 1) } : undefined;
}
function findReference(store: Store, value: string) {
  const split = splitReference(value);
  if (!split) return undefined;
  const note = store.notes.find((candidate) => candidate.id === split.noteId);
  const task = note?.tasks.find((candidate) => candidate.id === split.taskId);
  return note && task ? { note, task } : undefined;
}
function pruneDangling(store: Store, note: NoteRecord) {
  for (const task of note.tasks) task.relations = task.relations.filter((relation) => Boolean(findReference(store, relation.to)));
}

export async function saveStore(store: Store) {
  if (forceJsonStorage()) await atomicWrite(dbPath(), `${JSON.stringify(store, null, 2)}\n`);
  else await saveVaultStore(store);
  invalidatePanels();
}

function emptyTask(text: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  const created = now();
  return { id: taskId(), text, done: false, due: null, session: null, waiting: null, relations: [], created, completed: null, ...fields };
}

function pathId(relative: string) {
  return relative.replace(/\\/g, "/").replace(/^\.archive\//, "").replace(/(?:\.note)?\.md$/i, "");
}
function markdownTitle(content: string, id: string) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(id).replace(/-/g, " ");
}
function parseAnnotations(raw: string) {
  const fields: { due: string | null; session: string | null; waiting: string | null } = { due: null, session: null, waiting: null };
  const text = raw.replace(/(?:^|\s)(due|session|waiting):([^\s]+)/gi, (_all, key: "due" | "session" | "waiting", value: string) => {
    fields[key.toLowerCase() as keyof typeof fields] = value;
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { text, ...fields };
}
function parseActivityLine(line: string): ActivityRecord | undefined {
  const clean = line.replace(/^\s*[-*+]\s*/, "").trim();
  if (!clean) return undefined;
  const match = clean.match(/^(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z| UTC)?)?)\s*·\s*(user|agent)(?:\(([^)]*)\))?\s*·\s*(.*)$/i);
  if (!match) return undefined;
  const parsed = new Date(match[1].length === 10 ? `${match[1]}T00:00:00Z` : match[1].replace(" UTC", "Z"));
  if (Number.isNaN(parsed.valueOf())) return undefined;
  const fields = extractInlineFields(match[4], new Set(["session-id", "session-name", "task-id"]));
  const sessionId = fields.values.get("session-id")?.[0];
  const sessionName = fields.values.get("session-name")?.[0] || (!sessionId ? match[3] : undefined);
  return {
    at: parsed.toISOString(), by: match[2].toLowerCase() as "user" | "agent",
    ...(sessionId ? { sessionId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(fields.values.get("task-id")?.[0] ? { taskId: fields.values.get("task-id")![0] } : {}),
    text: fields.text.trim(),
  };
}

function importMarkdown(content: string, id: string, pinned: boolean, archived: boolean): NoteRecord {
  const stamp = now();
  const title = markdownTitle(content, id);
  let lines = content.replace(/\r\n/g, "\n").split("\n");
  const activityIndex = lines.map((line) => /^##\s+Activity\s*$/i.test(line)).lastIndexOf(true);
  let activity: ActivityRecord[] = [];
  if (activityIndex >= 0) {
    activity = lines.slice(activityIndex + 1).map(parseActivityLine).filter((entry): entry is ActivityRecord => Boolean(entry));
    lines = lines.slice(0, activityIndex);
  }
  const tasks: TaskRecord[] = [];
  let group: string | undefined;
  const bodyLines: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) group = heading[1].trim();
    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (checkbox) {
      const parsed = parseAnnotations(checkbox[2]);
      const done = checkbox[1].toLowerCase() === "x";
      tasks.push(emptyTask(parsed.text, { done, ...(group ? { group } : {}), due: parsed.due, session: parsed.session, waiting: parsed.waiting, created: stamp, completed: done ? stamp : null }));
    } else bodyLines.push(line);
  }
  const firstTitle = bodyLines.findIndex((line) => /^#\s+/.test(line));
  if (firstTitle >= 0) bodyLines.splice(firstTitle, 1);
  // A task-only Markdown section has no informational body left after lifting.
  // Remove its now-orphaned heading while retaining headings that own prose.
  const informationalLines = bodyLines.filter((line, index, all) => {
    const heading = line.match(/^(#{1,6})\s+/);
    if (!heading) return true;
    const level = heading[1].length;
    for (let next = index + 1; next < all.length; next++) {
      const nextHeading = all[next].match(/^(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= level) break;
      if (all[next].trim()) return true;
    }
    return false;
  });
  const body = informationalLines.join("\n").trim();
  assertBody(body);
  const note: NoteRecord = { id, title, body, pinned: pinned && !archived, archived, revision: 1, tasks: tasks.slice(0, MAX_TASKS), activity: activity.slice(-MAX_ACTIVITY + 1), created: stamp, updated: stamp };
  appendActivity(note, { by: "user" }, "migrated from markdown notepad");
  return note;
}

async function walkMarkdown(folder = ""): Promise<Array<{ relative: string; content: string }>> {
  const output: Array<{ relative: string; content: string }> = [];
  let entries;
  try { entries = await readdir(join(mdDir(), folder), { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return output; throw error; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === ".notepad-meta.json") continue;
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await walkMarkdown(relative));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) output.push({ relative, content: await readFile(join(mdDir(), relative), "utf8") });
  }
  return output;
}

async function markdownPins() {
  try {
    const raw = JSON.parse(await readFile(join(mdDir(), ".notepad-meta.json"), "utf8"));
    return new Set(Array.isArray(raw?.pins) ? raw.pins.filter((pin: unknown): pin is string => typeof pin === "string").map(pathId) : []);
  } catch (error: any) { if (error?.code === "ENOENT" || error instanceof SyntaxError) return new Set<string>(); throw error; }
}

function uniqueImportedId(notes: NoteRecord[], wanted: string, archived: boolean) {
  if (!notes.some((note) => note.id === wanted)) return wanted;
  const suffix = archived ? "-archived" : "-imported";
  let candidate = `${wanted}${suffix}`;
  let index = 2;
  while (notes.some((note) => note.id === candidate)) candidate = `${wanted}${suffix}-${index++}`;
  return candidate;
}

async function migrateMarkdown(): Promise<Store> {
  const files = await walkMarkdown();
  const pins = await markdownPins();
  const notes: NoteRecord[] = [];
  for (const file of files) {
    const archived = file.relative.startsWith(`${ARCHIVE}/`);
    const wanted = pathId(file.relative);
    const id = uniqueImportedId(notes, wanted, archived);
    notes.push(importMarkdown(file.content, id, pins.has(wanted), archived));
  }
  return { version: 3, notes };
}

async function migrateLegacy(raw: unknown): Promise<Store> {
  const entries: LegacyEntry[] = Array.isArray((raw as any)?.entries)
    ? (raw as any).entries.filter((entry: any) => entry && typeof entry.text === "string" && (entry.status || "open") === "open") : [];
  if (!entries.length) return { version: 3, notes: [] };
  const stamp = now();
  const tasks = entries.filter((entry) => entry.kind === "task").slice(0, MAX_TASKS).map((entry) => emptyTask(shortText(entry.text, "legacy task"), { due: entry.due && /^\d{4}-\d{2}-\d{2}$/.test(entry.due) ? entry.due : null, created: stamp }));
  const bullets = entries.filter((entry) => entry.kind !== "task").map((entry) => `- ${entry.text.trim()}`);
  const body = bullets.join("\n");
  assertBody(body);
  const note: NoteRecord = { id: "inbox", title: "Inbox", body, pinned: entries.some((entry) => Boolean(entry.pinned)), archived: false, revision: 1, tasks, activity: [], created: stamp, updated: stamp };
  appendActivity(note, { by: "user" }, "migrated from legacy notepad.json");
  return { version: 3, notes: [note] };
}

function semanticSnapshot(note: NoteRecord) {
  return JSON.stringify(note);
}

function yamlScalar(raw: string | undefined, fallback: string) {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : String(parsed); }
    catch { return fallback; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, "").trim() || fallback;
}

function splitFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { values: new Map<string, string>(), unknown: [] as string[], markdown: content };
  const values = new Map<string, string>();
  const unknown: string[] = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    const field = rawLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (field && KNOWN_FRONTMATTER.has(field[1].toLowerCase())) values.set(field[1].toLowerCase(), field[2] || "");
    else unknown.push(rawLine);
  }
  return { values, unknown, markdown: content.slice(match[0].length) };
}

function unescapeFieldValue(value: string) { return value.replace(/\\([\\\]nr])/g, (_all, escaped: string) => escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped); }
function fieldValue(value: string) { return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\]/g, "\\]"); }
function inlineField(name: string, value: string) { return `[${name}:: ${fieldValue(value)}]`; }
function extractInlineFields(raw: string, accepted: Set<string>) {
  const values = new Map<string, string[]>();
  const text = raw.replace(/(?<!\\)\[([A-Za-z][A-Za-z0-9-]*)::\s*((?:\\.|[^\]])*)\]/g, (whole, rawName: string, rawValue: string) => {
    const name = rawName.toLowerCase();
    if (!accepted.has(name)) return whole;
    const entries = values.get(name) || [];
    entries.push(unescapeFieldValue(rawValue.trim())); values.set(name, entries);
    return "";
  }).replace(/\\\[(?=[A-Za-z][A-Za-z0-9-]*::)/g, "[").replace(/\\\\/g, "\\");
  return { text: text.trim(), values };
}
function escapeInlineText(text: string, names: string[]) {
  const wanted = names.join("|");
  return text.replace(/\\/g, "\\\\").replace(new RegExp(`\\[(?=(?:${wanted})::)`, "gi"), "\\[");
}

const TASK_FIELDS = new Set(["id", "due", "waiting", "session", "blocks", "relates", "spawned", "created", "completed"]);
function parseTaskLine(line: string, group: string | undefined, stamp: string): TaskRecord | undefined {
  const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/);
  if (!checkbox) return undefined;
  const parsed = extractInlineFields(checkbox[2], TASK_FIELDS);
  if (!parsed.text) return undefined;
  const id = parsed.values.get("id")?.[0] || taskId();
  const due = parsed.values.get("due")?.[0] || null;
  if (!/^t-[A-Za-z0-9_-]+$/.test(id) || due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined;
  const relations: Relation[] = [];
  for (const type of ["blocks", "relates", "spawned"] as const) {
    for (const to of parsed.values.get(type) || []) if (splitReference(to)) relations.push({ type, to }); else return undefined;
  }
  const done = checkbox[1].toLowerCase() === "x";
  return {
    id, text: parsed.text, done, ...(group ? { group } : {}), due,
    session: parsed.values.get("session")?.[0] || null,
    waiting: parsed.values.get("waiting")?.[0] || null,
    relations, created: parsed.values.get("created")?.[0] || stamp,
    completed: parsed.values.get("completed")?.[0] || null,
  };
}

function parseTaskRegion(region: string, stamp: string) {
  const tasks: TaskRecord[] = []; const residue: string[] = [];
  let group: string | undefined; let pendingHeading: string | undefined;
  for (const raw of region.replace(/^\r?\n/, "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      if (pendingHeading) residue.push(pendingHeading);
      group = heading[1].trim(); pendingHeading = line; continue;
    }
    if (/^<!--\s*pi-web-notepad:\s*ungrouped\s*-->$/i.test(line.trim())) {
      if (pendingHeading) residue.push(pendingHeading);
      group = undefined; pendingHeading = undefined; continue;
    }
    if (!line.trim()) continue;
    const task = parseTaskLine(line, group, stamp);
    if (task) { tasks.push(task); pendingHeading = undefined; }
    else { if (pendingHeading) residue.push(pendingHeading); pendingHeading = undefined; residue.push(line); }
  }
  if (pendingHeading) residue.push(pendingHeading);
  return { tasks, residue };
}

function parseActivityRegion(region: string) {
  const activity: ActivityRecord[] = []; const residue: string[] = [];
  for (const raw of region.replace(/^\r?\n/, "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    const entry = parseActivityLine(line);
    if (entry) activity.push(entry); else residue.push(line);
  }
  return { activity: activity.slice(-MAX_ACTIVITY), residue };
}

type ManagedRegions = { body: string; tasks: string; activity: string };
function headingMatch(markdown: string, name: "Tasks" | "Activity", after = 0) {
  const regex = new RegExp(`^##[ \\t]+${name}[ \\t]*\\r?$`, "gmi");
  regex.lastIndex = after; let found: RegExpExecArray | undefined;
  for (let match = regex.exec(markdown); match; match = regex.exec(markdown)) found = match;
  return found;
}
function withoutOneSeparator(value: string) { return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value; }
function managedRegions(markdown: string): ManagedRegions {
  const marker = markdown.lastIndexOf(MANAGED_MARKER);
  if (marker >= 0) {
    const managed = markdown.slice(marker + MANAGED_MARKER.length).replace(/^\r?\n/, "");
    const tasksHeading = headingMatch(managed, "Tasks");
    const activityHeading = headingMatch(managed, "Activity", tasksHeading ? tasksHeading.index + tasksHeading[0].length : 0);
    const tasks = tasksHeading ? managed.slice(tasksHeading.index + tasksHeading[0].length, activityHeading?.index) : "";
    const activity = activityHeading ? managed.slice(activityHeading.index + activityHeading[0].length) : "";
    return { body: withoutOneSeparator(markdown.slice(0, marker)), tasks, activity };
  }
  const tasksHeading = headingMatch(markdown, "Tasks");
  const activityHeading = headingMatch(markdown, "Activity", tasksHeading ? tasksHeading.index + tasksHeading[0].length : 0);
  const first = tasksHeading || activityHeading;
  if (!first) return { body: markdown, tasks: "", activity: "" };
  return {
    // With no managed marker the separator may itself be intentional body
    // whitespace, so retain every byte before the first reserved section.
    body: markdown.slice(0, first.index),
    tasks: tasksHeading ? markdown.slice(tasksHeading.index + tasksHeading[0].length, activityHeading?.index) : "",
    activity: activityHeading ? markdown.slice(activityHeading.index + activityHeading[0].length) : "",
  };
}
function appendResidue(body: string, residue: string[]) {
  if (!residue.length) return body;
  return `${body}${body && !body.endsWith("\n") ? "\n" : ""}${residue.join("\n")}`;
}

function parseVaultNote(content: string, id: string, archived: boolean, sourcePath: string): NoteRecord {
  const frontmatter = splitFrontmatter(content);
  const regions = managedRegions(frontmatter.markdown);
  const stamp = now();
  const parsedTasks = parseTaskRegion(regions.tasks, stamp);
  const parsedActivity = parseActivityRegion(regions.activity);
  const body = appendResidue(regions.body, [...parsedTasks.residue, ...parsedActivity.residue]);
  const revision = Number.parseInt(frontmatter.values.get("revision") || "1", 10);
  const note: NoteRecord = {
    id, title: yamlScalar(frontmatter.values.get("title"), markdownTitle(body, id)), body,
    pinned: !archived && /^true$/i.test(frontmatter.values.get("pinned") || ""), archived,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    tasks: parsedTasks.tasks, activity: parsedActivity.activity,
    created: yamlScalar(frontmatter.values.get("created"), stamp), updated: yamlScalar(frontmatter.values.get("updated"), stamp),
  };
  noteFileMeta.set(note, { sourcePath, sourceContent: content, unknownFrontmatter: frontmatter.unknown, snapshot: semanticSnapshot(note) });
  return note;
}

function serializeTask(task: TaskRecord) {
  const fields = [inlineField("id", task.id)];
  if (task.due) fields.push(inlineField("due", task.due));
  if (task.waiting) fields.push(inlineField("waiting", task.waiting));
  if (task.session) fields.push(inlineField("session", task.session));
  for (const relation of task.relations) fields.push(inlineField(relation.type, relation.to));
  if (task.created) fields.push(inlineField("created", task.created));
  if (task.completed) fields.push(inlineField("completed", task.completed));
  const text = escapeInlineText(task.text, [...TASK_FIELDS]);
  return `- [${task.done ? "x" : " "}] ${text} ${fields.join(" ")}`.trimEnd();
}
function serializeActivity(entry: ActivityRecord) {
  const session = (entry.sessionName || entry.sessionId)?.replace(/[()\r\n]/g, " ");
  const fields: string[] = [];
  if (entry.sessionId) fields.push(inlineField("session-id", entry.sessionId));
  if (entry.sessionName) fields.push(inlineField("session-name", entry.sessionName));
  if (entry.taskId) fields.push(inlineField("task-id", entry.taskId));
  const text = escapeInlineText(entry.text, ["session-id", "session-name", "task-id"]);
  return `- ${entry.at} · ${entry.by}${session ? `(${session})` : ""} · ${text}${fields.length ? ` ${fields.join(" ")}` : ""}`;
}
function notePath(note: NoteRecord) { return join(vaultRoot(), ...(note.archived ? [ARCHIVE] : []), `${note.id}.md`); }
function serializeNote(note: NoteRecord, unknownFrontmatter: string[] = []) {
  const frontmatter = ["---", `title: ${JSON.stringify(note.title)}`, ...(note.pinned ? ["pinned: true"] : []), `revision: ${note.revision}`, `created: ${JSON.stringify(note.created)}`, `updated: ${JSON.stringify(note.updated)}`, ...unknownFrontmatter, "---", ""].join("\n");
  const taskLines: string[] = []; let group: string | undefined;
  for (const task of note.tasks) {
    if (task.group !== group) {
      if (task.group) taskLines.push(`### ${task.group}`);
      else if (group) taskLines.push("<!-- pi-web-notepad: ungrouped -->");
      group = task.group;
    }
    taskLines.push(serializeTask(task));
  }
  const managed = [MANAGED_MARKER, "## Tasks", ...taskLines, "", "## Activity", ...note.activity.slice(-MAX_ACTIVITY)].map((line) => typeof line === "string" ? line : serializeActivity(line)).join("\n");
  return `${frontmatter}${note.body}\n${managed}\n`;
}

async function walkVault(folder = ""): Promise<Array<{ relative: string; content: string; path: string }>> {
  const output: Array<{ relative: string; content: string; path: string }> = [];
  let entries;
  try { entries = await readdir(join(vaultRoot(), folder), { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return output; throw error; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") && !(folder === "" && entry.name === ARCHIVE)) continue;
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    const path = join(vaultRoot(), relative);
    if (entry.isDirectory()) output.push(...await walkVault(relative));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) output.push({ relative, path, content: await readFile(path, "utf8") });
  }
  return output;
}

async function saveVaultStore(store: Store) {
  await mkdir(vaultRoot(), { recursive: true, mode: 0o700 }); await chmod(vaultRoot(), 0o700);
  for (const note of store.notes) {
    const meta = noteFileMeta.get(note); const target = notePath(note);
    const changed = !meta || meta.sourcePath !== target || meta.snapshot !== semanticSnapshot(note);
    if (!changed) continue;
    const content = serializeNote(note, meta?.unknownFrontmatter);
    if (!meta || meta.sourcePath !== target || meta.sourceContent !== content) await atomicWrite(target, content);
    if (meta && meta.sourcePath !== target) await rm(meta.sourcePath, { force: true });
  }
}

function assertV3Store(raw: any, path: string): Store {
  if (raw?.version !== 3 || !Array.isArray(raw.notes)) throw new Error(`Unsupported or invalid notepad database at ${path}`);
  return raw as Store;
}
async function readJsonStore(): Promise<Store> { return assertV3Store(JSON.parse(await readFile(dbPath(), "utf8")), dbPath()); }
async function legacyStore(): Promise<Store> {
  if (await exists(mdDir())) return migrateMarkdown();
  let legacy: unknown;
  try { legacy = JSON.parse(await readFile(legacyPath(), "utf8")); }
  catch (error: any) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  return legacy ? migrateLegacy(legacy) : { version: 3, notes: [] };
}
function migrationTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "");
}
async function migratedBackupPath() {
  const base = `${dbPath()}.migrated-${migrationTimestamp()}`; let path = base; let suffix = 2;
  while (await exists(path)) path = `${base}-${suffix++}`;
  return path;
}

async function ensureInitialized() {
  if (forceJsonStorage()) {
    if (await exists(dbPath())) return;
    await saveStore(await legacyStore());
    return;
  }
  let rootEntries: string[] | undefined;
  try { rootEntries = await readdir(vaultRoot()); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (rootEntries?.length) return;
  let store: Store;
  let migrateJson = false;
  if (await exists(dbPath())) { store = await readJsonStore(); migrateJson = true; }
  else store = await legacyStore();
  await saveVaultStore(store);
  if (migrateJson) await rename(dbPath(), await migratedBackupPath());
}

export async function loadStore(): Promise<Store> {
  if (forceJsonStorage()) return readJsonStore();
  const notes: NoteRecord[] = [];
  for (const file of await walkVault()) {
    const archived = file.relative.startsWith(`${ARCHIVE}/`);
    const id = pathId(file.relative);
    notes.push(parseVaultNote(file.content, id, archived, file.path));
  }
  return { version: 3, notes };
}

function candidates(kind: string, value: unknown, rows: string[]) {
  return `${rows.length > 1 ? `Ambiguous ${kind}` : `No ${kind} matches`} "${String(value)}". Candidates:${rows.length ? `\n${rows.map((row) => `- ${row}`).join("\n")}` : " (none)"}`;
}
function resolveNote(store: Store, value: unknown) {
  const input = cleanId(value, "note").toLowerCase();
  const exact = store.notes.filter((note) => note.id.toLowerCase() === input);
  if (exact.length === 1) return exact[0];
  const matches = store.notes.filter((note) => note.id.toLowerCase().includes(input) || basename(note.id).toLowerCase().includes(input));
  if (matches.length !== 1) throw new Error(candidates("note", value, matches.map((note) => note.id)));
  return matches[0];
}
function resolveTask(note: NoteRecord, value: unknown) {
  const input = shortText(value, "task").toLowerCase();
  const exact = note.tasks.filter((task) => task.id.toLowerCase() === input);
  if (exact.length === 1) return exact[0];
  const matches = note.tasks.filter((task) => task.text.toLowerCase().includes(input));
  if (matches.length !== 1) throw new Error(candidates("task", value, matches.map((task) => `${task.id} ${task.text}`)));
  return matches[0];
}
function resolveTarget(store: Store, value: unknown) {
  const input = shortText(value, "to");
  const split = splitReference(input);
  if (!split) throw new Error('to must address a task as "note-id#task-id" (note and task fragments are accepted)');
  const note = resolveNote(store, split.noteId);
  const task = resolveTask(note, split.taskId);
  return { note, task, ref: reference(note.id, task.id) };
}

function openBlockers(store: Store, target: string) {
  const blockers: Array<{ note: NoteRecord; task: TaskRecord }> = [];
  for (const note of store.notes) for (const task of note.tasks) {
    if (!task.done && task.relations.some((relation) => relation.type === "blocks" && relation.to === target)) blockers.push({ note, task });
  }
  return blockers;
}
function blocked(store: Store, note: NoteRecord, task: TaskRecord) {
  return !task.done && (Boolean(task.waiting) || openBlockers(store, reference(note.id, task.id)).length > 0);
}
function overdue(task: TaskRecord) { return !task.done && Boolean(task.due && task.due < today()); }
function state(store: Store, note: NoteRecord, task: TaskRecord) { return task.done ? "✓ done" : blocked(store, note, task) ? "⏳ blocked" : "☐ open"; }
function counts(note: NoteRecord) { return { open: note.tasks.filter((task) => !task.done).length, total: note.tasks.length }; }

function relationViews(store: Store, note: NoteRecord, task: TaskRecord) {
  const self = reference(note.id, task.id);
  const views: Array<{ label: string; to: string; broken?: boolean }> = [];
  for (const relation of task.relations) views.push({ label: relation.type, to: relation.to, broken: !findReference(store, relation.to) });
  for (const owner of store.notes) for (const source of owner.tasks) for (const relation of source.relations) {
    if (relation.to !== self) continue;
    const label = relation.type === "blocks" ? "blocked by" : relation.type === "spawned" ? "spawned from" : "relates";
    views.push({ label, to: reference(owner.id, source.id) });
  }
  return views;
}
function panelHref(noteId: string, id?: string) {
  return `#panel:${PANEL_KEY}:note=${encodeURIComponent(noteId)}${id ? `&task=${encodeURIComponent(id)}` : ""}`;
}
function noteLink(noteId: string) { return `[${noteId}](${panelHref(noteId)})`; }
function taskLink(noteId: string, id: string) { return `[${id}](${panelHref(noteId, id)})`; }
function linkedReference(value: string) {
  const split = splitReference(value);
  return split ? `${split.noteId}#${taskLink(split.noteId, split.taskId)}` : value;
}
function taskLine(store: Store, note: NoteRecord, task: TaskRecord) {
  const chips = [taskLink(note.id, task.id), task.due ? `due:${task.due}` : "", task.session ? `session:${task.session}` : "", task.waiting ? `waiting:${task.waiting}` : "", `created:${task.created}`, task.completed ? `completed:${task.completed}` : "", overdue(task) ? "⚠ overdue" : ""].filter(Boolean);
  const relations = relationViews(store, note, task).map((relation) => `${relation.label} ${linkedReference(relation.to)}${relation.broken ? " (broken)" : ""}`);
  return `${state(store, note, task)} ${task.text} · ${chips.join(" · ")}${relations.length ? `\n    relations: ${relations.join("; ")}` : ""}`;
}
function formatRead(store: Store, note: NoteRecord) {
  const lines = [`# ${note.title}`, `ID: ${noteLink(note.id)} · Revision: ${note.revision}${note.pinned ? " · pinned" : ""}${note.archived ? " · archived" : ""}`];
  if (note.body) lines.push("", note.body);
  lines.push("", "## Tasks");
  if (!note.tasks.length) lines.push("(no tasks)");
  else {
    let current: string | undefined;
    for (const task of note.tasks) {
      const group = task.group || "Tasks";
      if (group !== current) { lines.push(`### ${group}`); current = group; }
      lines.push(`- ${taskLine(store, note, task)}`);
    }
  }
  lines.push("", "## Recent activity");
  if (!note.activity.length) lines.push("(none)");
  else for (const entry of note.activity.slice(-20)) {
    const session = entry.sessionName || entry.sessionId;
    lines.push(`- ${entry.at} · ${entry.by}${session ? `(${session})` : ""}${entry.taskId ? ` · ${taskLink(note.id, entry.taskId)}` : ""} · ${entry.text}`);
  }
  return lines.join("\n");
}

function visibleNotes(store: Store, folder?: string, query?: string) {
  const archived = folder === ARCHIVE || Boolean(folder?.startsWith(`${ARCHIVE}/`));
  let prefix = archived ? (folder === ARCHIVE ? "" : cleanId(folder!.slice(ARCHIVE.length + 1), "folder", true)) : cleanId(folder || "", "folder", true);
  const needle = String(query || "").trim().toLowerCase();
  return store.notes.filter((note) => note.archived === archived)
    .filter((note) => !prefix || note.id === prefix || note.id.startsWith(`${prefix}/`))
    .filter((note) => !needle || note.title.toLowerCase().includes(needle) || note.body.toLowerCase().includes(needle) || note.tasks.some((task) => task.text.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id.localeCompare(b.id));
}
function noteTreeLines(notes: NoteRecord[], pin = false) {
  const lines: string[] = [];
  const folders = new Set<string>();
  for (const note of notes) {
    const parts = note.id.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      if (!folders.has(path)) { lines.push(`${"  ".repeat(index)}${parts[index]}/`); folders.add(path); }
    }
    const count = counts(note);
    lines.push(`${"  ".repeat(parts.length - 1)}${pin ? "📌 " : ""}${noteLink(note.id)} — ${count.open}/${count.total} open`);
  }
  return lines;
}
function formatList(notes: NoteRecord[], archived: boolean) {
  if (!notes.length) return archived ? "The archive has no matching notes." : "The notepad has no matching notes.";
  const pinned = archived ? [] : notes.filter((note) => note.pinned);
  const regular = notes.filter((note) => archived || !note.pinned);
  const lines: string[] = [];
  if (pinned.length) lines.push("Pinned", ...noteTreeLines(pinned, true));
  if (regular.length) lines.push(archived ? "Archive" : "Notes", ...noteTreeLines(regular));
  return lines.join("\n");
}

function result(text: string, details: Record<string, unknown> = {}) { return { content: [{ type: "text" as const, text }], details }; }
function mutate(store: Store, note: NoteRecord, actor: Actor, summary: string, id?: string) {
  pruneDangling(store, note);
  bump(note);
  appendActivity(note, actor, summary, id);
}

const toolParameters = Type.Object({
  action: StringEnum(["create", "list", "read", "tasks", "add", "check", "uncheck", "update", "write", "link", "unlink", "log", "pin", "unpin", "archive", "move"] as const),
  title: Type.Optional(Type.String({ description: "create: note title; move: optional new title" })),
  folder: Type.Optional(Type.String({ description: "Virtual folder; list .archive to see archived notes" })),
  text: Type.Optional(Type.String({ description: "create body, task text, update text, or log text" })),
  body: Type.Optional(Type.String({ description: "write: replacement informational Markdown body" })),
  revision: Type.Optional(Type.Number({ description: "write: required current note revision" })),
  note: Type.Optional(Type.String({ description: "Note id/path or unique slug fragment" })),
  task: Type.Optional(Type.String({ description: "Task id or unique case-insensitive text substring" })),
  group: Type.Optional(Type.String({ description: "add/update task group; update empty clears" })),
  status: Type.Optional(StringEnum(["open", "overdue", "blocked", "done"] as const)),
  session: Type.Optional(Type.String({ description: "tasks filter; add/update value (update empty clears)" })),
  query: Type.Optional(Type.String({ description: "Case-insensitive note/body/task filter" })),
  due: Type.Optional(Type.String({ description: 'add/update due as "YYYY-MM-DD" (update empty clears)' })),
  waiting: Type.Optional(Type.String({ description: "add/update waiting reason (update empty clears)" })),
  to: Type.Optional(Type.String({ description: 'link/unlink target as "note-id#task-id"' })),
  type: Type.Optional(StringEnum(["blocks", "relates", "spawned"] as const)),
});

// Minimal safe Markdown rendering. Body checkbox syntax is deliberately disabled.
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function renderInline(value: string) {
  const protectedLinks: string[] = [];
  const protect = (html: string) => `\u0000${protectedLinks.push(html) - 1}\u0000`;
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_all, label: string, href: string) => protect(/^(https?:|mailto:|\/|#)/i.test(href.trim()) ? `<a href="${escapeHtml(href.trim())}" target="_blank" rel="noreferrer">${label}</a>` : label))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\u0000(\d+)\u0000/g, (_all, index: string) => protectedLinks[Number(index)] || "");
}
function headingSlug(value: string) { return slugify(value.replace(/[`*_~]/g, "")); }
function markdownHtml(body: string, highlightedHeading?: string) {
  const out: string[] = []; let list = false; let markedHeading = false;
  const close = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const line of body.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      close();
      const mark = !markedHeading && highlightedHeading === headingSlug(heading[2]);
      if (mark) markedHeading = true;
      out.push(`<h${heading[1].length}${mark ? " data-web-panel-highlight" : ""}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (checkbox || bullet) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${checkbox ? `<input type="checkbox" ${checkbox[1].toLowerCase() === "x" ? "checked" : ""} disabled> ${renderInline(checkbox[2])}` : renderInline(bullet![1])}</li>`); continue; }
    close(); if (line.trim()) out.push(`<p>${renderInline(line.trim())}</p>`);
  }
  close(); return out.join("\n");
}
function payload(value: unknown) { return escapeHtml(JSON.stringify(value)); }
function eventPayload(event?: PiWebPanelEvent) { return event?.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {}; }
function firstField(event: PiWebPanelEvent | undefined, key: string) { const value = event?.fields?.[key]; return Array.isArray(value) ? value[0] : value; }

function truncate(value: string, max = 54) {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
function relativeTime(value: string) {
  const stamp = new Date(value).valueOf();
  if (!Number.isFinite(stamp)) return value.slice(0, 16).replace("T", " ");
  const seconds = Math.round((stamp - Date.now()) / 1_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return "just now";
}
function normalizedGroup(task: TaskRecord) {
  const group = task.group?.trim();
  return group?.toLowerCase() === "tasks" ? undefined : group || undefined;
}
function statusHtml(status: string, undoNote?: string) {
  if (!status) return "";
  return `<div class="gnpStatus" role="status"><span>${escapeHtml(status)}</span>${undoNote ? `<button class="gnpTextButton" type="button" data-web-panel-action="unarchive-note" data-web-panel-payload='${payload({ note: undoNote })}'>Undo</button>` : ""}</div>`;
}
type FolderTreeNode = { name: string; path: string; open: number; folders: Map<string, FolderTreeNode>; notes: NoteRecord[] };
type NoteRowKind = "note" | "pinned" | "session";
function noteRow(note: NoteRecord, depth = 0, kind: NoteRowKind = "note", showPath = false) {
  const count = counts(note);
  const folder = note.id.split("/").slice(0, -1).join("/");
  const pinnedShortcut = note.pinned && kind !== "note";
  const icon = kind === "pinned" || pinnedShortcut ? pinSvg : kind === "session" ? sessionSvg : noteSvg;
  const path = showPath && folder ? `<span class="gnpRowPath" title="${escapeHtml(folder)}">${escapeHtml(folder)}/</span>` : "";
  const location = folder ? ` in ${folder}` : " at the tree root";
  const aria = `${pinnedShortcut ? "Pinned note. " : ""}Open ${note.title}${location}; ${count.open} open ${count.open === 1 ? "task" : "tasks"}`;
  return `<div class="gnpRow gnpRow-${kind}${pinnedShortcut ? " gnpRow-isPinned" : ""}" role="listitem" style="--gnp-indent:${depth * 14}px"><button class="gnpOpen" type="button" aria-label="${escapeHtml(aria)}" title="${escapeHtml(`${note.title} (${note.id})`)}" data-web-panel-action="open-note" data-web-panel-payload='${payload({ note: note.id })}'><span class="gnpTreeIcon" aria-hidden="true">${icon}</span><span class="gnpRowName"><strong>${escapeHtml(note.title)}</strong>${path}</span><span class="gnpRowCount" aria-hidden="true">${count.open} open</span></button></div>`;
}
function shortcutRows(notes: NoteRecord[], kind: Exclude<NoteRowKind, "note">) {
  return notes.map((note) => noteRow(note, 0, kind, true)).join("");
}
function folderTreeRows(notes: NoteRecord[]) {
  const root: FolderTreeNode = { name: "", path: "", open: 0, folders: new Map(), notes: [] };
  for (const note of notes) {
    const open = counts(note).open;
    const folders = note.id.split("/").slice(0, -1);
    let node = root; node.open += open;
    for (const name of folders) {
      const path = node.path ? `${node.path}/${name}` : name;
      let child = node.folders.get(name);
      if (!child) { child = { name, path, open: 0, folders: new Map(), notes: [] }; node.folders.set(name, child); }
      child.open += open; node = child;
    }
    node.notes.push(note);
  }
  const renderFolder = (folder: FolderTreeNode, depth: number): string => {
    const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => renderFolder(child, depth + 1)).join("");
    const noteRows = folder.notes.sort((a, b) => a.title.localeCompare(b.title)).map((note) => noteRow(note, depth + 1)).join("");
    return `<div class="gnpFolder" role="listitem" aria-label="Folder ${escapeHtml(folder.path)}, ${folder.open} open tasks" style="--gnp-indent:${depth * 14}px"><span class="gnpTreeIcon" aria-hidden="true">${folderSvg}</span><strong>${escapeHtml(folder.name)}</strong><span class="gnpRowCount" aria-hidden="true">${folder.open} open</span></div>${folders}${noteRows}`;
  };
  const rootNotes = root.notes.sort((a, b) => a.title.localeCompare(b.title)).map((note) => noteRow(note)).join("");
  const folders = [...root.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((folder) => renderFolder(folder, 0)).join("");
  return `${rootNotes}${folders}`;
}

const panelStyles = `<style>
.gnp{--gnp-muted:color-mix(in srgb,var(--muted) 78%,var(--text));display:grid;gap:10px;min-width:0;font-size:13px;overflow-wrap:anywhere}.gnp *{box-sizing:border-box}.gnp section,.gnp article,.gnpTaskMain{min-width:0}.gnpSectionTitle{display:flex;align-items:center;gap:5px;min-height:18px;margin:2px 4px 3px;font-size:11.5px;letter-spacing:.055em;text-transform:uppercase;color:var(--gnp-muted,var(--muted))}.gnpTaskGroup{margin:14px 0 3px;font-size:12px;color:var(--gnp-muted,var(--muted))}.gnpInlineIcon{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gnpBar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.gnpBar input,.gnpEditGrid input{flex:1;min-width:150px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2);color:var(--text);font:inherit}.gnp .webPanelButton,.gnpTextButton{min-height:40px}.gnpTextButton{padding:6px 9px;border:0;background:none;color:var(--accent);font:inherit;font-weight:650;cursor:pointer}
.gnpTree{gap:6px}.gnpToolbar{display:flex;align-items:center;gap:5px;min-width:0}.gnpFilter{display:flex;align-items:center;min-width:0;flex:1;height:32px;border:1px solid var(--border);border-radius:7px;background:var(--panel-2)}.gnpFilter input{min-width:0;width:100%;height:32px;min-height:32px;padding:5px 7px;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:12px}.gnpFilter:focus-within{border-color:var(--accent)}.gnpResult{flex:0 0 auto;padding:0 7px 0 4px;color:var(--gnp-muted,var(--muted));font-size:11px;white-space:nowrap}.gnpToolbar .webPanelButton{height:32px;min-height:32px;padding:4px 8px;font-size:11.5px}.gnpArchiveActive{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 22%,var(--panel-2))}.gnpCreate{position:relative;flex:0 0 auto}.gnpCreate>summary{display:grid;width:32px;height:32px;min-height:32px;place-items:center;list-style:none;border:1px solid color-mix(in srgb,var(--accent) 50%,var(--border));border-radius:7px;background:color-mix(in srgb,var(--accent) 14%,var(--panel-2));color:var(--accent);cursor:pointer}.gnpCreate>summary::-webkit-details-marker{display:none}.gnpCreate[open]>summary{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 25%,var(--panel-2))}.gnpCreateForm{position:absolute;z-index:3;top:37px;right:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.75fr) auto;gap:6px;width:min(420px,calc(100vw - 48px));padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--panel);box-shadow:0 10px 26px color-mix(in srgb,black 28%,transparent)}.gnpCreateForm input{min-width:0;width:100%;padding:7px 8px;border:1px solid var(--border);border-radius:7px;background:var(--panel-2);color:var(--text);font:inherit;font-size:12px}
.gnpSection{display:grid;gap:1px}.gnpExplorer{display:grid;gap:0;min-width:0}.gnpRow{min-width:0;border:0;border-radius:5px;background:transparent}.gnpRow:hover,.gnpRow:focus-within{background:color-mix(in srgb,var(--accent) 9%,var(--panel-2))}.gnpOpen{display:flex;align-items:center;gap:5px;width:100%;min-width:0;height:28px;min-height:28px;padding:3px 6px 3px calc(5px + var(--gnp-indent,0px));border:0;border-radius:5px;background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer}.gnpOpen:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.gnpTreeIcon{display:grid;flex:0 0 15px;width:15px;place-items:center;color:var(--gnp-muted,var(--muted))}.gnpRow-pinned .gnpTreeIcon,.gnpRow-isPinned .gnpTreeIcon{color:var(--accent)}.gnpRow-session .gnpTreeIcon{color:color-mix(in srgb,var(--accent) 72%,var(--text))}.gnpRowName{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1;white-space:nowrap}.gnpRowName strong{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;font-weight:560;white-space:nowrap}.gnpRowPath{max-width:42%;overflow:hidden;text-overflow:ellipsis;color:var(--gnp-muted,var(--muted));font-size:11px;white-space:nowrap}.gnpRowCount{flex:0 0 auto;margin-left:auto;color:var(--gnp-muted,var(--muted));font-size:11px;font-weight:450;white-space:nowrap}.gnpFolder{display:flex;align-items:center;gap:5px;min-width:0;min-height:26px;padding:3px 6px 3px calc(5px + var(--gnp-indent,0px));color:var(--text)}.gnpFolder strong{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:680;white-space:nowrap}.gnpMeta,.gnpActivity{color:var(--gnp-muted,var(--muted));font-size:11.5px}
.gnpTask{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:6px;align-items:start;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent)}.gnpTask:last-child{border-bottom:0}.gnpCheckTarget{display:grid;width:40px;height:40px;place-items:center;cursor:pointer}.gnpCheckTarget input{width:19px;height:19px;margin:0;accent-color:var(--accent);cursor:pointer}.gnpCheckTarget:has(input:disabled){cursor:default}.gnpTaskText{padding-top:3px;font-size:13.5px;line-height:1.4}.gnpDone .gnpTaskText{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;text-decoration:line-through;color:var(--gnp-muted,var(--muted))}.gnpChips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.gnpChips:not(:has(>:not(.gnpTaskId))){margin-top:0}.gnpChip{display:inline-block;padding:2px 6px;border-radius:9px;background:var(--panel-2);color:var(--gnp-muted,var(--muted));font-size:11px}.gnpTaskId{display:none}.gnpTask:hover .gnpTaskId,.gnpTask:focus-within .gnpTaskId{display:inline-block}.gnpDueOverdue{background:color-mix(in srgb,var(--danger) 14%,var(--panel-2));color:var(--danger);font-weight:650}.gnpRelations{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.gnpRelation{display:block;height:auto;min-height:40px;max-width:100%;overflow:hidden;padding:6px 8px;border:1px solid color-mix(in srgb,var(--accent) 32%,var(--border));border-radius:9px;background:transparent;color:var(--accent);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}.gnpRelationLabel{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;line-height:1.35}.gnpIconButton{display:grid;width:40px;height:40px;place-items:center;padding:0;border:1px solid color-mix(in srgb,var(--border) 78%,transparent);border-radius:9px;background:color-mix(in srgb,var(--panel-2) 72%,transparent);color:var(--gnp-muted,var(--muted));font:inherit;cursor:pointer}.gnpIconButton:hover,.gnpIconButton:focus-visible{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--panel-2));color:var(--text)}
.gnpNoteNav{display:flex;align-items:center;gap:7px;min-width:0}.gnpNoteNav .webPanelButton{min-height:32px;padding:4px 9px;font-size:12px}.gnpBackButton{font-weight:680}.gnpBreadcrumb{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--gnp-muted,var(--muted));font-size:11.5px;white-space:nowrap}.gnpNoteNavActions{display:flex;gap:5px;flex:0 0 auto}
.gnpDoc{line-height:1.55;overflow-wrap:anywhere}.gnpDoc:empty{display:none}.gnpDoc h1,.gnpDoc h2,.gnpDoc h3,.gnpDoc h4,.gnpDoc h5,.gnpDoc h6{margin:1.15em 0 .4em;color:var(--text);font-weight:680;line-height:1.25;letter-spacing:normal;text-transform:none}.gnpDoc h1{font-size:18px}.gnpDoc h2{font-size:15.5px}.gnpDoc h3{font-size:14px}.gnpDoc h4{font-size:13px}.gnpDoc h5,.gnpDoc h6{font-size:12px}.gnpDoc p{margin:.55em 0}.gnpDoc ul{margin:.55em 0;padding-left:20px}.gnpDoc>:first-child{margin-top:0}.gnpActivityList{display:grid;gap:5px}.gnpActivity{border-left:2px solid var(--border);padding:5px 0 5px 8px;line-height:1.45}.gnpActivityActor{color:var(--text)}.gnpActivityTask{color:var(--text)}.gnpStatus{display:flex;min-height:36px;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;background:var(--panel-2);color:var(--gnp-muted,var(--muted))}
.gnpEditGrid{display:grid;gap:10px}.gnpEditGrid label{display:grid;gap:4px;color:var(--gnp-muted,var(--muted));font-size:11.5px}.gnpEditGrid input{width:100%;min-width:0}.gnpEditActions{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:640px){.gnp{gap:10px}.gnpToolbar{gap:4px}.gnpFilter{height:44px}.gnpFilter input{height:44px;min-height:44px}.gnpToolbar .webPanelButton{height:44px;min-height:44px}.gnpCreate>summary{width:44px;height:44px;min-height:44px}.gnpCreateForm{top:49px;grid-template-columns:1fr;width:min(320px,calc(100vw - 40px))}.gnpOpen{height:44px;min-height:44px}.gnpRowPath{max-width:34%}.gnpBar{align-items:stretch}.gnpBar>input{flex-basis:100%}.gnpBar input,.gnpEditGrid input,.gnpCreateForm input{min-height:44px}.gnpTask{grid-template-columns:44px minmax(0,1fr) 44px}.gnpCheckTarget,.gnpIconButton{width:44px;height:44px}.gnpRelation{flex:1 1 100%;min-height:44px}.gnp .webPanelButton,.gnp .gnpTextButton{min-height:44px;padding-inline:11px}.gnpNoteNav{flex-wrap:wrap}.gnpBreadcrumb{order:3;flex-basis:100%;padding-left:2px}}

@media(prefers-reduced-motion:reduce){.gnpRow{transition:none}.gnpRow:hover,.gnpRow:focus-within{transform:none}}
</style>`;

const pinSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M5 17h14M7 3h10l-1 8 3 3H5l3-3-1-8Z"/></svg>`;
const plusSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
const editSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>`;
const folderSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 2h9v10H3Z"/></svg>`;
const noteSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6Z"/><path d="M14 3v4h4"/></svg>`;
const sessionSvg = `<svg class="gnpInlineIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a4 4 0 0 0 5.7.1l2-2a4 4 0 0 0-5.7-5.7l-1.1 1.1M14 11a4 4 0 0 0-5.7-.1l-2 2A4 4 0 0 0 12 18.6l1.1-1.1"/></svg>`;

type PanelSessionContext = { id?: string; name?: string };
function connectedToSession(note: NoteRecord, session: PanelSessionContext) {
  const id = session.id?.trim();
  const name = session.name?.trim().toLowerCase();
  return Boolean(id && note.activity.some((entry) => entry.sessionId === id)
    || name && note.tasks.some((task) => task.session?.trim().toLowerCase() === name));
}
function renderTree(notes: NoteRecord[], archived = false, status = "", query = "", undoNote?: string, session: PanelSessionContext = {}): PiWebPanelView {
  const connected = archived ? [] : notes.filter((note) => connectedToSession(note, session));
  const connectedIds = new Set(connected.map((note) => note.id));
  const pinned = archived ? [] : notes.filter((note) => note.pinned && !connectedIds.has(note.id));
  const regular = notes;
  const sections = [
    connected.length ? `<section class="gnpSection"><h3 class="gnpSectionTitle">${sessionSvg}<span>This session</span></h3><div class="gnpExplorer" role="list">${shortcutRows(connected, "session")}</div></section>` : "",
    pinned.length ? `<section class="gnpSection"><h3 class="gnpSectionTitle"><span>Pinned</span></h3><div class="gnpExplorer" role="list">${shortcutRows(pinned, "pinned")}</div></section>` : "",
    regular.length ? `<section class="gnpSection"><h3 class="gnpSectionTitle"><span>${archived ? "Archive" : "Notes"}</span></h3><div class="gnpExplorer" role="list">${folderTreeRows(regular)}</div></section>` : "",
  ].join("");
  const archiveAction = archived ? "view" : "show-archive";
  return { title: archived ? "Global notepad — archive" : "Global notepad", html: `${panelStyles}<div class="gnp gnpTree">
    <div class="gnpToolbar"><form class="gnpFilter" data-web-panel-action="filter-tree" data-web-panel-payload='${payload({ archived })}'><input name="query" value="${escapeHtml(query)}" placeholder="Filter notes and tasks…" aria-label="Filter notes and tasks"><span class="gnpResult" aria-label="${notes.length} matching notes">${notes.length} ${notes.length === 1 ? "note" : "notes"}</span></form><button class="webPanelButton gnpToolbarButton ${archived ? "gnpArchiveActive" : ""}" type="button" data-web-panel-action="${archiveAction}" aria-pressed="${archived}"${archived ? ' aria-current="page"' : ""}>Archive</button>${archived ? "" : `<details class="gnpCreate"><summary aria-label="New note" title="New note">${plusSvg}</summary><form class="gnpCreateForm" data-web-panel-action="create-note"><input name="title" maxlength="${MAX_TASK_TEXT}" placeholder="Note title" aria-label="Note title" required><input name="folder" maxlength="500" placeholder="Folder (optional)" aria-label="Folder (optional)"><button class="webPanelButton" type="submit">Create</button></form></details>`}</div>
    ${statusHtml(status, undoNote)}${sections || `<div class="gnpMeta">${query ? "No matching notes." : archived ? "The archive is empty." : "No notes yet. Create one above."}</div>`}
  </div>` };
}
type NoteHighlight = { task?: string; heading?: string; top?: boolean };
type TreeViewState = { kind: "tree"; archived: boolean; query: string; status?: string; undoNote?: string };
type NoteViewState = { kind: "note"; noteId: string; back: TreeViewState; status?: string; highlight?: NoteHighlight };
type EditViewState = { kind: "edit"; note: NoteViewState; taskId: string };
type PanelViewState = TreeViewState | NoteViewState | EditViewState;
function defaultTreeState(): TreeViewState { return { kind: "tree", archived: false, query: "" }; }
function withoutTransientHighlight(state: PanelViewState): PanelViewState {
  if (state.kind === "note" && state.highlight) {
    const { highlight: _highlight, ...rest } = state;
    return rest;
  }
  if (state.kind === "edit" && state.note.highlight) return { ...state, note: withoutTransientHighlight(state.note) as NoteViewState };
  return state;
}
function relationButton(store: Store, _note: NoteRecord, relation: ReturnType<typeof relationViews>[number]) {
  const target = findReference(store, relation.to);
  const targetText = target ? truncate(target.task.text, 42) : truncate(relation.to, 42);
  const tooltip = target ? `${target.note.title} — ${target.task.text} (${relation.to})` : relation.to;
  const label = `${relation.label}: ${targetText}${relation.broken ? " (broken)" : ""}`;
  return `<button class="gnpRelation" type="button" title="${escapeHtml(tooltip)}" data-web-panel-action="jump-task" data-web-panel-payload='${payload({ to: relation.to })}'><span class="gnpRelationLabel">${escapeHtml(label)}</span></button>`;
}
const GROUPABLE_ACTIVITY_VERBS = new Set(["added", "checked", "unchecked", "updated", "linked", "unlinked", "created", "replaced", "pinned", "unpinned", "moved", "archived", "unarchived"]);
type ActivityGroup = { verb?: string; entries: ActivityRecord[] };
function activityActorKey(entry: ActivityRecord) { return `${entry.by}:${entry.sessionName || entry.sessionId || ""}`; }
function activityLeadingVerb(entry: ActivityRecord) {
  const verb = entry.text.trim().match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  return verb && GROUPABLE_ACTIVITY_VERBS.has(verb) ? verb : undefined;
}
function activityGroups(entries: ActivityRecord[]) {
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const verb = activityLeadingVerb(entry);
    const previous = groups.at(-1);
    if (verb && previous?.verb === verb && activityActorKey(previous.entries[0]) === activityActorKey(entry)) previous.entries.push(entry);
    else groups.push({ verb, entries: [entry] });
  }
  return groups;
}
function activityDetail(entry: ActivityRecord) {
  const session = entry.sessionName || entry.sessionId;
  return `${entry.at} · ${entry.by}${session ? ` (${session})` : ""}${entry.taskId ? ` · ${entry.taskId}` : ""} · ${entry.text}`;
}
function activityActor(entry: ActivityRecord, repeatedActor: boolean) {
  const session = entry.sessionName || entry.sessionId;
  return { session, label: entry.by === "user" ? "you" : `agent${session && !repeatedActor ? ` (${truncate(session, 24)})` : ""}` };
}
function activityGroupHtml(entries: ActivityRecord[], verb: string, repeatedActor: boolean) {
  const newest = entries[0];
  const actor = activityActor(newest, repeatedActor);
  const allTasks = entries.every((entry) => Boolean(entry.taskId));
  const noun = verb === "linked" || verb === "unlinked" ? "task relations" : allTasks ? "tasks" : ["created", "pinned", "unpinned", "moved", "archived", "unarchived"].includes(verb) ? "notes" : "changes";
  const detail = entries.map(activityDetail).join("\n");
  return `<div class="gnpActivity gnpActivityGroup" title="${escapeHtml(detail)}"><time title="${escapeHtml(newest.at)}">${escapeHtml(relativeTime(newest.at))}</time> · <span class="gnpActivityActor"${actor.session ? ` title="${escapeHtml(actor.session)}"` : ""}>${escapeHtml(actor.label)}</span> · <span class="gnpActivitySummary">${escapeHtml(`${verb} ${entries.length} ${noun}`)}</span></div>`;
}
function activityHtml(note: NoteRecord, entry: ActivityRecord, repeatedActor: boolean) {
  const task = entry.taskId ? note.tasks.find((candidate) => candidate.id === entry.taskId) : undefined;
  const actor = activityActor(entry, repeatedActor);
  let text = entry.text.replaceAll(`${note.id}#`, "#").replace(` in ${note.id}`, "");
  if (task) text = text.replace(`"${task.text}"`, "").replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").replace(/[\s:;,.–—-]+$/, "");
  else if (/^(?:created|pinned|unpinned|archived|unarchived) note\b/i.test(text)) text = text.replace(`"${note.title}"`, "").trim();
  text = text.replace(/"([^"]+)"/g, (_all, quoted: string) => `“${truncate(quoted)}”`);
  const summary = truncate(text, 100) || (task ? "updated task" : "updated note");
  return `<div class="gnpActivity" title="${escapeHtml(activityDetail(entry))}"><time title="${escapeHtml(entry.at)}">${escapeHtml(relativeTime(entry.at))}</time> · <span class="gnpActivityActor"${actor.session ? ` title="${escapeHtml(actor.session)}"` : ""}>${escapeHtml(actor.label)}</span> · ${escapeHtml(summary)}${task ? ` · <span class="gnpActivityTask" title="${escapeHtml(`${task.text} (${task.id})`)}">${escapeHtml(truncate(task.text, 34))}</span>` : ""}</div>`;
}
function renderTaskEdit(note: NoteRecord, task: TaskRecord): PiWebPanelView {
  return { title: `${truncate(note.title, 72)} — edit task`, html: `${panelStyles}<div class="gnp"><div class="gnpBar"><button class="webPanelButton" type="button" data-web-panel-action="open-note" data-web-panel-payload='${payload({ note: note.id })}'>Cancel</button></div><form class="gnpEditGrid" data-web-panel-action="save-task-edit" data-web-panel-payload='${payload({ note: note.id, task: task.id })}'>
    <label>Task text<input name="text" value="${escapeHtml(task.text)}" maxlength="${MAX_TASK_TEXT}" required autofocus></label><label>Group<input name="group" value="${escapeHtml(task.group || "")}" maxlength="100" placeholder="Optional"></label><label>Due date<input name="due" type="date" value="${escapeHtml(task.due || "")}"></label><label>Session<input name="session" value="${escapeHtml(task.session || "")}" maxlength="200" placeholder="Optional"></label><label>Waiting on<input name="waiting" value="${escapeHtml(task.waiting || "")}" maxlength="200" placeholder="Optional"></label><div class="gnpEditActions"><button class="webPanelButton" type="button" data-web-panel-action="open-note" data-web-panel-payload='${payload({ note: note.id })}'>Cancel</button><button class="webPanelButton" type="submit">Save</button></div>
  </form></div>` };
}
function renderNote(store: Store, note: NoteRecord, status = "", highlight: NoteHighlight = {}): PiWebPanelView {
  let group: string | undefined;
  const tasks = note.tasks.map((task) => {
    const nextGroup = normalizedGroup(task);
    const heading = nextGroup && nextGroup !== group ? `<h4 class="gnpTaskGroup">${escapeHtml(nextGroup)}</h4>` : ""; group = nextGroup;
    const dueChip = task.due ? `<span class="gnpChip ${overdue(task) ? "gnpDueOverdue" : ""}">${escapeHtml(`due ${task.due}${overdue(task) ? " · overdue" : ""}`)}</span>` : "";
    const chips = `<span class="gnpChip gnpTaskId" title="Task ID: ${escapeHtml(task.id)}">…${escapeHtml(task.id.slice(-6))}</span>${dueChip}${task.session ? `<span class="gnpChip">session: ${escapeHtml(task.session)}</span>` : ""}${task.waiting ? `<span class="gnpChip">waiting: ${escapeHtml(task.waiting)}</span>` : ""}`;
    const relations = relationViews(store, note, task).map((relation) => relationButton(store, note, relation)).join("");
    return `${heading}<div class="gnpTask ${task.done ? "gnpDone" : ""}" id="task-${escapeHtml(task.id)}"${highlight.task === task.id ? " data-web-panel-highlight" : ""}><label class="gnpCheckTarget" aria-label="${task.done ? "Mark task open" : "Mark task done"}"><input type="checkbox" ${task.done ? "checked" : ""} ${note.archived ? "disabled" : `data-web-panel-action="toggle-task" data-web-panel-payload='${payload({ note: note.id, task: task.id })}'`}></label><div class="gnpTaskMain"><div class="gnpTaskText"${task.done ? ` title="${escapeHtml(task.text)}"` : ""}>${escapeHtml(task.text)}</div><div class="gnpChips">${chips}</div>${relations ? `<div class="gnpRelations">${relations}</div>` : ""}</div>${note.archived ? "" : `<button class="gnpIconButton" type="button" title="Edit task" aria-label="Edit ${escapeHtml(truncate(task.text, 32))}" data-web-panel-action="edit-task" data-web-panel-payload='${payload({ note: note.id, task: task.id })}'>${editSvg}</button>`}</div>`;
  }).join("");
  const groupedActivity = activityGroups(note.activity.slice(-20).reverse());
  const activity = groupedActivity.map((group, index) => {
    const newest = group.entries[0];
    const previous = groupedActivity[index - 1]?.entries[0];
    const repeatedActor = Boolean(previous && activityActorKey(previous) === activityActorKey(newest));
    return group.verb && group.entries.length > 1 ? activityGroupHtml(group.entries, group.verb, repeatedActor) : activityHtml(note, newest, repeatedActor);
  }).join("");
  const folder = note.id.split("/").slice(0, -1);
  const breadcrumb = folder.length ? folder.join(" / ") : "Root";
  return { title: truncate(note.title, 96), html: `${panelStyles}<div class="gnp"><div class="gnpNoteNav"><button class="webPanelButton gnpBackButton" type="button" data-web-panel-action="back-tree">Back to notes</button><div class="gnpBreadcrumb" title="${escapeHtml(`Location: ${breadcrumb}`)}">${escapeHtml(breadcrumb)} /</div>${note.archived ? "" : `<div class="gnpNoteNavActions"><button class="webPanelButton" type="button" data-web-panel-action="${note.pinned ? "unpin-note" : "pin-note"}" data-web-panel-payload='${payload({ note: note.id, reopen: true })}'>${note.pinned ? "Unpin" : "Pin"}</button><button class="webPanelButton" type="button" data-web-panel-action="archive-note" data-web-panel-payload='${payload({ note: note.id })}'>Archive</button></div>`}</div>${statusHtml(status)}<article class="gnpDoc"${highlight.top ? " data-web-panel-highlight" : ""}>${markdownHtml(note.body, highlight.heading)}</article><section><h3 class="gnpSectionTitle">Tasks</h3>${tasks || '<div class="gnpMeta">No tasks.</div>'}</section>${note.archived ? "" : `<form class="gnpBar" data-web-panel-action="quick-add" data-web-panel-payload='${payload({ note: note.id })}'><input name="text" maxlength="${MAX_TASK_TEXT}" placeholder="Add a task…" required><button class="webPanelButton" type="submit">Add</button></form>`}<section><h3 class="gnpSectionTitle">Activity</h3><div class="gnpActivityList">${activity || '<div class="gnpMeta">No activity yet.</div>'}</div></section></div>` };
}
function renderPanelState(store: Store, state: PanelViewState, session: PanelSessionContext = {}): PiWebPanelView {
  if (state.kind === "tree") return renderTree(visibleNotes(store, state.archived ? ARCHIVE : undefined, state.query), state.archived, state.status || "", state.query, state.undoNote, session);
  const noteState = state.kind === "edit" ? state.note : state;
  const note = store.notes.find((candidate) => candidate.id === noteState.noteId);
  if (!note) return renderTree(visibleNotes(store), false, `Note no longer exists: ${noteState.noteId}.`, "", undefined, session);
  if (state.kind === "edit") {
    const task = note.tasks.find((candidate) => candidate.id === state.taskId);
    if (!task || note.archived) return renderNote(store, note, task ? "Archived notes are read-only." : "Task no longer exists.");
    return renderTaskEdit(note, task);
  }
  return renderNote(store, note, state.status || "", state.highlight || {});
}

export default function globalNotepad(pi: PiWebExtensionAPI) {
  const sessionSource = (ctx: { sessionManager?: any }, by: "user" | "agent" = "agent"): Actor => ({ by, sessionId: String(ctx.sessionManager?.getSessionId?.() || "") || undefined, sessionName: (typeof (pi as any).getSessionName === "function" ? (pi as any).getSessionName() : undefined) || undefined });

  pi.registerTool({
    name: "notepad", label: "Notepad",
    description: [
      "Global Markdown-vault notepad shared across conversations. Each note has an informational Markdown body, structured task job records with stable t-… ids and typed relations, and an immutable-style activity audit tail.",
      "Body checkbox syntax is inert and never creates jobs. Use add for tasks. Relations live on the source: blocks, relates, or spawned; read computes blocked-by/spawned-from/inverse views. A task is blocked when waiting is set or an open blocker points to it.",
      "Actions: create(title, folder?, text? body); list(folder?, query?) (.archive lists archived); read(note); tasks(folder?, note?, status?, session?, query?); add(note, text, group?, due?, session?, waiting?); check/uncheck(note, task); update(note, task, text?, group?, due?, session?, waiting?); write(note, body, revision); link/unlink(note, task, to, type); log(note, text, task?); pin/unpin; archive; move(note, folder?, title?). Note is id/path or unique slug fragment; task is stable id or unique case-insensitive text substring; to is note-id#task-id. write requires the revision from read and rejects stale edits. Every action re-reads external vault edits; editors that want write-staleness detection should also bump the revision frontmatter field.",
    ].join(" "),
    promptSnippet: "Manage global Markdown-vault notes: body=information, tasks=job records with typed relations, activity=audit",
    promptGuidelines: ["Use notepad for cross-conversation information and jobs. Put prose in body, create work only with add, use stable task ids for mutations/relations, and re-read before revision-guarded write. Use log only for freeform communication; every mutation is already audited."],
    parameters: toolParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return withNoteQueue(async () => {
        await ensureInitialized();
        const store = await loadStore();
        const actor = sessionSource(ctx as any);

        if (params.action === "create") {
          if (store.notes.filter((note) => !note.archived).length >= MAX_ACTIVE_NOTES) throw new Error(`The notepad already has ${MAX_ACTIVE_NOTES} active notes; archive one first`);
          const title = shortText(params.title, "title");
          const folder = cleanId(params.folder || "", "folder", true);
          const id = `${folder ? `${folder}/` : ""}${slugify(title)}`;
          if (store.notes.some((note) => note.id === id)) throw new Error(`Note "${id}" already exists`);
          const body = String(params.text || "").trim(); assertBody(body);
          const stamp = now();
          const note: NoteRecord = { id, title, body, pinned: false, archived: false, revision: 1, tasks: [], activity: [], created: stamp, updated: stamp };
          appendActivity(note, actor, `created note "${title}"`); store.notes.push(note); await saveStore(store);
          return result(`Created ${id}.${checklistNudge(body)}`, { note: id, revision: note.revision });
        }
        if (params.action === "list") {
          const notes = visibleNotes(store, params.folder, params.query);
          return result(formatList(notes, params.folder === ARCHIVE || Boolean(params.folder?.startsWith(`${ARCHIVE}/`))), { count: notes.length });
        }
        if (params.action === "tasks") {
          if (params.folder === ARCHIVE || params.folder?.startsWith(`${ARCHIVE}/`)) throw new Error("Archived tasks are available through list/read, not the default task roll-up");
          const notes = params.note ? [resolveNote(store, params.note)] : visibleNotes(store, params.folder);
          const needle = String(params.query || "").trim().toLowerCase(); const session = String(params.session || "").trim().toLowerCase();
          const groups: string[] = []; let count = 0;
          for (const note of notes.filter((candidate) => !candidate.archived)) {
            const matches = note.tasks.filter((task) => (!params.status || params.status === "open" && !task.done || params.status === "done" && task.done || params.status === "overdue" && overdue(task) || params.status === "blocked" && blocked(store, note, task)) && (!session || task.session?.toLowerCase() === session) && (!needle || task.text.toLowerCase().includes(needle)));
            if (matches.length) { groups.push(`${noteLink(note.id)}\n${matches.map((task) => `  ${taskLine(store, note, task)}`).join("\n")}`); count += matches.length; }
          }
          return result(groups.join("\n\n") || "No tasks match those filters.", { count });
        }

        const note = resolveNote(store, params.note);
        if (params.action === "read") return result(formatRead(store, note), { note: note.id, revision: note.revision, ...counts(note) });
        if (params.action === "add") {
          if (note.archived) throw new Error("Archived notes are read-only");
          if (note.tasks.length >= MAX_TASKS) throw new Error(`A note is limited to ${MAX_TASKS} tasks`);
          const task = emptyTask(shortText(params.text, "text"), { ...(params.group === undefined ? {} : { group: groupValue(params.group) }), due: dueValue(params.due) ?? null, session: optionalText(params.session, "session") ?? null, waiting: optionalText(params.waiting, "waiting") ?? null });
          note.tasks.push(task); mutate(store, note, actor, `added task "${task.text}"`, task.id); await saveStore(store);
          return result(`Added ${task.id} to ${note.id}: ${task.text}`, { note: note.id, task: task.id, revision: note.revision });
        }
        if (params.action === "check" || params.action === "uncheck") {
          if (note.archived) throw new Error("Archived notes are read-only");
          const task = resolveTask(note, params.task); task.done = params.action === "check"; task.completed = task.done ? now() : null;
          mutate(store, note, actor, `${task.done ? "checked" : "unchecked"} "${task.text}"`, task.id); await saveStore(store);
          return result(`${task.done ? "Checked" : "Unchecked"} ${task.id} in ${note.id}`, { note: note.id, task: task.id, revision: note.revision });
        }
        if (params.action === "update") {
          if (note.archived) throw new Error("Archived notes are read-only");
          const task = resolveTask(note, params.task);
          if (params.text !== undefined) task.text = shortText(params.text, "text");
          if (params.group !== undefined) task.group = groupValue(params.group);
          const due = dueValue(params.due); if (due !== undefined) task.due = due;
          const session = optionalText(params.session, "session"); if (session !== undefined) task.session = session;
          const waiting = optionalText(params.waiting, "waiting"); if (waiting !== undefined) task.waiting = waiting;
          mutate(store, note, actor, `updated task "${task.text}"`, task.id); await saveStore(store);
          return result(`Updated ${task.id} in ${note.id}`, { note: note.id, task: task.id, revision: note.revision });
        }
        if (params.action === "write") {
          if (note.archived) throw new Error("Archived notes are read-only");
          if (params.revision === undefined) throw new Error(`write requires revision ${note.revision}; re-read the note and retry`);
          // Stateless operations cannot retain a prior content hash. External edits
          // are always re-read, and editors may bump this frontmatter revision when
          // they need the write guard to reject an agent's previously-read value.
          if (params.revision !== note.revision) throw new Error(`Stale revision ${params.revision}; current revision is ${note.revision}. Re-read the note and retry your write.`);
          if (params.body === undefined) throw new Error("body is required for action \"write\"");
          const body = String(params.body); assertBody(body); note.body = body;
          mutate(store, note, actor, "replaced note body"); await saveStore(store);
          return result(`Wrote body of ${note.id} at revision ${note.revision}.${checklistNudge(body)}`, { note: note.id, revision: note.revision });
        }
        if (params.action === "link" || params.action === "unlink") {
          if (note.archived) throw new Error("Archived notes are read-only");
          const task = resolveTask(note, params.task); const type = params.type as RelationType | undefined;
          if (!type) throw new Error("type is required for link/unlink");
          if (params.action === "link") pruneDangling(store, note);
          let to: string;
          if (params.action === "link") to = resolveTarget(store, params.to).ref;
          else { try { to = resolveTarget(store, params.to).ref; } catch { to = shortText(params.to, "to"); } }
          const index = task.relations.findIndex((relation) => relation.type === type && relation.to === to);
          if (params.action === "link") {
            if (index >= 0) throw new Error(`Relation already exists: ${type} ${to}`);
            if (task.relations.length >= MAX_RELATIONS) throw new Error(`A task is limited to ${MAX_RELATIONS} relations`);
            task.relations.push({ type, to });
          } else {
            if (index < 0) throw new Error(`No relation matches ${type} ${to}`);
            task.relations.splice(index, 1);
          }
          mutate(store, note, actor, `${params.action === "link" ? "linked" : "unlinked"} ${type} ${to}`, task.id); await saveStore(store);
          return result(`${params.action === "link" ? "Linked" : "Unlinked"} ${reference(note.id, task.id)} ${type} ${to}`, { note: note.id, task: task.id, to, revision: note.revision });
        }
        if (params.action === "log") {
          const text = shortText(params.text, "text"); const task = params.task === undefined ? undefined : resolveTask(note, params.task);
          mutate(store, note, actor, text, task?.id); await saveStore(store);
          return result(`Logged to ${note.id}: ${text}`, { note: note.id, task: task?.id, revision: note.revision });
        }
        if (params.action === "pin" || params.action === "unpin") {
          if (note.archived) throw new Error("Archived notes cannot be pinned");
          note.pinned = params.action === "pin"; mutate(store, note, actor, `${note.pinned ? "pinned" : "unpinned"} note "${note.title}"`); await saveStore(store);
          return result(`${note.pinned ? "Pinned" : "Unpinned"} ${note.id}`, { note: note.id, revision: note.revision });
        }
        if (params.action === "archive") {
          if (note.archived) throw new Error(`Note "${note.id}" is already archived`);
          note.archived = true; note.pinned = false; mutate(store, note, actor, `archived note "${note.title}"`); await saveStore(store);
          return result(`Archived ${note.id}`, { note: note.id, revision: note.revision });
        }
        if (params.action === "move") {
          if (note.archived) throw new Error("Archived notes cannot be moved");
          const folder = params.folder === undefined ? note.id.split("/").slice(0, -1).join("/") : cleanId(params.folder, "folder", true);
          const title = params.title === undefined ? note.title : shortText(params.title, "title");
          const leaf = params.title === undefined ? basename(note.id) : slugify(title);
          const destination = `${folder ? `${folder}/` : ""}${leaf}`;
          if (destination === note.id && title === note.title) throw new Error("Move destination and title are unchanged");
          if (destination !== note.id && store.notes.some((candidate) => candidate.id === destination)) throw new Error(`Note "${destination}" already exists`);
          const old = note.id; note.id = destination; note.title = title;
          for (const owner of store.notes) for (const task of owner.tasks) for (const relation of task.relations) {
            const split = splitReference(relation.to); if (split?.noteId === old) relation.to = reference(destination, split.taskId);
          }
          mutate(store, note, actor, `moved note from ${old} to ${destination}`); await saveStore(store);
          return result(`Moved ${old} to ${destination}`, { note: destination, revision: note.revision });
        }
        throw new Error(`Unsupported notepad action: ${params.action}`);
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const web = ctx.ui.web as typeof ctx.ui.web | undefined;
    const capabilities = web?.capabilities;
    const currentSessionId = String(ctx.sessionManager?.getSessionId?.() || "") || undefined;
    const panelSessionId = currentSessionId || `anonymous-${randomBytes(8).toString("hex")}`;
    const compatible = capabilities?.apiVersion === 1 && capabilities.slots.includes("panel") && capabilities.slots.includes("fab") && capabilities.kinds.includes("rendered") && capabilities.kinds.includes("static") && typeof web?.contribute === "function" && typeof web?.update === "function";
    if (!compatible) { ctx.ui.notify("Global notepad UI requires a newer pi-web contribution API. The notepad tool remains available.", "warning"); return; }
    // Initialize before publishing the launcher. Otherwise a first-open render can
    // initialize the store, emit its own invalidation, and race the in-flight view.
    await withNoteQueue(() => ensureInitialized());
    await web.registerSettings({ id: SETTINGS_ID, title: "Global notepad", schemaVersion: 1, fields: [{ key: "pinnedInPrompt", type: "toggle", label: "Share pinned with the model", description: "Append pinned note titles and open task lines (up to 10 lines) to the prompt.", default: false }] });
    const invalidate = () => ctx.ui.web.update(PANEL_KEY); storeInvalidators.add(invalidate); invalidatorByWebUi.set(ctx.ui.web, invalidate);
    if (!panelStateBySession.has(panelSessionId)) rememberPanelState(panelSessionId, defaultTreeState());
    ctx.ui.web.contribute(PANEL_KEY, { slot: "panel", kind: "rendered", title: "Global notepad", label: "Notepad", icon: "notebook-pen",
      async render(event) { return withNoteQueue(async () => {
        await ensureInitialized();
        const store = await loadStore(); const data = eventPayload(event); const actor = sessionSource(ctx as any, "user");
        const previous = panelStateBySession.get(panelSessionId) || defaultTreeState();
        const back = previous.kind === "tree" ? previous : previous.kind === "note" ? previous.back : previous.note.back;
        const currentSession: PanelSessionContext = { id: currentSessionId, name: (typeof (pi as any).getSessionName === "function" ? (pi as any).getSessionName() : undefined) || undefined };
        const renderState = (state: PanelViewState) => renderPanelState(store, state, currentSession);
        const remember = (state: PanelViewState) => rememberPanelState(panelSessionId, withoutTransientHighlight(state));
        const show = (state: PanelViewState) => { remember(state); return renderState(state); };
        // The server bridge normalizes a missing browser event to a truthy
        // { action: undefined, payload: undefined, fields: undefined } envelope.
        if (!event?.action) { rememberPanelState(panelSessionId, previous); return renderState(previous); }
        const action = event.action;
        try {
          if (action === "deep-link") {
            let note: NoteRecord;
            try { note = resolveNote(store, data.note); }
            catch { return show({ kind: "tree", archived: false, query: "", status: `Deep link target not found: ${String(data.note || "unknown note")}.` }); }
            const requestedTask = typeof data.task === "string" ? data.task : "";
            const exactTask = note.tasks.find((task) => task.id === requestedTask);
            if (exactTask) return show({ kind: "note", noteId: note.id, back, highlight: { task: exactTask.id } });
            const requestedHeading = typeof data.h === "string" ? data.h.toLowerCase() : "";
            const hasHeading = requestedHeading && note.body.split("\n").some((line) => {
              const heading = line.match(/^#{1,6}\s+(.+)$/);
              return Boolean(heading && headingSlug(heading[1]) === requestedHeading);
            });
            return show({ kind: "note", noteId: note.id, back, highlight: hasHeading ? { heading: requestedHeading } : { top: true } });
          }
          if (action === "view") return show(defaultTreeState());
          if (action === "back-tree") return show(back);
          if (action === "show-archive") return show({ kind: "tree", archived: true, query: "" });
          if (action === "filter-tree") return show({ kind: "tree", archived: Boolean(data.archived), query: firstField(event, "query") || "" });
          if (action === "create-note") {
            if (store.notes.filter((candidate) => !candidate.archived).length >= MAX_ACTIVE_NOTES) throw new Error(`The notepad already has ${MAX_ACTIVE_NOTES} active notes; archive one first`);
            const title = shortText(firstField(event, "title"), "title"); const folder = cleanId(firstField(event, "folder") || "", "folder", true);
            const id = `${folder ? `${folder}/` : ""}${slugify(title)}`;
            if (store.notes.some((candidate) => candidate.id === id)) throw new Error(`Note "${id}" already exists`);
            const stamp = now(); const note: NoteRecord = { id, title, body: "", pinned: false, archived: false, revision: 1, tasks: [], activity: [], created: stamp, updated: stamp };
            appendActivity(note, actor, `created note "${title}"`); store.notes.push(note);
            const next: NoteViewState = { kind: "note", noteId: note.id, back, status: "Note created." }; rememberPanelState(panelSessionId, next);
            await saveStore(store); return renderState(next);
          }
          if (action === "open-note") { const note = resolveNote(store, data.note); return show({ kind: "note", noteId: note.id, back }); }
          if (action === "jump-task") { const target = findReference(store, String(data.to)); if (!target) throw new Error(`Broken relation target ${data.to}`); return show({ kind: "note", noteId: target.note.id, back, highlight: { task: target.task.id } }); }
          if (action === "quick-add") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error("Archived notes are read-only"); if (note.tasks.length >= MAX_TASKS) throw new Error(`A note is limited to ${MAX_TASKS} tasks`);
            const task = emptyTask(shortText(firstField(event, "text"), "text")); note.tasks.push(task); mutate(store, note, actor, `added task "${task.text}"`, task.id);
            const next: NoteViewState = { kind: "note", noteId: note.id, back, status: "Task added.", highlight: { task: task.id } }; remember(next);
            await saveStore(store); return renderState(next);
          }
          if (action === "toggle-task") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error("Archived notes are read-only"); const task = resolveTask(note, data.task);
            task.done = !task.done; task.completed = task.done ? now() : null; mutate(store, note, actor, `${task.done ? "checked" : "unchecked"} "${task.text}"`, task.id);
            const next: NoteViewState = { kind: "note", noteId: note.id, back, status: task.done ? "Task completed." : "Task reopened.", highlight: { task: task.id } }; remember(next);
            await saveStore(store); return renderState(next);
          }
          if (action === "edit-task") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error("Archived notes are read-only"); const task = resolveTask(note, data.task);
            const noteState: NoteViewState = { kind: "note", noteId: note.id, back }; return show({ kind: "edit", note: noteState, taskId: task.id });
          }
          if (action === "save-task-edit") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error("Archived notes are read-only"); const task = resolveTask(note, data.task);
            task.text = shortText(firstField(event, "text"), "text"); task.group = groupValue(firstField(event, "group")); task.due = dueValue(firstField(event, "due")) ?? null; task.session = optionalText(firstField(event, "session"), "session") ?? null; task.waiting = optionalText(firstField(event, "waiting"), "waiting") ?? null;
            mutate(store, note, actor, `updated task "${task.text}"`, task.id);
            const next: NoteViewState = { kind: "note", noteId: note.id, back, status: "Task saved.", highlight: { task: task.id } }; remember(next);
            await saveStore(store); return renderState(next);
          }
          if (action === "pin-note" || action === "unpin-note") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error("Archived notes cannot be pinned"); note.pinned = action === "pin-note"; mutate(store, note, actor, `${note.pinned ? "pinned" : "unpinned"} note "${note.title}"`);
            const status = note.pinned ? "Pinned." : "Unpinned.";
            const next: PanelViewState = data.reopen ? { kind: "note", noteId: note.id, back, status } : { ...back, status };
            rememberPanelState(panelSessionId, next); await saveStore(store); return renderState(next);
          }
          if (action === "archive-note") {
            const note = resolveNote(store, data.note); if (note.archived) throw new Error(`Note "${note.id}" is already archived`); note.archived = true; note.pinned = false; mutate(store, note, actor, `archived note "${note.title}"`);
            const next: TreeViewState = { ...back, archived: false, status: `Archived ${note.title}.`, undoNote: note.id }; rememberPanelState(panelSessionId, next);
            await saveStore(store); return renderState(next);
          }
          if (action === "unarchive-note") {
            const note = resolveNote(store, data.note); if (!note.archived) throw new Error(`Note "${note.id}" is not archived`); note.archived = false; mutate(store, note, actor, `unarchived note "${note.title}"`);
            const cleanBack: TreeViewState = { ...back, status: undefined, undoNote: undefined };
            const next: NoteViewState = { kind: "note", noteId: note.id, back: cleanBack, status: "Archive undone." }; rememberPanelState(panelSessionId, next);
            await saveStore(store); return renderState(next);
          }
          return show(defaultTreeState());
        } catch (error) {
          const status = `Error: ${describeError(error)}`;
          if (previous.kind === "note") return show({ ...previous, status });
          if (previous.kind === "edit") return show({ ...previous.note, status });
          return show({ ...previous, status });
        }
      }); },
    });
    ctx.ui.web.contribute(`${PANEL_KEY}-launcher`, { slot: "fab", kind: "static", title: "Global notepad", label: "Notepad", icon: "notebook-pen", opens: PANEL_KEY });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const { values } = await ctx.ui.web.getSettings(SETTINGS_ID); if (!values?.pinnedInPrompt) return;
      return await withNoteQueue(async () => { await ensureInitialized(); const store = await loadStore(); const lines: string[] = [];
        for (const note of store.notes.filter((candidate) => candidate.pinned && !candidate.archived)) { if (lines.length >= MAX_PROMPT_LINES) break; lines.push(`- ${note.title}`); for (const task of note.tasks.filter((candidate) => !candidate.done)) { if (lines.length >= MAX_PROMPT_LINES) break; lines.push(`  - [ ] ${task.text} (${task.id})`); } }
        if (lines.length) return { systemPrompt: `${event.systemPrompt}\n\n# Pinned notepad jobs\n${lines.join("\n")}\nUse the notepad tool for bodies, fields, relations, and activity.` };
      });
    } catch { return; }
  });

  pi.on("session_shutdown", (_event, ctx) => { const invalidate = invalidatorByWebUi.get(ctx.ui.web); if (invalidate) storeInvalidators.delete(invalidate); invalidatorByWebUi.delete(ctx.ui.web); const panelSessionId = String(ctx.sessionManager?.getSessionId?.() || ""); if (panelSessionId) panelStateBySession.delete(panelSessionId); if (typeof ctx.ui.web.contribute === "function") { ctx.ui.web.contribute(`${PANEL_KEY}-launcher`, undefined); ctx.ui.web.contribute(PANEL_KEY, undefined); } });
}
