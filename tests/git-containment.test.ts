import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCwdFromRepoParam, readGitImage } from "../server/shared/git.js";

describe("Git workspace containment", () => {
  it("allows nested repositories and rejects symlink escapes for repos and working-tree images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-git-containment-"));
    try {
      const root = join(dir, "workspace"); const outside = join(dir, "outside");
      await mkdir(root); await mkdir(outside); await mkdir(join(root, "..valid"));
      await writeFile(join(outside, "secret.png"), "private");
      await symlink(outside, join(root, "escape"));
      await symlink(join(outside, "secret.png"), join(root, "secret.png"));
      expect(await gitCwdFromRepoParam("..valid", root)).toBe(join(root, "..valid"));
      await expect(gitCwdFromRepoParam("escape", root)).rejects.toThrow("outside the workspace");
      await expect(gitCwdFromRepoParam("../outside", root)).rejects.toThrow("outside the workspace");
      await expect(readGitImage({ cwd: root, path: "secret.png", version: "after", staged: false })).rejects.toThrow("outside the repository");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
