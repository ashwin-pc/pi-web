import { describe, expect, it } from "vitest";
import { classifyMarkdownImageSource } from "../src/markdown/imageTrust.js";
import { parsePanelDeepLink } from "../src/messages/panelDeepLinks.js";

describe("markdown image trust policy", () => {
  const origin = "https://pi.example.test";

  it("automatically permits only local image endpoints and inline raster data", () => {
    expect(classifyMarkdownImageSource("/api/artifacts/chart.png", origin)).toEqual({
      kind: "automatic",
      src: "/api/artifacts/chart.png",
    });
    expect(classifyMarkdownImageSource("https://pi.example.test/api/attachments/id/name.png?download=0", origin)).toEqual({
      kind: "automatic",
      src: "/api/attachments/id/name.png?download=0",
    });
    expect(classifyMarkdownImageSource("/api/session-artifacts/session/chart.png", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("/api/messages/image?imageId=1.2.digest", origin).kind).toBe("automatic");
    expect(classifyMarkdownImageSource("data:image/png;base64,iVBORw0KGgo=", origin).kind).toBe("automatic");
  });

  it("gates normalized remote URLs and rejects ambiguous URL syntax", () => {
    expect(classifyMarkdownImageSource("https://images.example.test/a.png", origin)).toEqual({
      kind: "remote",
      src: "https://images.example.test/a.png",
      host: "images.example.test",
    });
    for (const source of [
      "//images.example.test/a.png",
      "https:\\images.example.test\\a.png",
      "/\\images.example.test/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "/ordinary/path.png",
      "https://user:secret@images.example.test/a.png",
    ]) {
      expect(classifyMarkdownImageSource(source, origin), source).toEqual({ kind: "rejected" });
    }
  });
});

describe("panel deep-link parsing", () => {
  it("keeps duplicate-parameter behavior while returning an explicit target", () => {
    expect(parsePanelDeepLink("#panel:notes:note=oncall%2Fw34&task=old&task=t-3f2a")).toEqual({
      key: "notes",
      payload: { note: "oncall/w34", task: "t-3f2a" },
    });
  });

  it("preserves supported punctuation while rejecting unreadable targets", () => {
    expect(parsePanelDeepLink("#panel::note=ignored")).toBeUndefined();
    expect(parsePanelDeepLink("#panel:notes!\nTarget=value")).toBeUndefined();
    expect(parsePanelDeepLink(`#panel:${"x".repeat(81)}:value=1`)).toBeUndefined();
    expect(parsePanelDeepLink("#panel:team/notes!@$%^&*():value=1")).toEqual({
      key: "team/notes!@$%^&*()",
      payload: { value: "1" },
    });
  });
});
