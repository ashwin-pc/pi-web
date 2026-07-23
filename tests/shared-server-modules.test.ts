import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactDirForCwd,
  findArtifactFile,
  isValidArtifactName,
  legacyArtifactDirForCwd,
  readArtifactBase64,
  safeArtifactName,
} from "../server/shared/artifacts.js";
import { assertDirectory, createDirectory, listDirectories } from "../server/shared/fsList.js";
import {
  gitCommitDetails,
  gitCwdFromRepoParam,
  gitDiff,
  gitLog,
  gitStatus,
  gitSync,
  listGitRepos,
  readGitImage,
} from "../server/shared/git.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function runGit(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo() {
  const cwd = await tempDir("pi-web-shared-git-");
  runGit(cwd, "init", "-b", "main");
  runGit(cwd, "config", "user.name", "Pi Web Tests");
  runGit(cwd, "config", "user.email", "pi-web@example.test");
  await writeFile(join(cwd, "tracked.txt"), "first\n");
  await writeFile(join(cwd, "image.png"), Buffer.from([1, 2, 3]));
  runGit(cwd, "add", ".");
  runGit(cwd, "commit", "-m", "initial");
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared filesystem helpers", () => {
  it("lists and creates only direct child directories", async () => {
    const root = await tempDir("pi-web-shared-fs-");
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, "alpha"));
    await writeFile(join(root, "file.txt"), "not a directory");

    const listing = await listDirectories(root);
    expect(listing).toEqual({
      ok: true,
      path: root,
      parent: join(root, ".."),
      dirs: [
        { name: "alpha", path: join(root, "alpha") },
        { name: "zeta", path: join(root, "zeta") },
      ],
    });

    const created = await createDirectory(root, "new-folder");
    expect(created.path).toBe(join(root, "new-folder"));
    await expect(createDirectory(root, "../escape")).rejects.toThrow("single directory name");
    await expect(assertDirectory(join(root, "file.txt"))).rejects.toThrow("not a directory");
  });
});

describe("shared artifact helpers", () => {
  it("validates names and resolves current storage before the legacy fallback", async () => {
    const root = await tempDir("pi-web-shared-artifacts-");
    const currentDir = artifactDirForCwd(root);
    const legacyDir = legacyArtifactDirForCwd(root);
    await mkdir(currentDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(currentDir, "report.txt"), "current");
    await writeFile(join(legacyDir, "report.txt"), "legacy");

    expect(safeArtifactName("../report.txt")).toBe("_report.txt");
    expect(isValidArtifactName("report.txt")).toBe(true);
    expect(isValidArtifactName("../report.txt")).toBe(false);
    expect(findArtifactFile([root], "report.txt")).toBe(join(currentDir, "report.txt"));
    expect(await readArtifactBase64(root, "report.txt")).toEqual({
      ok: true,
      name: "report.txt",
      base64: Buffer.from("current").toString("base64"),
    });
    await expect(readArtifactBase64(root, "report.txt", 2)).rejects.toThrow("too large");
  });
});

describe("shared Git helpers", () => {
  it("covers status, diff, history, images, repository discovery, and sync", async () => {
    const cwd = await makeRepo();
    const initialHash = runGit(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "tracked.txt"), "second\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    await writeFile(join(cwd, "image.png"), Buffer.from([4, 5, 6]));

    const status = await gitStatus(cwd);
    expect(status).toMatchObject({ ok: true, isRepo: true, branch: "main", ahead: 0, behind: 0 });
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", label: "modified" }),
      expect.objectContaining({ path: "untracked.txt", label: "untracked" }),
    ]));

    expect(await gitDiff({ cwd, path: "tracked.txt", staged: false })).toMatchObject({ ok: true, path: "tracked.txt", diff: expect.stringContaining("+second") });
    expect(await gitDiff({ cwd, path: "untracked.txt", staged: false })).toMatchObject({ diff: expect.stringContaining("+new") });
    expect(await gitLog(cwd)).toMatchObject({ ok: true, isRepo: true, commits: [expect.objectContaining({ hash: initialHash, subject: "initial" })] });
    expect(await gitCommitDetails(initialHash, cwd)).toMatchObject({ ok: true, commit: { hash: initialHash, subject: "initial" } });

    const beforeImage = await readGitImage({ cwd, path: "image.png", version: "before", staged: false });
    const afterImage = await readGitImage({ cwd, path: "image.png", version: "after", staged: false });
    expect(beforeImage?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(afterImage).toMatchObject({ file: join(cwd, "image.png"), displayPath: "image.png" });
    expect(await readGitImage({ cwd, path: "tracked.txt", version: "after", staged: false })).toBeUndefined();

    const child = join(cwd, "child");
    await mkdir(child);
    runGit(child, "init", "-b", "main");
    runGit(child, "config", "user.name", "Pi Web Tests");
    runGit(child, "config", "user.email", "pi-web@example.test");
    await writeFile(join(child, "README.md"), "child\n");
    runGit(child, "add", ".");
    runGit(child, "commit", "-m", "child initial");
    const repos = await listGitRepos(cwd);
    expect(repos.repos.map((repo) => repo.path)).toEqual([".", "child"]);
    expect(await gitCwdFromRepoParam("child", cwd)).toBe(child);
    await expect(gitCwdFromRepoParam("../outside", cwd)).rejects.toThrow("outside the workspace");

    const remote = await tempDir("pi-web-shared-git-remote-");
    runGit(remote, "init", "--bare");
    runGit(cwd, "remote", "add", "origin", remote);
    runGit(cwd, "add", "tracked.txt", "untracked.txt", "image.png");
    runGit(cwd, "commit", "-m", "update");
    runGit(cwd, "push", "-u", "origin", "main");
    await expect(gitSync(cwd)).resolves.toMatchObject({ ok: true, status: { isRepo: true, branch: "main" } });
  }, 15_000);
});
