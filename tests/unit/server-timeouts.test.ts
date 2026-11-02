import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

describe("server request budgets", () => {
  it("keeps Node's default whole-request budget while bounding headers", async () => {
    const source = await readFile("server.ts", "utf8");
    expect(source).not.toContain("server.requestTimeout");
    expect(source).toContain("server.headersTimeout = 30_000");
    expect(createServer().requestTimeout).toBe(300_000);
  });
});
