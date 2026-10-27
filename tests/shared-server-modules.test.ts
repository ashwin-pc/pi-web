import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactDirForCwd,
  findArtifactFile,
  isValidArtifactName,
  isValidArtifactPath,
  legacyArtifactDirForCwd,
  readArtifactBase64,
  safeArtifactName,
} from "../server/shared/artifacts.js";
import { assertDirectory, createDirectory, listDirectories } from "../server/shared/fsList.js";
import {
  git,
  gitCommitDetails,
  gitConfigHardeningArgs,
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
    await mkdir(join(currentDir, "image-edits", "run-1"), { recursive: true });
    await writeFile(join(currentDir, "image-edits", "run-1", "output.png"), "nested");
    await writeFile(join(legacyDir, "report.txt"), "legacy");

    expect(safeArtifactName("../report.txt")).toBe("_report.txt");
    expect(isValidArtifactName("report.txt")).toBe(true);
    expect(isValidArtifactName("../report.txt")).toBe(false);
    expect(isValidArtifactPath("image-edits/run-1/output.png")).toBe(true);
    expect(isValidArtifactPath("image-edits/../report.txt")).toBe(false);
    expect(findArtifactFile([root], "report.txt")).toBe(join(currentDir, "report.txt"));
    expect(findArtifactFile([root], "image-edits/run-1/output.png")).toBe(join(currentDir, "image-edits", "run-1", "output.png"));
    expect(await readArtifactBase64(root, "report.txt")).toEqual({
      ok: true,
      name: "report.txt",
      base64: Buffer.from("current").toString("base64"),
    });
    await expect(readArtifactBase64(root, "report.txt", 2)).rejects.toThrow("too large");
  });
});

