import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitSync } from "../server/shared/git.js";
import { assertSyncFilesystemBoundary } from "../server/shared/gitSyncBoundary.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function runGit(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(path: string) {
  await mkdir(path);
  runGit(path, "init", "-b", "main");
  runGit(path, "config", "user.name", "Pi Web Tests");
  runGit(path, "config", "user.email", "pi-web@example.test");
}

async function commitFile(cwd: string, path: string, contents: string, message: string) {
  await writeFile(join(cwd, path), contents);
  runGit(cwd, "add", path);
  runGit(cwd, "commit", "-m", message);
}

async function makeIncomingGitlinkFixture(path: string) {
  const root = await tempDir("pi-web-git-sync-boundary-");
  const seed = join(root, "seed");
  const parent = join(root, "parent");
  const updater = join(root, "updater");
  const remote = join(root, "parent.git");
  await makeRepo(seed);
  await commitFile(seed, "tracked.txt", "one\n", "one");
  runGit(root, "init", "--bare", "-b", "main", remote);
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(root, "clone", remote, parent);
  runGit(root, "clone", remote, updater);
  runGit(parent, "config", "user.name", "Pi Web Tests");
  runGit(parent, "config", "user.email", "pi-web@example.test");
  runGit(updater, "config", "user.name", "Pi Web Tests");
  runGit(updater, "config", "user.email", "pi-web@example.test");
  const originalRemoteHead = runGit(parent, "rev-parse", "refs/remotes/origin/main");
  const gitlinkTarget = runGit(updater, "rev-parse", "HEAD");
  runGit(updater, "update-index", "--add", "--cacheinfo", `160000,${gitlinkTarget},${path}`);
  runGit(updater, "commit", "-m", "remote gitlink");
  runGit(updater, "push", "origin", "main");
  return { root, parent, originalRemoteHead };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git Sync", () => {
  it("preserves pull fork-point behavior after an upstream force-push and prunes all origin refs", async () => {
    const root = await tempDir("pi-web-git-sync-force-push-");
    const seed = join(root, "seed");
    const local = join(root, "local");
    const updater = join(root, "updater");
    const remote = join(root, "remote.git");
    await makeRepo(seed);
    await writeFile(join(seed, "history.txt"), "one\n");
    await writeFile(join(seed, "dirty.txt"), "clean\n");
    runGit(seed, "add", ".");
    runGit(seed, "commit", "-m", "one");
    await commitFile(seed, "history.txt", "one\ntwo\n", "two");
    runGit(root, "init", "--bare", "-b", "main", remote);
    runGit(seed, "remote", "add", "origin", remote);
    runGit(seed, "push", "-u", "origin", "main");
    runGit(seed, "branch", "side");
    runGit(seed, "branch", "stale");
    runGit(seed, "push", "origin", "side", "stale");
    runGit(root, "clone", remote, local);
    runGit(root, "clone", remote, updater);
    for (const repo of [local, updater]) {
      runGit(repo, "config", "user.name", "Pi Web Tests");
      runGit(repo, "config", "user.email", "pi-web@example.test");
    }

    const oldTwo = runGit(local, "rev-parse", "HEAD");
    await commitFile(local, "local.txt", "local\n", "local");
    await writeFile(join(local, "dirty.txt"), "preserved dirty edit\n");

    await writeFile(join(updater, "history.txt"), "one\ntwo amended\n");
    runGit(updater, "add", "history.txt");
    runGit(updater, "commit", "--amend", "-m", "two amended");
    await commitFile(updater, "three.txt", "three\n", "three");
    runGit(updater, "push", "--force", "origin", "main");
    runGit(updater, "switch", "side");
    await commitFile(updater, "side.txt", "updated side\n", "update side");
    const updatedSide = runGit(updater, "rev-parse", "HEAD");
    runGit(updater, "push", "origin", "side");
    runGit(updater, "push", "origin", "--delete", "stale");

    await expect(gitSync(local)).resolves.toMatchObject({ ok: true, status: { branch: "main" } });
    expect(runGit(local, "log", "-4", "--format=%s").split("\n")).toEqual([
      "local",
      "three",
      "two amended",
      "one",
    ]);
    expect(() => runGit(local, "merge-base", "--is-ancestor", oldTwo, "HEAD")).toThrow();
    expect(runGit(local, "rev-parse", "refs/remotes/origin/side")).toBe(updatedSide);
    expect(() => runGit(local, "rev-parse", "--verify", "refs/remotes/origin/stale")).toThrow();
    await expect(readFile(join(local, "dirty.txt"), "utf8")).resolves.toBe("preserved dirty edit\n");
    await expect(access(join(local, ".git", "rebase-merge"))).rejects.toThrow();
    await expect(access(join(local, ".git", "rebase-apply"))).rejects.toThrow();
    expect(runGit(local, "stash", "list")).toBe("");
  }, 20_000);

  it("refuses an ignored initialized child before a later fetch can introduce its gitlink", async () => {
    const fixture = await makeIncomingGitlinkFixture("ignored-child");
    const child = join(fixture.parent, "ignored-child");
    const nested = join(fixture.parent, "ordinary", "nested");
    const marker = join(fixture.root, "child-filter-executed");
    const filter = join(fixture.root, "child-filter.cjs");
    await makeRepo(child);
    await commitFile(child, "tracked.txt", "child one\n", "child one");
    await writeFile(join(fixture.parent, ".git", "info", "exclude"), "ignored-child/\n");
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    runGit(child, "config", "core.fsmonitor", `"${process.execPath}" "${filter}"`);
    runGit(child, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);
    await mkdir(nested, { recursive: true });

    await expect(gitSync(nested)).rejects.toThrow(/nested Git repository marker/);
    expect(runGit(fixture.parent, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.originalRemoteHead);
    await expect(access(marker)).rejects.toThrow();
    await expect(access(join(fixture.parent, "ignored-child", ".git"))).resolves.toBeUndefined();
  });

  it("refuses a cached submodule repository before a later fetch can introduce its gitlink", async () => {
    const fixture = await makeIncomingGitlinkFixture("cached-child");
    const cached = join(fixture.parent, ".git", "modules", "cached-child");
    const marker = join(fixture.root, "cached-filter-executed");
    const filter = join(fixture.root, "cached-filter.cjs");
    runGit(fixture.parent, "init", "--bare", cached);
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    runGit(cached, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);

    await expect(gitSync(fixture.parent)).rejects.toThrow(/cached submodule repositories/);
    expect(runGit(fixture.parent, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.originalRemoteHead);
    await expect(access(marker)).rejects.toThrow();
  });

  it("refuses directory links without traversing outside the checkout", async () => {
    const root = await tempDir("pi-web-git-sync-link-");
    const parent = join(root, "parent");
    const outside = join(root, "outside");
    await makeRepo(parent);
    await makeRepo(outside);
    await commitFile(parent, "tracked.txt", "one\n", "one");
    await symlink(outside, join(parent, "linked-directory"));

    await expect(gitSync(parent)).rejects.toThrow(/directory link/);
  });

  it("refuses a case-variant nested Gitfile without reading its target", async () => {
    const root = await tempDir("pi-web-git-sync-case-marker-");
    const parent = join(root, "parent");
    const child = join(parent, "child");
    const commonDir = join(parent, ".git");
    await mkdir(commonDir, { recursive: true });
    await mkdir(child);
    await writeFile(join(child, ".GiT"), "gitdir: ../../outside\n");

    await expect(assertSyncFilesystemBoundary(parent, commonDir)).rejects.toThrow(/nested Git repository marker/);
  });

  it("supports an unborn flat branch through native pull", async () => {
    const root = await tempDir("pi-web-git-sync-unborn-");
    const seed = join(root, "seed");
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    await makeRepo(seed);
    await commitFile(seed, "tracked.txt", "one\n", "one");
    runGit(root, "init", "--bare", "-b", "main", remote);
    runGit(seed, "push", remote, "main");
    await makeRepo(local);
    runGit(local, "remote", "add", "origin", remote);

    await expect(gitSync(local)).resolves.toMatchObject({ ok: true, status: { branch: "main" } });
    await expect(readFile(join(local, "tracked.txt"), "utf8")).resolves.toBe("one\n");
  });
});
