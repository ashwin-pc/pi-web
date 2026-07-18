import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDirForCwd, readArtifactBase64, safeArtifactName } from "../server/shared/artifacts.js";
import { createDirectory, listDirectories } from "../server/shared/fsList.js";
import { git, gitCommitDetails, gitDiff, gitImageBase64, gitLog, gitStatus, listGitRepos } from "../server/shared/git.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-shared-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared box-local services", () => {
  it("lists and creates directories without allowing path traversal", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "existing"));

    await expect(listDirectories(root)).resolves.toMatchObject({
      ok: true,
      path: root,
      dirs: [{ name: "existing", path: join(root, "existing") }],
    });
    await expect(createDirectory(root, "created")).resolves.toMatchObject({ path: join(root, "created") });
    await expect(createDirectory(root, "../escape")).rejects.toThrow(/single directory name/);
  });

  it("normalizes artifact names and enforces base64 read limits", async () => {
    const root = await tempRoot();
    const artifactDir = artifactDirForCwd(root);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "report.txt"), "runtime artifact");

    expect(safeArtifactName("../unsafe report.txt")).toBe("_unsafe_report.txt");
    await expect(readArtifactBase64(root, "report.txt", 100)).resolves.toMatchObject({
      ok: true,
      name: "report.txt",
      base64: Buffer.from("runtime artifact").toString("base64"),
    });
    await expect(readArtifactBase64(root, "report.txt", 2)).rejects.toThrow(/Artifact is too large/);
  });

  it("provides status, diff, history, commit, image, and repository projections", async () => {
    const root = await tempRoot();
    await execFileAsync("git", ["init"], { cwd: root });
    await git(["config", "user.email", "pi-web@example.test"], 15_000, root);
    await git(["config", "user.name", "pi-web test"], 15_000, root);
    await writeFile(join(root, "README.md"), "before\n");
    await writeFile(join(root, "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await git(["add", "."], 15_000, root);
    await git(["commit", "-m", "initial"], 15_000, root);
    const { stdout: hashOut } = await git(["rev-parse", "HEAD"], 15_000, root);
    const hash = hashOut.trim();
    await writeFile(join(root, "README.md"), "after\n");

    await expect(gitStatus(root)).resolves.toMatchObject({ isRepo: true, files: [{ path: "README.md", label: "modified" }] });
    await expect(gitDiff({ cwd: root, path: "README.md" })).resolves.toMatchObject({ path: "README.md", diff: expect.stringContaining("+after") });
    await expect(gitLog(root)).resolves.toMatchObject({ isRepo: true, commits: [{ subject: "initial" }] });
    await expect(gitCommitDetails(hash, root)).resolves.toMatchObject({ commit: { hash, subject: "initial" } });
    await expect(gitImageBase64({ cwd: root, path: "pixel.png", version: "before", staged: false })).resolves.toMatchObject({
      ok: true,
      path: "pixel.png",
      base64: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
    });
    await expect(listGitRepos(root)).resolves.toMatchObject({ ok: true, repos: [{ path: ".", isCurrent: true }] });
  });
});