describe("shared Git helpers", () => {
  it("keeps trusted authentication commands while replacing repository-controlled commands", () => {
    const args = gitConfigHardeningArgs([
      { scope: "global", key: "credential.helper", value: "!trusted-helper" },
      { scope: "global", key: "core.sshcommand", value: "trusted-ssh" },
      { scope: "local", key: "credential.helper", value: "!repo-helper" },
      { scope: "local", key: "core.sshcommand", value: "repo-ssh" },
      { scope: "local", key: "filter.repo.process", value: "repo-filter" },
      { scope: "local", key: "merge.repo.driver", value: "repo-merge" },
      { scope: "local", key: "protocol.ext.allow", value: "always" },
      { scope: "local", key: "remote.origin.proxy", value: "repo-proxy" },
    ]);
    expect(args).toEqual(expect.arrayContaining([
      "-c", "credential.helper=",
      "-c", "credential.helper=!trusted-helper",
      "-c", "core.sshcommand=",
      "-c", "core.sshcommand=trusted-ssh",
      "-c", "filter.repo.process=",
      "-c", "merge.repo.driver=",
      "-c", "protocol.ext.allow=never",
      "-c", "remote.origin.proxy=",
    ]));
    expect(args.join("\0")).not.toContain("repo-helper");
    expect(args.join("\0")).not.toContain("repo-ssh");
    expect(args.join("\0")).not.toContain("repo-filter");
    expect(args.join("\0")).not.toContain("repo-merge");
    expect(args.join("\0")).not.toContain("repo-proxy");
  });

  it("keeps a trusted global credential helper usable without running the repository helper", async () => {
    const cwd = await tempDir("pi-web-shared-git-credentials-");
    const trustedHelper = join(cwd, "trusted-helper.cjs");
    const repositoryHelper = join(cwd, "repository-helper.cjs");
    const repositoryMarker = join(cwd, "repository-helper-executed");
    await writeFile(trustedHelper, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("username=trusted\\npassword=secret\\n"));\n');
    await writeFile(repositoryHelper, `require("node:fs").writeFileSync(${JSON.stringify(repositoryMarker)}, "executed");\n`);
    const args = gitConfigHardeningArgs([
      { scope: "global", key: "credential.helper", value: `!${JSON.stringify(process.execPath)} ${JSON.stringify(trustedHelper)}` },
      { scope: "local", key: "credential.helper", value: `!${JSON.stringify(process.execPath)} ${JSON.stringify(repositoryHelper)}` },
    ]);
    const output = execFileSync("git", [...args, "credential", "fill"], {
      cwd,
      encoding: "utf8",
      input: "protocol=https\nhost=example.test\n\n",
    });

    expect(output).toContain("username=trusted");
    expect(output).toContain("password=secret");
    await expect(access(repositoryMarker)).rejects.toThrow();
  });

  it("does not execute repository-configured fsmonitor, filter, hook, or external diff commands", async () => {
    const cwd = await makeRepo();
    const fsmonitorMarker = join(cwd, "fsmonitor-executed");
    const filterMarker = join(cwd, "filter-executed");
    const hookMarker = join(cwd, "hook-executed");
    const diffMarker = join(cwd, "external-diff-executed");
    const fsmonitor = join(cwd, "fsmonitor.cjs");
    const filter = join(cwd, "filter.cjs");
    const hook = join(cwd, ".git", "hooks", "post-merge");
    const externalDiff = join(cwd, "external-diff.cjs");
    await writeFile(fsmonitor, `require("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "executed");\n`);
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(filterMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    await writeFile(hook, `#!/bin/sh\nprintf executed > ${JSON.stringify(hookMarker)}\n`, { mode: 0o755 });
    await writeFile(externalDiff, `require("node:fs").writeFileSync(${JSON.stringify(diffMarker)}, "executed");\n`);
    runGit(cwd, "config", "core.fsmonitor", `"${process.execPath}" "${fsmonitor}"`);
    runGit(cwd, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);
    runGit(cwd, "config", "diff.external", `"${process.execPath}" "${externalDiff}"`);
    await writeFile(join(cwd, ".gitattributes"), "tracked.txt filter=repo\n");
    await writeFile(join(cwd, "tracked.txt"), "second\n");

    await expect(gitStatus(cwd)).resolves.toMatchObject({ ok: true, isRepo: true });
    await expect(gitDiff({ cwd, path: "tracked.txt", staged: false })).resolves.toMatchObject({
      ok: true,
      diff: expect.stringContaining("+second"),
    });
    await expect(git(["hook", "run", "post-merge"], 15_000, cwd)).rejects.toThrow();
    await expect(access(fsmonitorMarker)).rejects.toThrow();
    await expect(access(filterMarker)).rejects.toThrow();
    await expect(access(hookMarker)).rejects.toThrow();
    await expect(access(diffMarker)).rejects.toThrow();
  });

  it("covers status, diff, history, images, repository discovery, and sync", async () => {
    const cwd = await makeRepo();
    const initialHash = runGit(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "tracked.txt"), "second\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    runGit(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "image.png"), Buffer.from([4, 5, 6]));

    const status = await gitStatus(cwd);
    expect(status).toMatchObject({ ok: true, isRepo: true, branch: "main", ahead: 0, behind: 0 });
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", label: "modified" }),
      expect.objectContaining({ path: "untracked.txt", label: "untracked" }),
    ]));
    expect(status.diffStats).toEqual({
      staged: { files: 1, additions: 1, deletions: 0 },
      unstaged: { files: 3, additions: 2, deletions: 2 },
    });

    expect(await gitDiff({ cwd, path: "tracked.txt", staged: false })).toMatchObject({ ok: true, path: "tracked.txt", diff: expect.stringContaining("+second") });
    expect(await gitDiff({ cwd, path: "untracked.txt", staged: false })).toMatchObject({ diff: expect.stringContaining("+new") });
    expect(await gitLog(cwd)).toMatchObject({ ok: true, isRepo: true, commits: [expect.objectContaining({ hash: initialHash, subject: "initial" })] });
    expect(await gitCommitDetails(initialHash, cwd)).toMatchObject({ ok: true, commit: { hash: initialHash, subject: "initial" } });

    const beforeImage = await readGitImage({ cwd, path: "image.png", version: "before", staged: false });
    const afterImage = await readGitImage({ cwd, path: "image.png", version: "after", staged: false });
    expect(beforeImage?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(afterImage).toMatchObject({ file: await realpath(join(cwd, "image.png")), displayPath: "image.png" });
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

  it("rejects image symlinks, parent-symlink escapes, and non-files", async () => {
    const cwd = await makeRepo();
    const outside = await tempDir("pi-web-shared-git-outside-");
    await writeFile(join(outside, "secret.png"), "outside");
    await symlink(join(outside, "secret.png"), join(cwd, "leaf.png"));
    await symlink(outside, join(cwd, "linked"));
    await mkdir(join(cwd, "directory.png"));

    await expect(readGitImage({ cwd, path: "leaf.png", version: "after", staged: false })).rejects.toThrow("outside the repository");
    await expect(readGitImage({ cwd, path: "linked/secret.png", version: "after", staged: false })).rejects.toThrow("outside the repository");
    await expect(readGitImage({ cwd, path: "directory.png", version: "after", staged: false })).rejects.toThrow("Image not found");
  });
});
