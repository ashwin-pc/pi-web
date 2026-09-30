import { describe, expect, it } from "vitest";
import { parseResourceRef, resourceFromUrl, resourceKey, resourceUrl } from "../shared/resourceRef.js";

const workspaceId = "local-0123456789abcdef";
describe("workspace resources", () => {
  it("converges URL and direct navigation on the same file identity", () => {
    const ref = parseResourceRef({ kind: "file", workspaceId, path: "./src//app.ts" })!;
    const url = resourceUrl(ref, "https://example.com/?session=s1#entry");
    expect(ref.path).toBe("src/app.ts");
    expect(url.searchParams.get("session")).toBe("s1");
    expect(url.hash).toBe("#entry");
    expect(resourceKey(resourceFromUrl(url)!)).toBe(resourceKey(ref));
  });
  it("separates repository and staged diff identity", () => {
    const ref = parseResourceRef({ kind: "diff", workspaceId, repo: ".", path: "note space.md", staged: false })!;
    expect(resourceFromUrl(resourceUrl(ref))).toEqual(ref);
    expect(resourceKey({ ...ref, kind: "diff", repo: "nested", staged: false })).not.toBe(resourceKey(ref));
    expect(resourceKey({ ...ref, kind: "diff", repo: ".", staged: true })).not.toBe(resourceKey(ref));
  });
  it.each(["/etc/passwd", "../secret", "a/../../secret", "a\\b", "a\0b", "", "."])("rejects unsafe file path %s", (path) => {
    expect(parseResourceRef({ kind: "file", workspaceId, path })).toBeUndefined();
  });
});
