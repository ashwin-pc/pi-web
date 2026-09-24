import { describe, expect, it } from "vitest";
import { edgeScrollVelocity, insertionIndex } from "../src/components/reorderMotion.js";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

describe("reorder motion geometry", () => {
  it("finds insertion positions on either axis while excluding the dragged item", () => {
    const rows = [rect(0, 0, 100, 20), rect(0, 20, 100, 30), rect(0, 50, 100, 10)];
    expect(insertionIndex(rows, 56, "y", 0)).toBe(2);
    const columns = [rect(0, 0, 20, 20), rect(20, 0, 40, 20), rect(60, 0, 10, 20)];
    expect(insertionIndex(columns, 65, "x", 1)).toBe(1);
  });

  it("ramps auto-scroll at both edges and stays still in the middle", () => {
    expect(edgeScrollVelocity(0, 0, 200, 50, 20)).toBe(-20);
    expect(edgeScrollVelocity(25, 0, 200, 50, 20)).toBe(-10);
    expect(edgeScrollVelocity(100, 0, 200, 50, 20)).toBe(0);
    expect(edgeScrollVelocity(200, 0, 200, 50, 20)).toBe(20);
  });
});
