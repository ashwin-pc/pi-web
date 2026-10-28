import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, gitDiff, gitStatus, gitSync, listGitRepos } from "../server/shared/git.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function runGit(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commitFile(cwd: string, path: string, contents: string, message = path) {
  await writeFile(join(cwd, path), contents);
  runGit(cwd, "add", path);
  runGit(cwd, "commit", "-m", message);
}

async function makeRepo(path: string) {
  await mkdir(path);
  runGit(path, "init", "-b", "main");
  runGit(path, "config", "user.name", "Pi Web Tests");
  runGit(path, "config", "user.email", "pi-web@example.test");
}

async function makeSubmoduleFixture(submoduleName = "child.module with space") {
  const root = await tempDir("pi-web-git-submodule-");
  const childSource = join(root, "child-source");
  const parent = join(root, "parent");
  await makeRepo(childSource);
  await commitFile(childSource, "tracked.txt", "child one\n", "child initial");
  await makeRepo(parent);
  await commitFile(parent, "parent.txt", "parent one\n", "parent initial");
  runGit(parent, "-c", "protocol.file.allow=always", "submodule", "add", "--name", submoduleName, childSource, "child");
  runGit(parent, "commit", "-m", "add child");
  return { root, parent, child: join(parent, "child"), submoduleName };
}

