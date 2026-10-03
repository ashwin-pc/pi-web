import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, it } from "vitest";
import { findNativeExecutable } from "../server/session/adapters/nativeExecutable.js";

it.each([".EXE", ".CMD", ".COM", ".BAT"])("finds Windows PATH suffix %s without launching", (suffix) => {
  const expected = `C:\\Tools\\codex${suffix}`;
  const probe = (path: string) => path.toLowerCase() === expected.toLowerCase();
  expect(findNativeExecutable("codex", { Path: "C:\\Missing;C:\\Tools", PathExt: ".COM;.EXE;.BAT;.CMD" }, "win32", probe)).toBe(expected);
});
it("respects Windows PATHEXT order and quoted PATH entries", () => {
  const env = { PATH: '"C:\\Program Files\\Codex"', PATHEXT: ".CMD;.EXE" };
  expect(findNativeExecutable("codex", env, "win32", (path) => /codex\.(cmd|exe)$/i.test(path))).toBe("C:\\Program Files\\Codex\\codex.CMD");
});
it("does not append another suffix to an explicitly suffixed executable", () => {
  const tried: string[] = [];
  expect(findNativeExecutable("C:\\Tools\\codex.exe", { PATHEXT: ".EXE;.CMD" }, "win32", (path) => { tried.push(path); return false; })).toBeUndefined();
  expect(tried).toEqual(["C:\\Tools\\codex.exe"]);
});
it("treats Windows backslash paths as explicit rather than searching PATH", () => {
  const result = findNativeExecutable("bin\\codex", { PATH: "C:\\Other", PATHEXT: ".EXE" }, "win32", (path) => path === "bin\\codex.EXE");
  expect(result).toBe(win32.resolve("bin\\codex.EXE"));
});
it("does not apply Windows suffixes to POSIX PATH", () => {
  expect(findNativeExecutable("codex", { PATH: "/tools", PATHEXT: ".EXE" }, "linux", (path) => path === "/tools/codex.EXE")).toBeUndefined();
});
it("rejects directories/non-executable files and resolves a valid host file", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "pi-web-executable-"));
  try {
    const file = join(root, "codex");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o600 });
    expect(findNativeExecutable("codex", { PATH: root })).toBeUndefined();
    expect(findNativeExecutable(root, {})).toBeUndefined();
    await chmod(file, 0o700);
    expect(findNativeExecutable("codex", { PATH: root })).toBe(file);
  } finally { await rm(root, { recursive: true, force: true }); }
});
