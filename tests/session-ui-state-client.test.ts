import { describe, expect, it } from "vitest";
import { hasAnySessionUiState, normalizeSessionUiState, parseSessionUiStateSnapshot, sessionUiMutationWarning, sessionUiUnavailableWarning, shouldMigrateLocalUiState } from "../src/app/types.js";

const localState = normalizeSessionUiState({
  lanes: [{ sessionId: "legacy-pin", lane: "pinned", since: "2025-01-01T00:00:00.000Z" }],
});

describe("session UI state first-run migration", () => {
  it("recognizes a committed create, delete, or clear warning without discarding the successful session ID", () => {
    const created = { ok: true, sessionId: "new-chat", messages: [], sessionUiStateWarning: "  preferences write failed  " };
    const deleted = { ok: true, id: "deleted-chat", disposition: "trashed", sessionUiStateWarning: "preferences delete failed" };
    const cleared = { ok: true, state: { sessionId: "cleared-chat", messages: [] }, sessionUiStateWarning: "preferences transfer failed" };
    const cwdReplacement = { ok: true, state: { sessionId: "new-cwd-chat", cwd: "/next" }, sessionUiStateWarning: "preferences transfer failed" };
    expect(sessionUiMutationWarning(created)).toBe("preferences write failed");
    expect(created.sessionId).toBe("new-chat");
    expect(sessionUiMutationWarning(deleted)).toBe("preferences delete failed");
    expect(deleted.id).toBe("deleted-chat");
    expect(sessionUiMutationWarning(cleared)).toBe("preferences transfer failed");
    expect(cleared.state.sessionId).toBe("cleared-chat");
    expect(cleared.state.messages).toEqual([]);
    expect(sessionUiMutationWarning(cwdReplacement)).toBe("preferences transfer failed");
    expect(cwdReplacement.state.sessionId).toBe("new-cwd-chat");
  });

  it("ignores failed, malformed, unrelated, or warning-free mutation responses", () => {
    for (const response of [
      { ok: false, sessionId: "new", sessionUiStateWarning: "failure" },
      { ok: true, sessionUiStateWarning: "failure" },
      { ok: true, state: { sessionId: 42 }, sessionUiStateWarning: "failure" },
      { ok: true, id: " ", sessionUiStateWarning: "failure" },
      { ok: true, id: "deleted", sessionUiStateWarning: "  " },
      { ok: true, state: { sessionId: "new" }, sessionUiStateAvailability: "unavailable" },
      null, [], "warning",
    ]) expect(sessionUiMutationWarning(response)).toBeUndefined();
  });
  it("recognizes only explicit unavailable chat responses without inventing UI state", () => {
    const chat = { ok: true, sessionId: "live-chat", messages: [{ role: "assistant", content: "hello" }],
      sessionUiStateAvailability: "unavailable", sessionUiStateWarning: "Preferences storage unavailable" };
    expect(chat.messages).toHaveLength(1);
    expect(sessionUiUnavailableWarning(chat)).toBe("Preferences storage unavailable");
    expect("sessionUiState" in chat).toBe(false);
    expect(parseSessionUiStateSnapshot((chat as Record<string, unknown>).sessionUiState)).toBeUndefined();
    expect(shouldMigrateLocalUiState({ ok: true, status: 200, sessionUiState: undefined }, localState)).toBe(false);
    expect(sessionUiUnavailableWarning({ ok: true, sessionUiStateWarning: "ignore" })).toBeUndefined();
  });
  it("migrates only from an explicit uninitialized revision-zero snapshot", () => {
    expect(shouldMigrateLocalUiState({
      ok: true,
      status: 200,
      sessionUiState: normalizeSessionUiState({ revision: 0, initialized: false }),
    }, localState)).toBe(true);
  });

  it("does not migrate over an initialized server even when its collections are empty", () => {
    expect(shouldMigrateLocalUiState({
      ok: true,
      status: 200,
      sessionUiState: normalizeSessionUiState({ revision: 0, initialized: true }),
    }, localState)).toBe(false);
  });

  it("does not migrate after an unauthorized or empty response", () => {
    expect(shouldMigrateLocalUiState({ ok: false, status: 401 }, localState)).toBe(false);
    expect(shouldMigrateLocalUiState({ ok: true, status: 200 }, localState)).toBe(false);
    expect(shouldMigrateLocalUiState({ ok: true, status: 200, sessionUiState: { revision: 0 } }, localState)).toBe(false);
    expect(shouldMigrateLocalUiState({ ok: true, status: 503, sessionUiState: { revision: 0, initialized: false } }, localState)).toBe(false);
  });

  it("rejects incomplete, future-format, or malformed authoritative records", () => {
    const valid = normalizeSessionUiState({ revision: 0, initialized: false });
    for (const malformed of [
      { revision: 0, initialized: false },
      { ...valid, version: 4 },
      { ...valid, lanes: [{ sessionId: "broken", lane: "impossible", since: "now" }] },
      { ...valid, lanes: "not a collection" },
      { ...valid, sessionNotes: [{ sessionId: "note", note: 42 }] },
      { ...valid, lanes: [{ sessionId: "lane", lane: "pinned", since: "not-a-date" }] },
      { ...valid, sessionNotes: [{ sessionId: "note", note: "text", updatedAt: "not-a-date" }] },
      { ...valid, sessionMarkers: [{ sessionId: "marker", color: "blue", updatedAt: "not-a-date" }] },
      { ...valid, sessionUnreadStates: [{ sessionId: "unread", unreadAt: "not-a-date", updatedAt: "2025-01-01T00:00:00.000Z" }] },
      { ...valid, sessionUnreadStates: [{ sessionId: "unread", unreadAt: "2025-01-01T00:00:00.000Z", updatedAt: "not-a-date" }] },
      { ...valid, sessionOrigins: [{ sessionId: "worker", originSessionId: "parent", kind: "worker", updatedAt: "not-a-date" }] },
      { ...valid, bucketLabels: { impossible: "label" } },
    ]) expect(parseSessionUiStateSnapshot(malformed)).toBeUndefined();
    expect(parseSessionUiStateSnapshot(valid)).toEqual(valid);
  });

  it("treats order-only and favorite-folder preferences as migration input", () => {
    expect(hasAnySessionUiState(normalizeSessionUiState({ bucketOrder: ["pink", "blue"] }))).toBe(true);
    expect(hasAnySessionUiState(normalizeSessionUiState({ favoriteFolders: ["/synthetic"] }))).toBe(true);
  });
});
