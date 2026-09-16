import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionDraftStore } from "../src/drafts/sessionDraftStore.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

beforeAll(() => {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => undefined,
  });
});

const quote = { id: 3, quote: "excerpt", question: "why?", sourceMessageId: "message", startOffset: 1, endOffset: 8 };
const attachment = { type: "file" as const, id: "file-1", name: "draft.png", mediaType: "image/png", bytes: 12, path: "/tmp/draft.png", contentUrl: "/api/attachments/file-1" };

describe("session draft store", () => {
  it("migrates global text once and session-owned attachments and quotes", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-composer-draft", "legacy text");
    storage.setItem("pi-web-composer-attachments-v1", JSON.stringify({ sessionId: "b", attachments: [attachment] }));
    storage.setItem("pi-web-quote-reply-drafts-v1", JSON.stringify({ b: [quote] }));

    const store = createSessionDraftStore(storage);
    store.attachInitialSession("a");

    expect(store.get("a").text).toBe("legacy text");
    expect(store.get("b")).toMatchObject({ attachments: [attachment], quoteReplies: [quote] });
    expect(storage.getItem("pi-web-composer-draft")).toBeNull();
    expect(storage.getItem("pi-web-composer-attachments-v1")).toBeNull();
    expect(storage.getItem("pi-web-quote-reply-drafts-v1")).toBeNull();
  });

  it.each([
    "null",
    "[]",
    JSON.stringify({ "session-a": "invalid" }),
    JSON.stringify({ "session-a": [{ ...quote, id: "invalid" }] }),
  ])("preserves structurally invalid legacy quote records through initialization and flush: %s", (legacyValue) => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-quote-reply-drafts-v1", legacyValue);

    const store = createSessionDraftStore(storage);
    store.attachInitialSession("a");
    store.update("a", { text: "safe edit" }, true);

    expect(storage.getItem("pi-web-quote-reply-drafts-v1")).toBe(legacyValue);
    expect(storage.getItem("pi-web-quote-reply-drafts-v1-malformed-backup")).toBe(legacyValue);
  });

  it("preserves an entire legacy attachment record when any element is invalid", () => {
    const storage = new MemoryStorage();
    const legacyValue = JSON.stringify({ sessionId: "b", attachments: [attachment, { ...attachment, bytes: "invalid" }] });
    storage.setItem("pi-web-composer-attachments-v1", legacyValue);

    const store = createSessionDraftStore(storage);
    store.attachInitialSession("a");
    store.update("a", { text: "safe edit" }, true);

    expect(store.get("b").attachments).toEqual([]);
    expect(storage.getItem("pi-web-composer-attachments-v1")).toBe(legacyValue);
    expect(storage.getItem("pi-web-composer-attachments-v1-malformed-backup")).toBe(legacyValue);
  });

  it("preserves malformed legacy records through initialization and flush", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-composer-attachments-v1", "{broken attachment");
    storage.setItem("pi-web-quote-reply-drafts-v1", "{broken quote");

    const store = createSessionDraftStore(storage);
    store.attachInitialSession("a");
    store.update("a", { text: "safe edit" }, true);

    expect(storage.getItem("pi-web-composer-attachments-v1")).toBe("{broken attachment");
    expect(storage.getItem("pi-web-quote-reply-drafts-v1")).toBe("{broken quote");
    expect(store.get("a").text).toBe("safe edit");
  });

  it("flushes only explicitly dirty sessions and retains newer other-tab data", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-session-drafts-v1", JSON.stringify({ version: 1, sessions: {
      a: { text: "old a" }, b: { text: "old b" },
    } }));
    const store = createSessionDraftStore(storage);

    storage.setItem("pi-web-session-drafts-v1", JSON.stringify({ version: 1, sessions: {
      a: { text: "old a" }, b: { text: "new b" },
    } }));
    store.update("a", { text: "new a" }, true);

    const persisted = JSON.parse(storage.getItem("pi-web-session-drafts-v1")!);
    expect(persisted.sessions.a.text).toBe("new a");
    expect(persisted.sessions.b.text).toBe("new b");
  });

  it("refreshes a clean cached session before a field-scoped update", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-session-drafts-v1", JSON.stringify({ version: 1, sessions: {
      a: { text: "old", attachments: [], quoteReplies: [] },
    } }));
    const store = createSessionDraftStore(storage);

    storage.setItem("pi-web-session-drafts-v1", JSON.stringify({ version: 1, sessions: {
      a: { text: "other-tab text", attachments: [], quoteReplies: [quote] },
    } }));
    expect(store.get("a")).toMatchObject({ text: "other-tab text", quoteReplies: [quote] });
    store.update("a", { attachments: [attachment] }, true);

    expect(JSON.parse(storage.getItem("pi-web-session-drafts-v1")!).sessions.a).toMatchObject({
      text: "other-tab text", attachments: [attachment], quoteReplies: [quote],
    });
  });

  it("backs up malformed unified state and resumes persistence", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web-session-drafts-v1", "{broken unified state");
    const store = createSessionDraftStore(storage);

    store.update("a", { text: "recoverable" }, true);

    expect(storage.getItem("pi-web-session-drafts-v1-malformed-backup")).toBe("{broken unified state");
    expect(JSON.parse(storage.getItem("pi-web-session-drafts-v1")!).sessions.a.text).toBe("recoverable");
  });

  it("removes fully-empty drafts instead of accumulating one record per visited session", () => {
    const storage = new MemoryStorage();
    const store = createSessionDraftStore(storage);
    store.update("a", { text: "sent later" }, true);
    store.update("b", { text: "kept" }, true);
    store.discard("a");

    const persisted = JSON.parse(storage.getItem("pi-web-session-drafts-v1")!);
    expect(Object.keys(persisted.sessions)).toEqual(["b"]);
    expect(store.get("a")).toEqual({ text: "", attachments: [], quoteReplies: [] });
  });

  it("keeps updates bound to their explicit session owner", () => {
    const storage = new MemoryStorage();
    const store = createSessionDraftStore(storage);
    store.update("a", { text: "draft a", attachments: [attachment] }, true);
    store.update("b", { text: "draft b", quoteReplies: [quote] }, true);

    expect(store.get("a")).toMatchObject({ text: "draft a", attachments: [attachment], quoteReplies: [] });
    expect(store.get("b")).toMatchObject({ text: "draft b", attachments: [], quoteReplies: [quote] });
  });
});
