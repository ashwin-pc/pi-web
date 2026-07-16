import { describe, expect, it } from "vitest";
import { runtimePromptOptions } from "../server/runtime/prompt.js";

const image = { type: "image" as const, data: "abc", mimeType: "image/png" };

describe("runtime prompt options", () => {
  it("forwards follow-up and steer queue behavior while streaming", () => {
    expect(runtimePromptOptions(true, "followUp", [])).toEqual({ streamingBehavior: "followUp" });
    expect(runtimePromptOptions(true, "steer", [])).toEqual({ streamingBehavior: "steer" });
  });

  it("defaults unknown streaming modes to steer and preserves images", () => {
    expect(runtimePromptOptions(true, "unknown", [image])).toEqual({ streamingBehavior: "steer", images: [image] });
    expect(runtimePromptOptions(false, "followUp", [image])).toEqual({ images: [image] });
  });
});
