import { describe, expect, it } from "vitest";
import { isIconName } from "../src/app/icons.js";

describe("icon registry", () => {
  it("accepts only own icon registry keys", () => {
    expect(isIconName("square-pen")).toBe(true);
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("constructor")).toBe(false);
    expect(isIconName("__proto__")).toBe(false);
  });
});
