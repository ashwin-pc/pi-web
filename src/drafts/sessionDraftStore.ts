import type { FileAttachment } from "../app/types.js";

export type StoredQuoteDraft = {
  id: number;
  quote: string;
  question: string;
  sourceMessageId?: string;
  startOffset: number;
  endOffset: number;
};

export type SessionDraft = {
  text: string;
  attachments: FileAttachment[];
  quoteReplies: StoredQuoteDraft[];
};

type StoredState = { version: 1; sessions: Record<string, Partial<SessionDraft>> };

const storageKey = "pi-web-session-drafts-v1";
/** Debounce window for non-immediate updates; e2e tests stretch this exact value. */
export const sessionDraftPersistDelayMs = 120;
const legacyTextKey = "pi-web-composer-draft";
const legacyAttachmentsKey = "pi-web-composer-attachments-v1";
const legacyQuotesKey = "pi-web-quote-reply-drafts-v1";
const emptyDraft = (): SessionDraft => ({ text: "", attachments: [], quoteReplies: [] });

function validAttachment(item: unknown): item is FileAttachment {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<FileAttachment>;
  return typeof value.id === "string" && typeof value.name === "string"
    && typeof value.mediaType === "string" && typeof value.bytes === "number"
    && typeof value.path === "string" && typeof value.contentUrl === "string";
}

function validQuote(item: unknown): item is StoredQuoteDraft {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<StoredQuoteDraft>;
  return Number.isSafeInteger(value.id) && typeof value.quote === "string"
    && typeof value.question === "string"
    && (value.sourceMessageId === undefined || typeof value.sourceMessageId === "string")
    && Number.isSafeInteger(value.startOffset) && Number.isSafeInteger(value.endOffset);
}

export type SessionDraftStore = ReturnType<typeof createSessionDraftStore>;

