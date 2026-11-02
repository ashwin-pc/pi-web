import { describe, expect, it } from "vitest";
import { artifactSessionId, scopeArtifactUrl } from "../src/artifacts/url.js";

describe("scopeArtifactUrl", () => {
  it("scopes relative artifact URLs to the producing session", () => {
    expect(scopeArtifactUrl("/api/artifacts/image-edits/run%201/output%20final.png", "session/one"))
      .toBe("/api/session-artifacts/session%2Fone/image-edits/run%201/output%20final.png");
  });

  it("preserves explicit artifact scoping", () => {
    expect(scopeArtifactUrl("/api/artifacts/report.png?sessionId=producer&download=1#image", "current"))
      .toBe("/api/artifacts/report.png?sessionId=producer&download=1#image");
    expect(scopeArtifactUrl("/api/session-artifacts/producer/report.png", "current"))
      .toBe("/api/session-artifacts/producer/report.png");
  });

  it("does not rewrite external artifact-shaped URLs", () => {
    expect(scopeArtifactUrl("https://cdn.example/api/artifacts/report.png", "current"))
      .toBe("https://cdn.example/api/artifacts/report.png");
  });

  it("reads provenance from scoped paths and explicit queries", () => {
    expect(artifactSessionId("/api/session-artifacts/producer%2Fnested/report.md")).toBe("producer/nested");
    expect(artifactSessionId("/api/artifacts/report.md?download=1&sessionId=query-producer#preview")).toBe("query-producer");
    expect(artifactSessionId("https://cdn.example/api/artifacts/report.md?sessionId=external")).toBe("");
  });
});
