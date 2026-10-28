import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitSync } from "../server/shared/git.js";

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

  it("syncs without scanning ignored nested repositories, cached repositories, or directory links", async () => {
    const root = await tempDir("pi-web-git-sync-layouts-");
    const seed = join(root, "seed");
    const parent = join(root, "parent");
    const updater = join(root, "updater");
    const remote = join(root, "remote.git");
    const outside = join(root, "outside");
    await makeRepo(seed);
    await commitFile(seed, "tracked.txt", "one\n", "one");
    runGit(root, "init", "--bare", "-b", "main", remote);
    runGit(seed, "remote", "add", "origin", remote);
    runGit(seed, "push", "-u", "origin", "main");
    runGit(root, "clone", remote, parent);
    runGit(root, "clone", remote, updater);
    runGit(updater, "config", "user.name", "Pi Web Tests");
    runGit(updater, "config", "user.email", "pi-web@example.test");

    const child = join(parent, ".venv", "src", "ignored-child");
    await mkdir(join(parent, ".venv", "src"), { recursive: true });
    await makeRepo(child);
    await commitFile(child, "child.txt", "child\n", "child");
    await writeFile(join(parent, ".git", "info", "exclude"), ".venv/\nworkspace-link\n");
    runGit(parent, "init", "--bare", join(parent, ".git", "modules", "cached-child"));
    await makeRepo(outside);
    await symlink(outside, join(parent, "workspace-link"));

    await commitFile(updater, "remote.txt", "remote advance\n", "remote advance");
    runGit(updater, "push", "origin", "main");

    await expect(gitSync(parent)).resolves.toMatchObject({ ok: true, status: { branch: "main" } });
    await expect(readFile(join(parent, "remote.txt"), "utf8")).resolves.toBe("remote advance\n");
    await expect(access(join(child, ".git"))).resolves.toBeUndefined();
    await expect(access(join(parent, ".git", "modules", "cached-child", "HEAD"))).resolves.toBeUndefined();
    await expect(access(join(parent, "workspace-link"))).resolves.toBeUndefined();
  });

  it("keeps the standard detached-HEAD error", async () => {
    const root = await tempDir("pi-web-git-sync-detached-");
    const repo = join(root, "repo");
    await makeRepo(repo);
    await commitFile(repo, "tracked.txt", "one\n", "one");
    runGit(repo, "switch", "--detach");

    await expect(gitSync(repo)).rejects.toThrow("Cannot sync detached HEAD");
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
