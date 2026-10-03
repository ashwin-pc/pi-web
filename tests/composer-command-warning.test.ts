import { describe, expect, it } from "vitest";
import { committedCommandUiWarning } from "../src/composer/composer.js";

describe("committed command UI metadata warning", () => {
  it("reports a successful clear's metadata failure without mistaking the new session for a failed command", () => {
    const response = { ok: true, state: { sessionId: "new-chat", messages: [] }, sessionUiStateWarning: "Could not transfer session preferences" };
    expect(committedCommandUiWarning(response)).toBe("Could not transfer session preferences");
    expect(response.state.sessionId).toBe("new-chat");
    expect(response.state.messages).toEqual([]);
  });

  it("does not disable preferences on unsuccessful or unrelated responses", () => {
    expect(committedCommandUiWarning({ ok: false, state: { sessionId: "new-chat" }, sessionUiStateWarning: "storage error" })).toBeUndefined();
    expect(committedCommandUiWarning({ ok: true, sessionUiStateWarning: "storage error" })).toBeUndefined();
    expect(committedCommandUiWarning({ ok: true, state: { sessionId: "new-chat" }, sessionUiStateWarning: "" })).toBeUndefined();
    expect(committedCommandUiWarning({ ok: true, state: { sessionId: "new-chat" }, sessionUiStateAvailability: "unavailable" })).toBeUndefined();
  });
});
