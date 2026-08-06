/**
 * global-notepad — installable pi-web extension (opt-in)
 *
 * A persistent, machine-global day planner shared by every pi-web conversation,
 * stored as structured entries in ~/.pi/agent/notepad.json (override with
 * PI_WEB_NOTEPAD_FILE). Delete this file from your extensions directory to
 * remove the feature entirely; nothing notepad-specific lives in core pi-web.
 *
 * Design principles:
 * - Provenance: every entry records who wrote it (user or agent), from which
 *   session, in which project, and when. The panel links entries back to the
 *   conversation that created them.
 * - Careful context: the model does NOT see notepad contents automatically.
 *   Its only default system-prompt footprint is the tool's own one-line
 *   snippet. An optional settings toggle (default OFF) can share pinned
 *   entries with the model.
 * - Anti-mess: lifecycle (open/done/dropped), auto-archive of old closed
 *   entries, duplicate detection, and caps keep the active set small.
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { PiWebExtensionAPI, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

const PANEL_KEY = "global-notepad";
const SETTINGS_ID = "global-notepad.settings";
const MAX_TEXT_CHARS = 2_000;
const MAX_ACTIVE_ENTRIES = 200;
const MAX_TAGS = 8;
const ARCHIVE_AFTER_DAYS = 7;
const MAX_PINNED_IN_PROMPT = 10;

type EntryKind = "task" | "note" | "decision";
type EntryStatus = "open" | "done" | "dropped";

type NotepadEntry = {
  id: string;
  text: string;
  kind: EntryKind;
  status: EntryStatus;
  pinned: boolean;
  tags: string[];
  due?: string;
  created: string;
  updated: string;
  source: { by: "user" | "agent"; sessionId?: string; sessionName?: string; cwd?: string };
};

type NotepadStore = { version: 1; entries: NotepadEntry[] };

function storePath() {
  return process.env.PI_WEB_NOTEPAD_FILE || join(homedir(), ".pi", "agent", "notepad.json");
}

function archivePath() {
  return storePath().replace(/\.json$/, "") + "-archive.jsonl";
}

function legacyMarkdownPath() {
  return join(dirname(storePath()), "notepad.md");
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Serialize read-modify-write cycles within this server process so concurrent
// sessions cannot drop each other's changes.
let noteQueue: Promise<unknown> = Promise.resolve();
function withNoteQueue<T>(work: () => Promise<T>): Promise<T> {
  const next = noteQueue.then(work, work);
  noteQueue = next.catch(() => undefined);
  return next;
}

function generateId(existing: Set<string>) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `n-${randomBytes(3).toString("hex")}`;
    if (!existing.has(id)) return id;
  }
  return `n-${randomBytes(6).toString("hex")}`;
}

function normalizeEntry(raw: unknown): NotepadEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, any>;
  if (typeof entry.id !== "string" || typeof entry.text !== "string") return undefined;
  const source = entry.source && typeof entry.source === "object" ? entry.source : {};
  return {
    id: entry.id,
    text: String(entry.text).slice(0, MAX_TEXT_CHARS),
    kind: ["task", "note", "decision"].includes(entry.kind) ? entry.kind : "note",
    status: ["open", "done", "dropped"].includes(entry.status) ? entry.status : "open",
    pinned: Boolean(entry.pinned),
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag: unknown) => typeof tag === "string").slice(0, MAX_TAGS) : [],
    due: typeof entry.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.due) ? entry.due : undefined,
    created: typeof entry.created === "string" ? entry.created : new Date().toISOString(),
    updated: typeof entry.updated === "string" ? entry.updated : new Date().toISOString(),
    source: {
      by: source.by === "agent" ? "agent" : "user",
      sessionId: typeof source.sessionId === "string" ? source.sessionId : undefined,
      sessionName: typeof source.sessionName === "string" ? source.sessionName : undefined,
      cwd: typeof source.cwd === "string" ? source.cwd : undefined,
    },
  };
}

async function loadStore(): Promise<NotepadStore> {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf8"));
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.map(normalizeEntry).filter((entry: NotepadEntry | undefined): entry is NotepadEntry => Boolean(entry))
      : [];
    return { version: 1, entries };
  } catch (error: any) {
    if (error?.code === "ENOENT") return importLegacyMarkdown();
    // A corrupt store must not be silently overwritten: keep the bytes aside.
    try { await rename(storePath(), `${storePath()}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return { version: 1, entries: [] };
  }
}

/** One-time import of the earlier flat-file notepad, kept in place afterward. */
async function importLegacyMarkdown(): Promise<NotepadStore> {
  try {
    const text = (await readFile(legacyMarkdownPath(), "utf8")).trim();
    if (!text) return { version: 1, entries: [] };
    const now = new Date().toISOString();
    return {
      version: 1,
      entries: [{
        id: generateId(new Set()),
        text: text.slice(0, MAX_TEXT_CHARS),
        kind: "note",
        status: "open",
        pinned: false,
        tags: ["imported"],
        created: now,
        updated: now,
        source: { by: "user" },
      }],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

const storeInvalidators = new Set<() => void>();
const invalidatorByWebUi = new WeakMap<object, () => void>();

async function saveStore(store: NotepadStore) {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const archived = await archiveOldEntries(store);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, entries: store.entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  for (const invalidate of storeInvalidators) invalidate();
  return archived;
}

async function archiveOldEntries(store: NotepadStore) {
  const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const keep: NotepadEntry[] = [];
  const archive: NotepadEntry[] = [];
  for (const entry of store.entries) {
    const closed = entry.status !== "open";
    if (closed && Date.parse(entry.updated) < cutoff) archive.push(entry);
    else keep.push(entry);
  }
  if (archive.length) {
    await appendFile(archivePath(), archive.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    store.entries = keep;
  }
  return archive.length;
}

function normalizedText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function findDuplicate(store: NotepadStore, text: string) {
  const needle = normalizedText(text);
  return store.entries.find((entry) => entry.status !== "dropped" && normalizedText(entry.text) === needle);
}

function cleanTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tags = raw
    .map((tag) => String(tag).trim().replace(/^#/, "").slice(0, 32))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

function cleanDue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const due = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must be formatted as "YYYY-MM-DD"');
  return due;
}

function today() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dueRank(entry: NotepadEntry) {
  if (!entry.due) return 3;
  if (entry.due < today()) return 0;
  if (entry.due === today()) return 1;
  return 2;
}

function sortEntries(entries: NotepadEntry[]) {
  return [...entries].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || dueRank(a) - dueRank(b)
    || (a.due && b.due && a.due !== b.due ? a.due.localeCompare(b.due) : 0)
    || b.updated.localeCompare(a.updated));
}

function relativeTime(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : iso.slice(0, 10);
}

function requireEntry(store: NotepadStore, id: unknown) {
  const entry = store.entries.find((candidate) => candidate.id === String(id || "").trim());
  if (!entry) throw new Error(`No notepad entry with id "${String(id)}". Use action "list" to see current ids.`);
  return entry;
}

function touch(entry: NotepadEntry) {
  entry.updated = new Date().toISOString();
}

// --- Tool ---

const toolParameters = Type.Object({
  action: StringEnum(["add", "list", "done", "drop", "edit", "pin", "unpin"] as const),
  id: Type.Optional(Type.String({ description: "Entry id (from list), required for done/drop/edit/pin/unpin" })),
  text: Type.Optional(Type.String({ description: "Entry text (required for add, optional for edit)" })),
  kind: Type.Optional(StringEnum(["task", "note", "decision"] as const)),
  tags: Type.Optional(Type.Array(Type.String())),
  due: Type.Optional(Type.String({ description: 'Optional due date, "YYYY-MM-DD"' })),
  query: Type.Optional(Type.String({ description: "For list: case-insensitive text/tag filter" })),
  status: Type.Optional(StringEnum(["open", "done", "dropped", "all"] as const)),
});

function formatEntryLine(entry: NotepadEntry) {
  const marker = entry.status === "open" ? (entry.kind === "task" ? "☐" : "·") : entry.status === "done" ? "✓" : "✗";
  const pieces = [
    `${entry.id} ${entry.pinned ? "📌 " : ""}${marker} [${entry.kind}] ${entry.text}`,
    entry.due ? `(due ${entry.due})` : "",
    entry.tags.length ? entry.tags.map((tag) => `#${tag}`).join(" ") : "",
    `— ${entry.source.by}${entry.source.sessionName ? ` in "${entry.source.sessionName}"` : ""}, ${relativeTime(entry.updated)}`,
  ];
  return pieces.filter(Boolean).join(" ");
}

function entrySessionRefs(entries: NotepadEntry[]) {
  const seen = new Map<string, { sessionId: string; name?: string }>();
  for (const entry of entries) {
    const sessionId = entry.source.sessionId;
    if (sessionId && !seen.has(sessionId)) seen.set(sessionId, { sessionId, name: entry.source.sessionName });
  }
  return [...seen.values()].slice(0, 8);
}

// --- Panel (trusted extension HTML rendered by core pi-web) ---

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]!));
}

