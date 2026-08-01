import { describe, expect, it } from "vitest";
import { maxSessionRefLabel, maxSessionRefs, sessionRefChipText, sessionRefsFromDetails } from "../src/app/sessionRefs.js";

describe("session references from extension details", () => {
  it("reads explicit reference lists under any supported key", () => {
    expect(sessionRefsFromDetails({ sessions: [{ sessionId: "a-1", name: "one" }] })).toEqual([
      { sessionId: "a-1", name: "one", status: undefined },
    ]);
    expect(sessionRefsFromDetails({ workers: [{ sessionId: "b-2" }] })[0].sessionId).toBe("b-2");
    expect(sessionRefsFromDetails({ sessionRefs: [{ sessionId: "c-3" }] })[0].sessionId).toBe("c-3");
  });

  it("ignores a bare sessionId, so incidental metadata does not become a link", () => {
    // Tools that merely echo the session they acted on must not sprout chips;
    // linking is opt-in via an explicit list.
    expect(sessionRefsFromDetails({ sessionId: "a-1", name: "echoed" })).toEqual([]);
  });

  it("ignores payloads that are absent or not objects", () => {
    for (const value of [undefined, null, "a-1", 42, [{ sessionId: "a-1" }]]) {
      expect(sessionRefsFromDetails(value)).toEqual([]);
    }
  });

  it("de-duplicates repeated session ids across lists", () => {
    const refs = sessionRefsFromDetails({
      sessions: [{ sessionId: "a-1", name: "first" }],
      workers: [{ sessionId: "a-1", name: "again" }, { sessionId: "b-2" }],
    });
    expect(refs.map((ref) => ref.sessionId)).toEqual(["a-1", "b-2"]);
    expect(refs[0].name).toBe("first");
  });

  it("caps how many references are rendered", () => {
    const many = Array.from({ length: maxSessionRefs + 5 }, (_, i) => ({ sessionId: `s-${i}` }));
    expect(sessionRefsFromDetails({ sessions: many })).toHaveLength(maxSessionRefs);
  });

  it("rejects implausible session ids instead of trusting extension input", () => {
    const refs = sessionRefsFromDetails({
      sessions: [
        { sessionId: "" },
        { sessionId: "   " },
        { sessionId: "has space" },
        { sessionId: "javascript:alert(1)" },
        { sessionId: "../../etc/passwd" },
        { sessionId: "x".repeat(200) },
        { sessionId: "ok-1" },
      ],
    });
    expect(refs.map((ref) => ref.sessionId)).toEqual(["ok-1"]);
  });

  it("truncates and sanitizes labels", () => {
    const refs = sessionRefsFromDetails({
      sessions: [{ sessionId: "a-1", name: `${"n".repeat(maxSessionRefLabel + 40)}` }, { sessionId: "b-2", name: "line\u0000break\u001F" }],
    });
    expect(refs[0].name).toHaveLength(maxSessionRefLabel);
    expect(refs[1].name).toBe("linebreak");
  });

  it("labels a chip by name, falling back to a short id, with a status glyph", () => {
    expect(sessionRefChipText({ sessionId: "abcdefghij", name: "scout" })).toBe("↗ scout");
    expect(sessionRefChipText({ sessionId: "abcdefghij" })).toBe("↗ cdefghij");
    expect(sessionRefChipText({ sessionId: "a-1", name: "x", status: "error" })).toBe("⚠ x");
    expect(sessionRefChipText({ sessionId: "a-1", name: "x", status: "aborted" })).toBe("⏹ x");
  });
});