export function createSessionDraftStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage) {
  const sessions = new Map<string, SessionDraft>();
  const dirtyFields = new Map<string, Set<keyof SessionDraft>>();
  let timer: number | undefined;
  let storageAvailable = true;
  let initialSessionAttached = false;
  let malformedStoredState: string | undefined;
  const malformedLegacy = new Map<string, string>();
  const migratedLegacy = new Set<string>();
  const legacyText = safeGet(legacyTextKey);

  function safeGet(key: string) {
    try { return storage.getItem(key); } catch { storageAvailable = false; return null; }
  }

  function normalize(value: Partial<SessionDraft> | undefined): SessionDraft {
    return {
      text: typeof value?.text === "string" ? value.text : "",
      attachments: Array.isArray(value?.attachments) ? value.attachments.filter(validAttachment) : [],
      quoteReplies: Array.isArray(value?.quoteReplies) ? value.quoteReplies.filter(validQuote) : [],
    };
  }

  const initialStoredState = safeGet(storageKey);
  try {
    if (initialStoredState) {
      const parsed = JSON.parse(initialStoredState) as Partial<StoredState>;
      if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        for (const [id, draft] of Object.entries(parsed.sessions)) if (id) sessions.set(id, normalize(draft));
      } else malformedStoredState = initialStoredState;
    }
  } catch { malformedStoredState = initialStoredState || undefined; }

  // Session-owned legacy records can be imported immediately. The old global
  // text is deliberately attached only when the initial active session is known.
  const legacyQuotes = safeGet(legacyQuotesKey);
  try {
    const parsed: unknown = JSON.parse(legacyQuotes || "{}");
    const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : undefined;
    const valid = entries?.every(([id, quotes]) => Boolean(id) && Array.isArray(quotes) && quotes.every(validQuote));
    if (!entries || !valid) {
      if (legacyQuotes) malformedLegacy.set(legacyQuotesKey, legacyQuotes);
    } else {
      for (const [id, value] of entries) {
        const quotes = value as StoredQuoteDraft[];
        const draft = sessions.get(id) || emptyDraft();
        if (!draft.quoteReplies.length) draft.quoteReplies = quotes;
        sessions.set(id, draft);
        const fields = dirtyFields.get(id) || new Set<keyof SessionDraft>();
        fields.add("quoteReplies");
        dirtyFields.set(id, fields);
      }
      if (legacyQuotes) migratedLegacy.add(legacyQuotesKey);
    }
  } catch { if (legacyQuotes) malformedLegacy.set(legacyQuotesKey, legacyQuotes); }
  const legacyAttachments = safeGet(legacyAttachmentsKey);
  try {
    const parsed = JSON.parse(legacyAttachments || "null") as { sessionId?: unknown; attachments?: unknown } | null;
    if (parsed && typeof parsed.sessionId === "string" && parsed.sessionId && Array.isArray(parsed.attachments) && parsed.attachments.every(validAttachment)) {
      const draft = sessions.get(parsed.sessionId) || emptyDraft();
      if (!draft.attachments.length) draft.attachments = parsed.attachments;
      sessions.set(parsed.sessionId, draft);
      const fields = dirtyFields.get(parsed.sessionId) || new Set<keyof SessionDraft>();
      fields.add("attachments");
      dirtyFields.set(parsed.sessionId, fields);
      migratedLegacy.add(legacyAttachmentsKey);
    } else if (legacyAttachments) malformedLegacy.set(legacyAttachmentsKey, legacyAttachments);
  } catch { if (legacyAttachments) malformedLegacy.set(legacyAttachmentsKey, legacyAttachments); }

  function attachInitialSession(sessionId: string) {
    if (initialSessionAttached || !sessionId) return;
    initialSessionAttached = true;
    if (legacyText) {
      const draft = sessions.get(sessionId) || emptyDraft();
      if (!draft.text) draft.text = legacyText;
      sessions.set(sessionId, draft);
      const fields = dirtyFields.get(sessionId) || new Set<keyof SessionDraft>();
      fields.add("text");
      dirtyFields.set(sessionId, fields);
      migratedLegacy.add(legacyTextKey);
    }
    flush();
  }

  function get(sessionId: string): SessionDraft {
    if (!dirtyFields.has(sessionId) && storageAvailable && !malformedStoredState) {
      try {
        const latest = JSON.parse(storage.getItem(storageKey) || "null") as Partial<StoredState> | null;
        const external = latest?.version === 1 && latest.sessions && typeof latest.sessions === "object"
          ? latest.sessions[sessionId]
          : undefined;
        if (external) sessions.set(sessionId, normalize(external));
      } catch { /* Keep serving the in-memory store. */ }
    }
    return normalize(sessions.get(sessionId));
  }

  function update(sessionId: string, patch: Partial<SessionDraft>, immediate = false) {
    if (!sessionId) return;
    sessions.set(sessionId, normalize({ ...get(sessionId), ...patch }));
    const fields = dirtyFields.get(sessionId) || new Set<keyof SessionDraft>();
    for (const field of Object.keys(patch) as Array<keyof SessionDraft>) fields.add(field);
    dirtyFields.set(sessionId, fields);
    if (immediate) flush(); else schedule();
  }

  function discard(sessionId: string, fields: Array<keyof SessionDraft> = ["text", "attachments", "quoteReplies"]) {
    if (!sessionId) return;
    const draft = get(sessionId);
    for (const field of fields) {
      if (field === "text") draft.text = "";
      else draft[field] = [];
    }
    sessions.set(sessionId, draft);
    const dirty = dirtyFields.get(sessionId) || new Set<keyof SessionDraft>();
    for (const field of fields) dirty.add(field);
    dirtyFields.set(sessionId, dirty);
    flush();
  }

  function schedule() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flush, sessionDraftPersistDelayMs);
  }

  function flush() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    if (!storageAvailable) return;
    try {
      // Retain sessions written by another tab since this store was created;
      // explicitly-owned in-memory updates win for the sessions they touched.
      const latest = malformedStoredState
        ? null
        : JSON.parse(storage.getItem(storageKey) || "null") as Partial<StoredState> | null;
      const external = latest?.version === 1 && latest.sessions && typeof latest.sessions === "object" ? latest.sessions : {};
      const record: Record<string, Partial<SessionDraft>> = { ...external };
      for (const [id, fields] of dirtyFields) {
        const current = sessions.get(id)!;
        const merged = normalize(external[id]);
        for (const field of fields) {
          if (field === "text") merged.text = current.text;
          else if (field === "attachments") merged.attachments = current.attachments;
          else merged.quoteReplies = current.quoteReplies;
        }
        // Drop fully-empty drafts so sent/discarded sessions do not accumulate forever.
        if (!merged.text && !merged.attachments.length && !merged.quoteReplies.length) delete record[id];
        else record[id] = merged;
      }
      if (malformedStoredState) {
        storage.setItem(`${storageKey}-malformed-backup`, malformedStoredState);
        malformedStoredState = undefined;
      }
      storage.setItem(storageKey, JSON.stringify({ version: 1, sessions: record } satisfies StoredState));
      dirtyFields.clear();
      for (const [key, raw] of malformedLegacy) storage.setItem(`${key}-malformed-backup`, raw);
      for (const key of migratedLegacy) storage.removeItem(key);
      malformedLegacy.clear();
      migratedLegacy.clear();
    } catch { storageAvailable = false; }
  }

  window.addEventListener("pagehide", flush);
  return { attachInitialSession, get, update, discard, flush };
}
