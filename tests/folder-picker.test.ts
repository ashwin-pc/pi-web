import { describe, expect, it, vi } from "vitest";
import { readRecentFolders, rememberRecentFolder } from "../src/files/folderPicker.js";

function memoryStorage(initial = "") {
  let value = initial;
  return { getItem: vi.fn(() => value || null), setItem: vi.fn((_key: string, next: string) => { value = next; }) };
}

describe("folder picker recents", () => {
  it("records successful choices as bounded deduplicated chronology", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 10; index += 1) rememberRecentFolder(`/work/${index}`, storage);
    rememberRecentFolder("/work/5", storage);
    const recent = readRecentFolders(storage);
    expect(recent).toHaveLength(8);
    expect(recent[0].path).toBe("/work/5");
    expect(new Set(recent.map((item) => item.path)).size).toBe(8);
  });

  it("ignores malformed storage and invalid entries", () => {
    expect(readRecentFolders(memoryStorage("not json"))).toEqual([]);
    expect(readRecentFolders(memoryStorage(JSON.stringify([{ path: "", usedAt: "x" }, { path: "/ok", usedAt: "now" }, null])))).toEqual([{ path: "/ok", usedAt: "now" }]);
  });
});
