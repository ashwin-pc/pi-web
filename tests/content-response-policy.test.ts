import { describe, expect, it } from "vitest";
import {
  artifactResponsePolicy,
  attachmentResponsePolicy,
  workspaceImageResponsePolicy,
} from "../server/shared/contentResponsePolicy.js";

describe("untrusted content response policies", () => {
  it("isolates active artifacts without disabling their scripts", () => {
    expect(artifactResponsePolicy("report.html")).toEqual({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox allow-scripts",
    });
    expect(artifactResponsePolicy("diagram.svg")["content-security-policy"]).not.toContain("allow-same-origin");
  });

  it("fully sandboxes workspace images opened as documents", () => {
    expect(workspaceImageResponsePolicy("image/svg+xml")).toEqual({
      "content-type": "image/svg+xml",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  it("downloads active and unknown attachments while retaining inert media inline", () => {
    expect(attachmentResponsePolicy("page.html")).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="page.html"; filename*=UTF-8''page.html`,
    });
    expect(attachmentResponsePolicy("vector.svg")["content-disposition"]).toMatch(/^attachment;/);
    expect(attachmentResponsePolicy("unknown.bin")["content-disposition"]).toMatch(/^attachment;/);
    expect(attachmentResponsePolicy("photo.png")).toMatchObject({
      "content-type": "image/png",
      "content-disposition": `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
    });
    expect(attachmentResponsePolicy(`résumé "final".html`)["content-disposition"])
      .toBe(`attachment; filename="r_sum_ _final_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.html`);
  });
});
