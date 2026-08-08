import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { attachmentContentUrl, normalizeSubmittedAttachments, parseAttachmentMarkup, serializeAttachmentMarkup } from "../server/shared/attachments.js";

const cwd = "/project";
const attachment = {
  type: "file" as const,
  id: "7c8216f8-1111-4222-8333-123456789abc",
  name: "hand-tattoo.jpg",
  mediaType: "image/jpeg",
  bytes: 48204,
  path: join(cwd, ".pi", "web", "attachments", "7c8216f8-1111-4222-8333-123456789abc", "hand-tattoo.jpg"),
  contentUrl: attachmentContentUrl("7c8216f8-1111-4222-8333-123456789abc", "hand-tattoo.jpg"),
};

describe("attachment message markup", () => {
  it("round trips strict fenced JSON without filesystem access", () => {
    const message = serializeAttachmentMarkup("Change this tattoo", [attachment]);
    expect(message).toContain("~~~json pi-web-attachments-v2");
    expect(message).not.toContain("base64");
    expect(parseAttachmentMarkup(message, cwd)).toEqual({ text: "Change this tattoo", attachments: [attachment] });
  });

  it("round trips a self-contained GitHub reference without storing its content", () => {
    const reference = {
      type: "reference" as const,
      id: "github:ashwin-pc/pi-web:issue:123",
      label: "GitHub issue #123",
      title: "Fix the mobile composer",
      reference: {
        provider: "github" as const,
        repository: "ashwin-pc/pi-web",
        resource: "issue" as const,
        number: 123,
        url: "https://github.com/ashwin-pc/pi-web/issues/123",
      },
    };
    const message = serializeAttachmentMarkup("Please implement this.", [reference]);
    expect(message).not.toContain("Description:");
    expect(parseAttachmentMarkup(message, cwd)).toEqual({ text: "Please implement this.", attachments: [reference] });
    expect(normalizeSubmittedAttachments(cwd, [reference])).toEqual([reference]);
  });

  it("leaves malformed or non-trailing markup visible", () => {
    expect(parseAttachmentMarkup("hello\n\n~~~json pi-web-attachments-v1\n{}\n~~~")).toEqual({ text: "hello\n\n~~~json pi-web-attachments-v1\n{}\n~~~", attachments: [] });
    const valid = serializeAttachmentMarkup("hello", [attachment]);
    expect(parseAttachmentMarkup(`${valid}\nafter`, cwd).attachments).toEqual([]);
  });

  it("rejects attachment paths that do not match their generated identity", () => {
    expect(normalizeSubmittedAttachments(cwd, [{ ...attachment, path: "/etc/passwd" }])).toEqual([]);
    expect(parseAttachmentMarkup(serializeAttachmentMarkup("hello", [{ ...attachment, path: "/etc/passwd" }]), cwd).attachments).toEqual([]);
  });
});