function firstField(event: PiWebPanelEvent | undefined, name: string) {
  const value = event?.fields?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function payloadId(event?: PiWebPanelEvent) {
  const payload = event?.payload;
  if (payload && typeof payload === "object" && typeof (payload as any).id === "string") return (payload as any).id as string;
  throw new Error("Missing entry id");
}

const panelStyles = `
<style>
.gnp { display: grid; gap: 14px; font-size: 13.5px; }
.gnp form { margin: 0; }
.gnp .gnpQuickAdd { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
.gnp .gnpQuickAdd input[type="text"], .gnp input[type="text"], .gnp input[type="date"], .gnp select, .gnp textarea {
  box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;
  background: color-mix(in srgb, var(--panel-2) 82%, black); color: var(--text); font: inherit;
}
.gnp .gnpQuickAdd input:focus, .gnp input:focus, .gnp select:focus, .gnp textarea:focus { outline: none; border-color: var(--accent); }
.gnp h3 { margin: 6px 0 0; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.gnp ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.gnp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.gnp li.gnpPinned { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.gnp li.gnpClosed .gnpText { color: var(--muted); text-decoration: line-through; }
.gnp .gnpText { overflow-wrap: anywhere; }
.gnp .gnpMeta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; font-size: 11.5px; color: var(--muted); }
.gnp .gnpMeta a { color: inherit; text-decoration: underline dotted; }
.gnp .gnpDueSoon { color: #fbbf24; }
.gnp .gnpOverdue { color: var(--danger); }
.gnp .gnpTag { color: var(--accent); }
.gnp .gnpRowActions { display: flex; gap: 4px; }
.gnp .gnpIconButton { min-width: 26px; padding: 3px 6px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; cursor: pointer; }
.gnp .gnpIconButton:hover { border-color: var(--border); background: var(--panel-2); color: var(--text); }
.gnp .gnpCheck { margin-top: 3px; accent-color: var(--accent); }
.gnp details { border: 1px dashed var(--border); border-radius: 10px; padding: 6px 10px; }
.gnp details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.gnp .gnpEmpty { padding: 18px 4px; color: var(--muted); text-align: center; }
.gnp .gnpEditGrid { display: grid; gap: 8px; }
.gnp .gnpStatus { min-height: 16px; font-size: 12px; color: var(--muted); }
</style>`;

function renderEntryRow(entry: NotepadEntry) {
  const isOpen = entry.status === "open";
  const dueClass = entry.due && entry.due < today() ? "gnpOverdue" : entry.due === today() ? "gnpDueSoon" : "";
  const payload = escapeHtml(JSON.stringify({ id: entry.id }));
  const provenance = `${entry.source.by === "agent" ? "🤖 agent" : "👤 you"}${entry.source.cwd ? ` · ${escapeHtml(entry.source.cwd.split("/").at(-1) || "")}` : ""}`;
  const sourceLink = entry.source.sessionId
    ? `<a href="/?sessionId=${encodeURIComponent(entry.source.sessionId)}" title="Open the conversation this entry came from">${escapeHtml(entry.source.sessionName || "source session")}</a>`
    : "";
  return `<li class="${entry.pinned ? "gnpPinned" : ""} ${isOpen ? "" : "gnpClosed"}">
    ${entry.kind === "task"
      ? `<input class="gnpCheck" type="checkbox" ${isOpen ? "" : "checked"} data-web-panel-action="${isOpen ? "done" : "reopen"}" data-web-panel-payload='${payload}' aria-label="${isOpen ? "Mark done" : "Reopen"}">`
      : `<span aria-hidden="true">${entry.kind === "decision" ? "⚖️" : "🗒"}</span>`}
    <div>
      <div class="gnpText">${escapeHtml(entry.text)}</div>
      <div class="gnpMeta">
        ${entry.due ? `<span class="${dueClass}">due ${escapeHtml(entry.due)}</span>` : ""}
        ${entry.tags.map((tag) => `<span class="gnpTag">#${escapeHtml(tag)}</span>`).join("")}
        <span title="${escapeHtml(entry.created)}">${provenance}${sourceLink ? ` · ${sourceLink}` : ""} · ${escapeHtml(relativeTime(entry.updated))}</span>
      </div>
    </div>
    <div class="gnpRowActions">
      <button class="gnpIconButton" type="button" data-web-panel-action="${entry.pinned ? "unpin" : "pin"}" data-web-panel-payload='${payload}' title="${entry.pinned ? "Unpin" : "Pin as important"}">${entry.pinned ? "📌" : "📍"}</button>
      <button class="gnpIconButton" type="button" data-web-panel-action="edit-form" data-web-panel-payload='${payload}' title="Edit">✎</button>
      ${isOpen ? `<button class="gnpIconButton" type="button" data-web-panel-action="drop" data-web-panel-payload='${payload}' title="Drop (archive without completing)">✕</button>` : ""}
    </div>
  </li>`;
}

function renderSection(title: string, entries: NotepadEntry[]) {
  if (!entries.length) return "";
  return `<h3>${escapeHtml(title)}</h3><ul>${entries.map(renderEntryRow).join("")}</ul>`;
}

function renderPanel(store: NotepadStore, options: { status?: string; query?: string } = {}): PiWebPanelView {
  const query = (options.query || "").trim().toLowerCase();
  const matches = (entry: NotepadEntry) => !query
    || entry.text.toLowerCase().includes(query)
    || entry.tags.some((tag) => tag.toLowerCase().includes(query));
  const active = sortEntries(store.entries.filter((entry) => entry.status === "open" && matches(entry)));
  const closed = sortEntries(store.entries.filter((entry) => entry.status !== "open" && matches(entry)));

  const pinned = active.filter((entry) => entry.pinned);
  const tasks = active.filter((entry) => !entry.pinned && entry.kind === "task");
  const other = active.filter((entry) => !entry.pinned && entry.kind !== "task");

  const html = `${panelStyles}
  <div class="gnp">
    <form class="gnpQuickAdd" data-web-panel-action="add">
      <input type="text" name="text" placeholder="Add a task or note…" maxlength="${MAX_TEXT_CHARS}" autofocus>
      <select name="kind" aria-label="Kind">
        <option value="task">Task</option>
        <option value="note">Note</option>
        <option value="decision">Decision</option>
      </select>
      <button class="webPanelButton" type="submit" data-web-panel-action="add">Add</button>
    </form>
    <form class="gnpQuickAdd" data-web-panel-action="filter">
      <input type="text" name="query" placeholder="Filter by text or #tag…" value="${escapeHtml(options.query || "")}">
      <button class="webPanelButton" type="submit" data-web-panel-action="filter">Filter</button>
      <button class="webPanelButton" type="button" data-web-panel-action="view">Refresh</button>
    </form>
    <div class="gnpStatus" role="status">${escapeHtml(options.status || "")}</div>
    ${active.length === 0 ? `<div class="gnpEmpty">${query ? "Nothing matches this filter." : "Nothing here yet. Notes added by you or by agents in any conversation show up in this one shared planner."}</div>` : ""}
    ${renderSection("📌 Pinned", pinned)}
    ${renderSection("☐ Tasks", tasks)}
    ${renderSection("🗒 Notes & decisions", other)}
    ${closed.length ? `<details><summary>Recently closed (${closed.length})</summary><ul>${closed.map(renderEntryRow).join("")}</ul></details>` : ""}
  </div>`;
  return { title: "Global notepad", html };
}

function renderEditForm(entry: NotepadEntry): PiWebPanelView {
  const payload = escapeHtml(JSON.stringify({ id: entry.id }));
  const html = `${panelStyles}
  <div class="gnp">
    <h3>Edit ${escapeHtml(entry.id)}</h3>
    <form class="gnpEditGrid" data-web-panel-action="save-edit" data-web-panel-payload='${payload}'>
      <textarea name="text" rows="4" maxlength="${MAX_TEXT_CHARS}" autofocus>${escapeHtml(entry.text)}</textarea>
      <input type="date" name="due" value="${escapeHtml(entry.due || "")}" aria-label="Due date">
      <input type="text" name="tags" value="${escapeHtml(entry.tags.join(", "))}" placeholder="Tags, comma separated" aria-label="Tags">
      <div class="webPanelFormActions">
        <button class="webPanelButton" type="button" data-web-panel-action="view">Cancel</button>
        <button class="webPanelButton" type="submit" data-web-panel-action="save-edit" data-web-panel-payload='${payload}'>Save</button>
      </div>
    </form>
  </div>`;
  return { title: "Global notepad — edit", html };
}

// --- Extension wiring ---

export default function globalNotepad(pi: PiWebExtensionAPI) {
  const sessionSource = (ctx: { sessionManager?: any; cwd?: string }) => ({
    by: "agent" as const,
    sessionId: String(ctx.sessionManager?.getSessionId?.() || "") || undefined,
    sessionName: (typeof (pi as any).getSessionName === "function" ? (pi as any).getSessionName() : undefined) || undefined,
    cwd: ctx.cwd,
  });

  pi.registerTool({
    name: "notepad",
    label: "Notepad",
    description: [
      "The user's global notepad: a persistent day planner of tasks, notes, and decisions shared across ALL conversations and projects, with provenance (who added what, from which session).",
      'Contents are NOT loaded automatically — use action "list" first when earlier notes may matter.',
      'Actions: "add" (text, kind, tags, due), "list" (query/status filters), "done"/"drop" (close an entry by id), "edit" (change text/tags/due), "pin"/"unpin" (mark importance).',
    ].join(" "),
    promptSnippet: "Read or update the user's persistent cross-conversation notepad (day planner)",
    promptGuidelines: [
      "Use the notepad tool when the user asks to note, track, or remember something beyond this conversation, or refers to earlier notes or plans — list entries first; do not check it routinely.",
    ],
    parameters: toolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const store = await loadStore();
        const status = params.status || "open";
        const query = (params.query || "").trim().toLowerCase();
        const entries = sortEntries(store.entries.filter((entry) =>
          (status === "all" || entry.status === status)
          && (!query || entry.text.toLowerCase().includes(query) || entry.tags.some((tag) => tag.toLowerCase().includes(query)))));
        if (!entries.length) {
          return { content: [{ type: "text", text: query ? `No ${status} entries match "${params.query}".` : `The notepad has no ${status === "all" ? "" : `${status} `}entries.` }], details: {} };
        }
        const lines = entries.slice(0, 100).map(formatEntryLine);
        const summary = `${entries.length} ${status === "all" ? "" : `${status} `}entr${entries.length === 1 ? "y" : "ies"}${entries.length > 100 ? " (showing first 100)" : ""}:`;
        return {
          content: [{ type: "text", text: [summary, ...lines].join("\n") }],
          details: { count: entries.length, sessions: entrySessionRefs(entries.slice(0, 100)) },
        };
      }

      return withNoteQueue(async () => {
        const store = await loadStore();

        if (params.action === "add") {
          const text = (params.text || "").trim();
          if (!text) throw new Error('text is required for action "add"');
          if (text.length > MAX_TEXT_CHARS) throw new Error(`Entry text is limited to ${MAX_TEXT_CHARS.toLocaleString()} characters; keep entries short and specific.`);
          const duplicate = findDuplicate(store, text);
          if (duplicate) {
            return { content: [{ type: "text", text: `Not added: an equivalent entry already exists — ${formatEntryLine(duplicate)}. Use "edit" or "done" on ${duplicate.id} instead.` }], details: { duplicateOf: duplicate.id } };
          }
          if (store.entries.filter((entry) => entry.status === "open").length >= MAX_ACTIVE_ENTRIES) {
            throw new Error(`The notepad already has ${MAX_ACTIVE_ENTRIES} open entries. List them and close or consolidate stale ones first.`);
          }
          const now = new Date().toISOString();
          const entry: NotepadEntry = {
            id: generateId(new Set(store.entries.map((candidate) => candidate.id))),
            text,
            kind: params.kind || "task",
            status: "open",
            pinned: false,
            tags: cleanTags(params.tags),
            due: cleanDue(params.due),
            created: now,
            updated: now,
            source: sessionSource(ctx as any),
          };
          store.entries.push(entry);
          await saveStore(store);
          return { content: [{ type: "text", text: `Added ${formatEntryLine(entry)}` }], details: { id: entry.id } };
        }

        const entry = requireEntry(store, params.id);
        if (params.action === "done" || params.action === "drop") {
          entry.status = params.action === "done" ? "done" : "dropped";
          entry.pinned = false;
        } else if (params.action === "pin" || params.action === "unpin") {
          entry.pinned = params.action === "pin";
        } else {
          if (params.text !== undefined) {
            const text = params.text.trim();
            if (!text) throw new Error("text cannot be empty");
            entry.text = text.slice(0, MAX_TEXT_CHARS);
          }
          if (params.kind !== undefined) entry.kind = params.kind;
          if (params.tags !== undefined) entry.tags = cleanTags(params.tags);
          if (params.due !== undefined) entry.due = cleanDue(params.due);
        }
        touch(entry);
        await saveStore(store);
        return { content: [{ type: "text", text: `Updated ${formatEntryLine(entry)}` }], details: { id: entry.id } };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.web.registerSettings({
      id: SETTINGS_ID,
      title: "Global notepad",
      schemaVersion: 1,
      fields: [{
        key: "pinnedInPrompt",
        type: "toggle",
        label: "Share pinned entries with the model",
        description: "When on, pinned notepad entries are appended to the system prompt of every conversation. Off by default: the model then only knows the notepad exists and reads it on demand.",
        default: false,
      }],
    });

    const invalidate = () => ctx.ui.web.update(PANEL_KEY);
    storeInvalidators.add(invalidate);
    invalidatorByWebUi.set(ctx.ui.web, invalidate);
    ctx.ui.web.contribute(PANEL_KEY, {
      slot: "panel",
      kind: "rendered",
      title: "Global notepad",
      label: "Notepad",
      icon: "notebook-pen",
      async render(event) {
        try {
          return await withNoteQueue(async () => {
            const store = await loadStore();
            const action = event?.action || "view";

            if (action === "add") {
              const text = (firstField(event, "text") || "").trim();
              if (!text) return renderPanel(store, { status: "Type something to add first." });
              const duplicate = findDuplicate(store, text);
              if (duplicate) return renderPanel(store, { status: `Already tracked as ${duplicate.id}.` });
              const kindField = firstField(event, "kind");
              const now = new Date().toISOString();
              store.entries.push({
                id: generateId(new Set(store.entries.map((entry) => entry.id))),
                text: text.slice(0, MAX_TEXT_CHARS),
                kind: kindField === "note" || kindField === "decision" ? kindField : "task",
                status: "open",
                pinned: false,
                tags: [],
                created: now,
                updated: now,
                source: { by: "user" },
              });
              await saveStore(store);
              return renderPanel(store, { status: "Added." });
            }

            if (action === "filter") return renderPanel(store, { query: firstField(event, "query") });

            if (["done", "reopen", "drop", "pin", "unpin"].includes(action)) {
              const entry = requireEntry(store, payloadId(event));
              if (action === "done") { entry.status = "done"; entry.pinned = false; }
              else if (action === "reopen") entry.status = "open";
              else if (action === "drop") { entry.status = "dropped"; entry.pinned = false; }
              else entry.pinned = action === "pin";
              touch(entry);
              await saveStore(store);
              return renderPanel(store, { status: `${entry.id} ${action === "reopen" ? "reopened" : action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : action}.` });
            }

            if (action === "edit-form") return renderEditForm(requireEntry(store, payloadId(event)));

            if (action === "save-edit") {
              const entry = requireEntry(store, payloadId(event));
              const text = (firstField(event, "text") || "").trim();
              if (text) entry.text = text.slice(0, MAX_TEXT_CHARS);
              entry.tags = cleanTags(firstField(event, "tags"));
              try { entry.due = cleanDue(firstField(event, "due")); }
              catch { /* leave due unchanged on malformed input */ }
              touch(entry);
              await saveStore(store);
              return renderPanel(store, { status: `${entry.id} saved.` });
            }

            return renderPanel(store);
          });
        } catch (error) {
          return renderPanel(await loadStore(), { status: `Error: ${describeError(error)}` });
        }
      },
    });

    // Entry points are explicit: this panel is reachable from the mascot FAB.
    ctx.ui.web.contribute(`${PANEL_KEY}-launcher`, {
      slot: "fab",
      kind: "static",
      title: "Global notepad",
      label: "Notepad",
      icon: "notebook-pen",
      opens: PANEL_KEY,
    });
  });

  // Optional, default-off ambient channel: only deliberately pinned entries,
  // and only when the user turns the settings toggle on.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const { values } = await ctx.ui.web.getSettings(SETTINGS_ID);
      if (!values?.pinnedInPrompt) return;
      const store = await loadStore();
      const pinned = sortEntries(store.entries.filter((entry) => entry.pinned && entry.status === "open")).slice(0, MAX_PINNED_IN_PROMPT);
      if (!pinned.length) return;
      const lines = pinned.map((entry) => `- ${entry.text}${entry.due ? ` (due ${entry.due})` : ""}`);
      return {
        systemPrompt: `${event.systemPrompt}\n\n# Pinned notepad entries\nThe user pinned these cross-conversation notes as important. The full notepad is available through the notepad tool.\n${lines.join("\n")}`,
      };
    } catch {
      return; // Never block a turn on notepad failures.
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Contribution state itself is session-scoped and released with the runtime.
    // Remove this session's invalidator so later writes only notify live hosts.
    const invalidate = invalidatorByWebUi.get(ctx.ui.web);
    if (invalidate) storeInvalidators.delete(invalidate);
    invalidatorByWebUi.delete(ctx.ui.web);
    ctx.ui.web.contribute(`${PANEL_KEY}-launcher`, undefined);
    ctx.ui.web.contribute(PANEL_KEY, undefined);
  });
}
