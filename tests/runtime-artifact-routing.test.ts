import { describe, expect, it } from "vitest";
import { routeRuntimeArtifactUrls } from "../server/runtime/artifactRouting.js";

describe("runtime artifact routing", () => {
  it("adds session and runtime context to nested artifact URLs", () => {
    const routed = routeRuntimeArtifactUrls({
      text: "![image](/api/artifacts/result.png)",
      raw: { content: [{ type: "text", text: "[report](/api/artifacts/report.md)" }] },
      untouched: "https://example.com/api/artifacts/result.png",
    }, "session 1", "container:test");

    expect(routed).toEqual({
      text: "![image](/api/artifacts/result.png?sessionId=session+1&runtimeId=container%3Atest)",
      raw: { content: [{ type: "text", text: "[report](/api/artifacts/report.md?sessionId=session+1&runtimeId=container%3Atest)" }] },
      untouched: "https://example.com/api/artifacts/result.png",
    });
  });

  it("preserves existing routing parameters", () => {
    expect(routeRuntimeArtifactUrls(
      "/api/artifacts/result.png?sessionId=existing&runtimeId=ssh%3Adev",
      "new-session",
      "container:test",
    )).toBe("/api/artifacts/result.png?sessionId=existing&runtimeId=ssh%3Adev");
  });
});