async function withPathPrefix<T>(path: string, callback: () => Promise<T>) {
  const original = process.env.PATH;
  process.env.PATH = `${path}${delimiter}${original || ""}`;
  try {
    return await callback();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

async function expectSyncRefusalWithDirtyChild(submoduleName: string, deleteGitmodules: boolean) {
  const { root, parent, child } = await makeSubmoduleFixture(submoduleName);
  const parentRemote = join(root, "parent.git");
  const updater = join(root, "updater");
  const fsmonitorMarker = join(root, "child-sync-fsmonitor-executed");
  const filterMarker = join(root, "child-sync-filter-executed");
  const fsmonitor = join(root, "child-sync-fsmonitor.cjs");
  const filter = join(root, "child-sync-filter.cjs");
  const trackedFile = join(child, "tracked.txt");

  await writeFile(join(child, ".gitattributes"), "tracked.txt filter=repo\n");
  runGit(child, "add", ".gitattributes");
  runGit(child, "commit", "-m", "filter tracked child file");
  runGit(parent, "config", "-f", ".gitmodules", `submodule.${submoduleName}.ignore`, "none");
  runGit(parent, "add", ".gitmodules", "child");
  runGit(parent, "commit", "-m", "require dirty child inspection");
  runGit(root, "init", "--bare", "-b", "main", parentRemote);
  runGit(parent, "remote", "add", "origin", parentRemote);
  runGit(parent, "push", "-u", "origin", "main");
  if (deleteGitmodules) {
    runGit(parent, "config", "--remove-section", `submodule.${submoduleName}`);
    await rm(join(parent, ".gitmodules"));
  }

  runGit(root, "clone", parentRemote, updater);
  runGit(updater, "config", "user.name", "Pi Web Tests");
  runGit(updater, "config", "user.email", "pi-web@example.test");
  if (deleteGitmodules) runGit(updater, "rm", ".gitmodules");
  await commitFile(updater, "remote.txt", "remote advance\n", "remote advance");
  runGit(updater, "push", "origin", "main");

  runGit(parent, "config", "fetch.recurseSubmodules", "true");
  runGit(parent, "config", "submodule.recurse", "true");
  runGit(parent, "config", "diff.ignoreSubmodules", "none");
  runGit(parent, "config", "status.submoduleSummary", "true");
  runGit(parent, "config", "diff.submodule", "log");
  await writeFile(fsmonitor, `require("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "executed");\n`);
  await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(filterMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
  runGit(child, "config", "core.fsmonitor", `"${process.execPath}" "${fsmonitor}"`);
  runGit(child, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);
  runGit(child, "config", "filter.repo.required", "true");
  await expect(access(fsmonitorMarker)).rejects.toThrow();
  await expect(access(filterMarker)).rejects.toThrow();

  const originalStat = await stat(trackedFile);
  await writeFile(trackedFile, "child two\n");
  const changedMtime = new Date(Math.max(Date.now() + 2_000, originalStat.mtimeMs + 2_000));
  await utimes(trackedFile, originalStat.atime, changedMtime);
  await writeFile(join(parent, "parent.txt"), "preserved parent change\n");

  await expect(gitSync(parent)).rejects.toThrow(/Sync refused: submodule gitlinks are present/);
  await expect(access(join(parent, "remote.txt"))).rejects.toThrow();
  await expect(readFile(join(parent, "parent.txt"), "utf8")).resolves.toBe("preserved parent change\n");
  await expect(readFile(trackedFile, "utf8")).resolves.toBe("child two\n");
  if (deleteGitmodules) await expect(access(join(parent, ".gitmodules"))).rejects.toThrow();
  await expect(access(fsmonitorMarker)).rejects.toThrow();
  await expect(access(filterMarker)).rejects.toThrow();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git submodule command isolation", () => {
  it("does not execute dirty child config while preserving parent and gitlink diffs", async () => {
    const { root, parent, child } = await makeSubmoduleFixture();
    const fsmonitorMarker = join(root, "child-fsmonitor-executed");
    const filterMarker = join(root, "child-filter-executed");
    const fsmonitor = join(root, "child-fsmonitor.cjs");
    const filter = join(root, "child-filter.cjs");
    await writeFile(fsmonitor, `require("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "executed");\n`);
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(filterMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    runGit(child, "config", "core.fsmonitor", `"${process.execPath}" "${fsmonitor}"`);
    runGit(child, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);
    runGit(child, "config", "filter.repo.required", "true");
    await writeFile(join(child, ".gitattributes"), "tracked.txt filter=repo\n");
    await writeFile(join(child, "tracked.txt"), "child two\n");
    await writeFile(join(parent, "parent.txt"), "parent two\n");

    const parentStatus = await gitStatus(parent);
    expect(parentStatus.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "parent.txt", label: "modified" }),
    ]));
    expect(parentStatus.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "child" }),
    ]));
    await expect(gitDiff({ cwd: parent, path: "parent.txt", staged: false })).resolves.toMatchObject({
      diff: expect.stringContaining("+parent two"),
    });
    await expect(gitDiff({ cwd: parent, path: "child", staged: false })).resolves.toMatchObject({
      diff: "",
    });
    await expect(access(fsmonitorMarker)).rejects.toThrow();
    await expect(access(filterMarker)).rejects.toThrow();

    const childStatus = await gitStatus(child);
    expect(childStatus.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", label: "modified" }),
    ]));
    await expect(access(fsmonitorMarker)).rejects.toThrow();
    await expect(access(filterMarker)).rejects.toThrow();

    runGit(child, "-c", "core.fsmonitor=false", "-c", "filter.repo.clean=", "-c", "filter.repo.required=false", "add", ".gitattributes", "tracked.txt");
    runGit(child, "-c", "core.fsmonitor=false", "-c", "filter.repo.clean=", "-c", "filter.repo.required=false", "commit", "-m", "child update");

    const changedGitlinkStatus = await gitStatus(parent);
    expect(changedGitlinkStatus.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "child", label: "modified" }),
      expect.objectContaining({ path: "parent.txt", label: "modified" }),
    ]));
    const childDiff = await gitDiff({ cwd: parent, path: "child", staged: false });
    expect(childDiff.diff).toContain("-Subproject commit ");
    expect(childDiff.diff).toContain("+Subproject commit ");
    await expect(access(fsmonitorMarker)).rejects.toThrow();
    await expect(access(filterMarker)).rejects.toThrow();

    const repos = await listGitRepos(parent);
    expect(repos.repos.map((repo) => repo.path)).toEqual([".", "child"]);
  });

  it("does not honor configured recursive fetch or pull inside the child", async () => {
    const { root, parent, child } = await makeSubmoduleFixture();
    const parentRemote = join(root, "parent.git");
    const bin = join(root, "bin");
    const helperMarker = join(root, "child-remote-helper-executed");
    await mkdir(bin);
    runGit(root, "init", "--bare", parentRemote);
    runGit(parent, "remote", "add", "origin", parentRemote);
    runGit(parent, "push", "-u", "origin", "main");
    runGit(parent, "config", "fetch.recurseSubmodules", "true");
    runGit(parent, "config", "submodule.recurse", "true");
    runGit(child, "remote", "set-url", "origin", "fixture::local-only");
    await writeFile(join(bin, "git-remote-fixture"), `#!/bin/sh\nprintf executed > ${JSON.stringify(helperMarker)}\nexit 1\n`, { mode: 0o755 });

    await withPathPrefix(bin, async () => {
      await expect(git(["fetch", "--prune", "origin"], 15_000, parent)).resolves.toMatchObject({});
      await expect(access(helperMarker)).rejects.toThrow();
      await expect(git(["pull", "--ff-only", "origin", "main"], 15_000, parent)).resolves.toMatchObject({});
      await expect(access(helperMarker)).rejects.toThrow();
    });
  });

  it("refuses sync without touching child or parent edits for a submodule name containing =", async () => {
    await expectSyncRefusalWithDirtyChild("child=a", false);
  });

  it("refuses sync without touching edits after worktree and fetched .gitmodules deletion", async () => {
    await expectSyncRefusalWithDirtyChild("child", true);
  });

});
