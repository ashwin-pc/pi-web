import { describe, expect, it } from "vitest";
import { isSessionReferenceId, parseSessionReference, sessionReferenceHref } from "../../server/shared/sessionReference.js";

const sessionId = "01a09bda-99b1-7168-b63d-8c8732af9bef";
const entryId = "a1b2c3d4";
const origin = "https://pi.example.test";

describe("canonical session citation URLs", () => {
  it("round trips session and persisted-entry links", () => {
    for (const ref of [{ sessionId }, { sessionId, entryId }, { sessionId: "mock:one", entryId: "entry-2" }]) {
      const href = sessionReferenceHref(ref);
      expect(parseSessionReference(href)).toEqual(ref);
      expect(parseSessionReference(`${origin}${href}`, origin)).toEqual(ref);
    }
    expect(sessionReferenceHref({ sessionId, entryId })).toBe(`/?sessionId=${sessionId}&entryId=${entryId}`);
  });

  it("strips incidental state and credentials from generated citations", () => {
    const ref = parseSessionReference(`${origin}/?token=secret&sessionId=${sessionId}&entryId=${entryId}&view=files`)!;
    expect(sessionReferenceHref(ref)).toBe(`/?sessionId=${sessionId}&entryId=${entryId}`);
    expect(sessionReferenceHref(ref)).not.toContain("secret");
  });

  it("only handles same-origin links in the browser", () => {
    const href = `/?sessionId=${sessionId}`;
    expect(parseSessionReference(href, origin)).toEqual({ sessionId });
    expect(parseSessionReference(`https://other.example${href}`, origin)).toBeNull();
    expect(parseSessionReference(`http://pi.example.test${href}`, origin)).toBeNull();
    // The server can extract local IDs from a copied URL, without contacting it.
    expect(parseSessionReference(`https://other.example${href}`)).toEqual({ sessionId });
  });

  it("leaves unrelated app paths, panel links and ambiguous targets alone", () => {
    for (const value of [
      "", "not-a-url", "?sessionId=s1", "#panel:notes:note=1", "/?entryId=e1",
      "/api/state?sessionId=s1", "/?sessionId=s1#panel:notes", "/?sessionId=s1&sessionId=s2",
      "/?sessionId=s1&entryId=e1&entryId=e2", "/?sessionId=", "/?sessionId=s1&entryId=",
      "//pi.example.test/?sessionId=s1", "javascript:alert(1)", "file:///?sessionId=s1",
      "https://user:password@pi.example.test/?sessionId=s1", "https://pi.example.test\\@other/?sessionId=s1",
      "/?sessionId=has+space", "/?sessionId=..%2Fsecret", "/?sessionId=s1&entryId=%22onclick",
      "/?sessionId=s1\n&entryId=e1", `/?sessionId=${"a".repeat(101)}`, `/?sessionId=s1&x=${"x".repeat(4096)}`,
    ]) expect(parseSessionReference(value, origin), value).toBeNull();
  });

  it("validates identifiers before formatting", () => {
    for (const value of [null, 1, "", "..", "with space", "../file", "a\nb", "a".repeat(101)]) {
      expect(isSessionReferenceId(value)).toBe(false);
      expect(() => sessionReferenceHref({ sessionId: value as string })).toThrow("Invalid session reference");
    }
    expect(() => sessionReferenceHref({ sessionId, entryId: "" })).toThrow("Invalid session reference");
  });
});
