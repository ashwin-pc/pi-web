import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { customMessageReportData } from "../src/messages/customMessageReports.js";

describe("minimal custom-message reports", () => {
  it("uses bounded generic presentation metadata and structured session references", () => {
    const data = customMessageReportData({
      customType: "any-extension",
      text: "# Full report\nEverything remains available.",
      details: {
        sessionRefs: [{ sessionId: "related-1", name: "Related session", status: "error" }],
        presentation: { kind: "expandable-report", label: "Build · failed", preview: "Compilation failed", tone: "danger" },
      },
    });
    expect(data).toMatchObject({
      label: "Build · failed",
      preview: "Compilation failed",
      tone: "danger",
      refs: [{ sessionId: "related-1", name: "Related session", status: "error" }],
    });
  });

  it("falls back readably for existing custom records without presentation metadata", () => {
    expect(customMessageReportData({ customType: "deploy_notice", text: "  Deployed   successfully  " })).toMatchObject({
      label: "Deploy notice",
      preview: "Deployed successfully",
      tone: "neutral",
      refs: [],
    });
  });

  it("ignores malformed, unknown, and overlong presentation data", () => {
    const data = customMessageReportData({
      customType: "probe",
      text: "fallback text",
      details: { presentation: { kind: "unknown", label: "x".repeat(500), preview: "y".repeat(500), tone: "private-tone" } },
    });
    expect(data).toMatchObject({ label: "Probe", preview: "fallback text", tone: "neutral" });
  });

  it("bounds accepted labels and previews and strips control characters", () => {
    const data = customMessageReportData({
      text: "body",
      details: { presentation: { kind: "expandable-report", label: `A\u0000${"b".repeat(100)}`, preview: "p".repeat(500), tone: "accent" } },
    });
    expect(data?.label).not.toContain("\u0000");
    expect(data?.label.length).toBe(80);
    expect(data?.preview.length).toBe(320);
  });

  it("does not contain or import an ordinary-user orchestrator envelope classifier", () => {
    const reports = readFileSync(new URL("../src/messages/customMessageReports.ts", import.meta.url), "utf8");
    const messages = readFileSync(new URL("../src/messages/messageList.ts", import.meta.url), "utf8");
    expect(`${reports}\n${messages}`).not.toContain("[orchestrator]");
    expect(messages).not.toContain('customType: "session-orchestrator"');
    expect(messages).not.toContain("parseLegacyWorkerNotification");
  });

  it("drops content-free custom messages", () => {
    expect(customMessageReportData({ customType: "anything" })).toBeUndefined();
  });

  it("defines bounded one-line layout and independent expanded report", () => {
    const css = readFileSync(new URL("../src/styles/customMessageReports.css", import.meta.url), "utf8");
    expect(css).toContain("text-overflow: ellipsis");
    expect(css).toContain("white-space: nowrap");
    expect(css).toContain(".customMessageReport.collapsed .customMessageReportBody");
    expect(css).toContain("min-height: 20px");
    expect(css).toContain("border: 0");
    expect(css).toContain("background: transparent");
    expect(css).not.toContain("orchestrator");
  });
});
