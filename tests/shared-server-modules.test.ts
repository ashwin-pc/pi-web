import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  assertNoGitlinks,
  git,
  gitBuffer,
  gitCommitDetails,
  gitConfigEnv,
  gitConfigHardeningOverrides,
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

async function withPathPrefix<T>(path: string, callback: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${path}${delimiter}${original || ""}`;
  try {
    return await callback();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

async function withEnv<T>(key: string, value: string, callback: () => Promise<T>): Promise<T> {
  const original = process.env[key];
  process.env[key] = value;
  try {
    return await callback();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

async function withIsolatedGitConfig<T>(callback: () => Promise<T>): Promise<T> {
  const root = await tempDir("pi-web-shared-git-config-");
  const globalConfig = join(root, "global.gitconfig");
  await writeFile(globalConfig, "");
  return withEnv("GIT_CONFIG_NOSYSTEM", "1", () => withEnv("GIT_CONFIG_GLOBAL", globalConfig, callback));
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
    const overrides = gitConfigHardeningOverrides([
      { scope: "global", key: "credential.helper", value: "!trusted-helper" },
      { scope: "global", key: "core.sshcommand", value: "trusted-ssh" },
      { scope: "global", key: "gpg.ssh.defaultKeyCommand", value: "trusted-signing-key-command" },
      { scope: "local", key: "credential.helper", value: "!repo-helper" },
      { scope: "local", key: "core.sshcommand", value: "repo-ssh" },
      { scope: "local", key: "core.askpass", value: "repo-askpass" },
      { scope: "local", key: "core.gitproxy", value: "repo-proxy" },
      { scope: "local", key: "core.alternateRefsCommand", value: "repo-alternates" },
      { scope: "local", key: "gpg.program", value: "repo-gpg" },
      { scope: "local", key: "gpg.openpgp.program", value: "repo-openpgp" },
      { scope: "local", key: "gpg.x509.program", value: "repo-x509" },
      { scope: "local", key: "gpg.ssh.program", value: "repo-signing-ssh" },
      { scope: "local", key: "gpg.ssh.defaultKeyCommand", value: "repo-signing-key-command" },
      { scope: "local", key: "filter.repo.process", value: "repo-filter" },
      { scope: "local", key: "filter.repo.required", value: "true" },
      { scope: "local", key: "diff.repo.command", value: "repo-diff" },
      { scope: "local", key: "merge.repo.driver", value: "repo-merge" },
      { scope: "local", key: "protocol.allow", value: "always" },
      { scope: "local", key: "protocol.ext.allow", value: "always" },
      { scope: "local", key: "remote.origin.proxy", value: "repo-proxy" },
      { scope: "local", key: "remote.origin.vcs", value: "example" },
    ]);
    expect(overrides).toEqual(expect.arrayContaining([
      { key: "credential.helper", value: "" },
      { key: "credential.helper", value: "!trusted-helper" },
      { key: "core.sshcommand", value: "ssh" },
      { key: "core.sshcommand", value: "trusted-ssh" },
      { key: "core.askpass", value: "true" },
      { key: "core.gitproxy", value: "none" },
      { key: "core.alternateRefsCommand", value: "true" },
      { key: "gpg.program", value: "gpg" },
      { key: "gpg.openpgp.program", value: "gpg" },
      { key: "gpg.x509.program", value: "gpgsm" },
      { key: "gpg.ssh.program", value: "ssh-keygen" },
      { key: "gpg.ssh.defaultKeyCommand", value: "true" },
      { key: "gpg.ssh.defaultKeyCommand", value: "trusted-signing-key-command" },
      { key: "filter.repo.process", value: "" },
      { key: "filter.repo.required", value: "false" },
      { key: "diff.repo.command", value: "false" },
      { key: "merge.repo.driver", value: "false" },
      { key: "protocol.allow", value: "user" },
      { key: "protocol.ext.allow", value: "never" },
      { key: "remote.origin.proxy", value: "" },
    ]));
    const serialized = JSON.stringify(overrides);
    for (const unsafe of [
      "repo-helper", "repo-ssh", "repo-filter", "repo-merge", "repo-proxy", "repo-alternates",
      "repo-gpg", "repo-openpgp", "repo-x509", "repo-signing-ssh", "repo-signing-key-command",
    ]) expect(serialized).not.toContain(unsafe);

    const defaults = gitConfigHardeningOverrides([]);
    expect(defaults).toEqual(expect.arrayContaining([
      { key: "submodule.recurse", value: "false" },
      { key: "fetch.recurseSubmodules", value: "false" },
      { key: "diff.ignoreSubmodules", value: "dirty" },
      { key: "status.submoduleSummary", value: "false" },
      { key: "diff.submodule", value: "short" },
    ]));
    expect(defaults.map(({ key }) => key.toLowerCase())).not.toContain("core.sshcommand");
    expect(defaults.map(({ key }) => key.toLowerCase())).not.toContain("core.askpass");
    expect(defaults).toEqual(expect.arrayContaining([
      { key: "core.fsmonitor", value: "false" },
      { key: "core.gitproxy", value: "none" },
      { key: "core.alternateRefsCommand", value: "true" },
      { key: "gpg.program", value: "gpg" },
      { key: "gpg.openpgp.program", value: "gpg" },
      { key: "gpg.x509.program", value: "gpgsm" },
      { key: "gpg.ssh.program", value: "ssh-keygen" },
      { key: "gpg.ssh.defaultKeyCommand", value: "true" },
    ]));

    const trustedProtocol = gitConfigHardeningOverrides([
      { scope: "global", key: "protocol.allow", value: "always" },
      { scope: "local", key: "protocol.example.allow", value: "never" },
    ]);
    expect(trustedProtocol).toContainEqual({ key: "protocol.example.allow", value: "always" });

    expect(() => gitConfigHardeningOverrides([
      { scope: "local", key: "remote.ipv6.url", value: "git@[::1]:repo.git" },
      { scope: "local", key: "remote.local.url", value: "../repos/with::separator.git" },
      { scope: "local", key: "url.https://[::1]/mirror/.insteadOf", value: "mirror:" },
      { scope: "local", key: "remote.codecommit.vcs", value: "codecommit" },
      { scope: "local", key: "remote.persistent.vcs", value: "persistent-https" },
      { scope: "local", key: "remote.hg.vcs", value: "hg" },
      { scope: "local", key: "remote.s3.vcs", value: "s3" },
    ])).not.toThrow();
    expect(() => gitConfigHardeningOverrides([
      { scope: "local", key: "remote.control.vcs", value: "example\nhelper" },
    ])).toThrow("Unsafe Git remote helper identifier");
  });

  it("preserves exact filter subsection casing for required overrides", () => {
    const overrides = gitConfigHardeningOverrides([
      { scope: "global", key: "filter.foo.required", value: "true" },
      { scope: "local", key: "filter.Foo.clean", value: "repository-Foo" },
      { scope: "local", key: "filter.Foo.required", value: "true" },
      { scope: "local", key: "filter.foo.clean", value: "repository-foo" },
      { scope: "local", key: "filter.foo.required", value: "true" },
    ]);

    expect(overrides).toContainEqual({ key: "filter.Foo.required", value: "false" });
    expect(overrides).toContainEqual({ key: "filter.foo.required", value: "false" });
    expect(overrides).toContainEqual({ key: "filter.foo.required", value: "true" });
    expect(overrides.filter(({ key }) => key === "filter.Foo.required")).toEqual([
      { key: "filter.Foo.required", value: "false" },
    ]);
  });

  it("re-encodes bootstrap command config before hardening and clears inherited namespaces", () => {
    const env = gitConfigEnv([
      { key: "filter.a=b.clean", value: "" },
      { key: "filter.a=b.required", value: "false" },
    ], {
      PATH: "/trusted/bin",
      GIT_CONFIG_PARAMETERS: "'filter.a=b.required=true'",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "stale",
      GIT_CONFIG_KEY_1: "filter.a=b.required",
      GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_9: "stale.key",
      GIT_CONFIG_VALUE_9: "stale-value",
    }, [
      { key: "user.name", value: "Parameters caller" },
      { key: "user.email", value: "count@example.test" },
    ]);
    expect(env).toMatchObject({
      PATH: "/trusted/bin",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Parameters caller",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "count@example.test",
      GIT_CONFIG_KEY_2: "filter.a=b.clean",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "filter.a=b.required",
      GIT_CONFIG_VALUE_3: "false",
    });
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_9).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_9).toBeUndefined();
  });

  it("parses only Git mode fields when checking trees and raw history", () => {
    const hash = "1".repeat(40);
    expect(() => assertNoGitlinks(
      `100644 blob ${hash}\tflat 160000 name.txt\0`,
      "a tree",
      "tree",
    )).not.toThrow();
    expect(() => assertNoGitlinks(
      `\n:100644 100644 ${hash} ${hash} M\0:160000 160000 path spoof\0`,
      "raw history",
      "raw",
    )).not.toThrow();
    expect(() => assertNoGitlinks(
      `:100644 160000 ${hash} ${hash} M\0ordinary-path\0`,
      "raw history",
      "raw",
    )).toThrow(/raw history/);
  });

  it("normalizes inherited parameter and indexed config for text and buffer Git calls", async () => {
    const cwd = await makeRepo();
    await withIsolatedGitConfig(() =>
      withEnv("GIT_CONFIG_PARAMETERS", "'user.name=Parameters Caller' 'core.hooksPath=/parameter-hooks'", () =>
        withEnv("GIT_CONFIG_COUNT", "2", () =>
          withEnv("GIT_CONFIG_KEY_0", "user.email", () =>
            withEnv("GIT_CONFIG_VALUE_0", "count@example.test", () =>
              withEnv("GIT_CONFIG_KEY_1", "core.fsmonitor", () =>
                withEnv("GIT_CONFIG_VALUE_1", "parameter-fsmonitor", async () => {
                  await expect(git(["config", "--get", "user.name"], 15_000, cwd))
                    .resolves.toMatchObject({ stdout: "Parameters Caller\n" });
                  await expect(git(["config", "--get", "user.email"], 15_000, cwd))
                    .resolves.toMatchObject({ stdout: "count@example.test\n" });
                  await expect(git(["config", "--get", "core.fsmonitor"], 15_000, cwd))
                    .resolves.toMatchObject({ stdout: "false\n" });
                  await expect(gitBuffer(["config", "--get", "core.hooksPath"], 15_000, cwd))
                    .resolves.toEqual(Buffer.from("/dev/null\n"));
                })))))));
  });

  it("keeps a trusted global credential helper usable without running the repository helper", async () => {
    const cwd = await tempDir("pi-web-shared-git-credentials-");
    const trustedHelper = join(cwd, "trusted-helper.cjs");
    const repositoryHelper = join(cwd, "repository-helper.cjs");
    const repositoryMarker = join(cwd, "repository-helper-executed");
    await writeFile(trustedHelper, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("username=trusted\\npassword=secret\\n"));\n');
    await writeFile(repositoryHelper, `require("node:fs").writeFileSync(${JSON.stringify(repositoryMarker)}, "executed");\n`);
    const overrides = gitConfigHardeningOverrides([
      { scope: "global", key: "credential.helper", value: `!${JSON.stringify(process.execPath)} ${JSON.stringify(trustedHelper)}` },
      { scope: "local", key: "credential.helper", value: `!${JSON.stringify(process.execPath)} ${JSON.stringify(repositoryHelper)}` },
    ]);
    const output = execFileSync("git", ["credential", "fill"], {
      cwd,
      encoding: "utf8",
      input: "protocol=https\nhost=example.test\n\n",
      env: gitConfigEnv(overrides),
    });

    expect(output).toContain("username=trusted");
    expect(output).toContain("password=secret");
    await expect(access(repositoryMarker)).rejects.toThrow();
  });

  it("does not execute repository-configured fsmonitor, filter, hook, or diff commands", async () => {
    const cwd = await makeRepo();
    const fsmonitorMarker = join(cwd, "fsmonitor-executed");
    const filterMarker = join(cwd, "filter-executed");
    const hookMarker = join(cwd, "hook-executed");
    const diffMarker = join(cwd, "external-diff-executed");
    const driverMarker = join(cwd, "driver-diff-executed");
    const textconvMarker = join(cwd, "textconv-executed");
    const fsmonitor = join(cwd, "fsmonitor.cjs");
    const filter = join(cwd, "filter.cjs");
    const hook = join(cwd, ".git", "hooks", "post-merge");
    const externalDiff = join(cwd, "external-diff.cjs");
    const driverDiff = join(cwd, "driver-diff.cjs");
    const textconv = join(cwd, "textconv.cjs");
    await writeFile(fsmonitor, `require("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "executed");\n`);
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(filterMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    await writeFile(hook, `#!/bin/sh\nprintf executed > ${JSON.stringify(hookMarker)}\n`, { mode: 0o755 });
    await writeFile(externalDiff, `require("node:fs").writeFileSync(${JSON.stringify(diffMarker)}, "executed");\n`);
    await writeFile(driverDiff, `require("node:fs").writeFileSync(${JSON.stringify(driverMarker)}, "executed");\n`);
    await writeFile(textconv, `require("node:fs").writeFileSync(${JSON.stringify(textconvMarker)}, "executed");\n`);
    runGit(cwd, "config", "core.fsmonitor", `"${process.execPath}" "${fsmonitor}"`);
    runGit(cwd, "config", "filter.repo.clean", `"${process.execPath}" "${filter}"`);
    runGit(cwd, "config", "filter.repo.required", "true");
    runGit(cwd, "config", "diff.external", `"${process.execPath}" "${externalDiff}"`);
    runGit(cwd, "config", "diff.repo.command", `"${process.execPath}" "${driverDiff}"`);
    runGit(cwd, "config", "diff.repo.textconv", `"${process.execPath}" "${textconv}"`);
    await writeFile(join(cwd, ".gitattributes"), "tracked.txt filter=repo diff=repo\n");
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
    await expect(access(driverMarker)).rejects.toThrow();
    await expect(access(textconvMarker)).rejects.toThrow();
  });

  it("neutralizes a repository filter whose name contains an equals sign", async () => {
    const cwd = await makeRepo();
    const marker = join(cwd, "equals-filter-executed");
    const filter = join(cwd, "equals-filter.cjs");
    await writeFile(filter, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    runGit(cwd, "config", "filter.a=b.clean", `"${process.execPath}" "${filter}"`);
    runGit(cwd, "config", "filter.a=b.required", "true");
    await writeFile(join(cwd, ".gitattributes"), "tracked.txt filter=a=b\n");
    await writeFile(join(cwd, "tracked.txt"), "second\n");

    await expect(gitStatus(cwd)).resolves.toMatchObject({
      ok: true,
      isRepo: true,
      files: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt", label: "modified" })]),
    });
    await expect(gitSync(cwd)).rejects.toThrow(/repository-scoped filter driver config \(filter\.a=b\.clean\)/);
    await expect(access(marker)).rejects.toThrow();
  });

  it("preserves a trusted global required filter while suppressing the repository filter", async () => {
    const cwd = await makeRepo();
    const config = join(cwd, "trusted.gitconfig");
    const trustedFilter = join(cwd, "trusted-filter.cjs");
    const repositoryFilter = join(cwd, "repository-filter.cjs");
    const trustedMarker = join(cwd, "trusted-filter-executed");
    const repositoryMarker = join(cwd, "repository-filter-executed");
    await writeFile(trustedFilter, `require("node:fs").writeFileSync(${JSON.stringify(trustedMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    await writeFile(repositoryFilter, `require("node:fs").writeFileSync(${JSON.stringify(repositoryMarker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
    execFileSync("git", ["config", "--file", config, "filter.repo.clean", `"${process.execPath}" "${trustedFilter}"`]);
    execFileSync("git", ["config", "--file", config, "filter.repo.required", "true"]);
    runGit(cwd, "config", "filter.repo.clean", `"${process.execPath}" "${repositoryFilter}"`);
    runGit(cwd, "config", "filter.repo.required", "true");
    await writeFile(join(cwd, ".gitattributes"), "tracked.txt filter=repo\n");
    await writeFile(join(cwd, "tracked.txt"), "second\n");
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      await expect(gitStatus(cwd)).resolves.toMatchObject({ ok: true, isRepo: true });
    } finally {
      if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = original;
    }
    await expect(access(trustedMarker)).resolves.toBeUndefined();
    await expect(access(repositoryMarker)).rejects.toThrow();
  });

  it("uses the normal ssh executable for ssh URLs without running repository SSH commands", async () => {
    const cwd = await makeRepo();
    const remote = await tempDir("pi-web-shared-git-ssh-remote-");
    const bin = await tempDir("pi-web-shared-git-ssh-bin-");
    const marker = join(cwd, "ssh-stub-executed");
    const overrideMarker = join(cwd, "ssh-override-executed");
    const repositoryMarker = join(cwd, "repository-ssh-executed");
    const ssh = join(bin, "ssh");
    const overrideSsh = join(bin, "override-ssh");
    const repositorySsh = join(cwd, "repository-ssh.cjs");
    runGit(remote, "init", "--bare");
    runGit(cwd, "push", remote, "main");
    await writeFile(ssh, `#!/bin/sh
printf executed > ${JSON.stringify(marker)}
if [ "$1" = "-G" ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-F|-l) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec sh -c "$1"
`, { mode: 0o755 });
    await writeFile(overrideSsh, `#!/bin/sh
printf executed > ${JSON.stringify(overrideMarker)}
if [ "$1" = "-G" ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-F|-l) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec sh -c "$1"
`, { mode: 0o755 });
    await writeFile(repositorySsh, `require("node:fs").writeFileSync(${JSON.stringify(repositoryMarker)}, "executed");\n`);
    runGit(cwd, "config", "core.sshCommand", `"${process.execPath}" "${repositorySsh}"`);

    const result = await withIsolatedGitConfig(() => withPathPrefix(bin, () => git(["ls-remote", `ssh://example.test${remote}`], 15_000, cwd)));
    expect(result.stdout).toContain("refs/heads/main");
    await expect(access(marker)).resolves.toBeUndefined();
    await expect(access(repositoryMarker)).rejects.toThrow();

    const overridden = await withIsolatedGitConfig(() => withEnv("GIT_SSH_COMMAND", overrideSsh, () => git(["ls-remote", `ssh://example.test${remote}`], 15_000, cwd)));
    expect(overridden.stdout).toContain("refs/heads/main");
    await expect(access(overrideMarker)).resolves.toBeUndefined();
  });

  it("allows installed remote helpers while repository config cannot enable ext transport", async () => {
    const cwd = await makeRepo();
    const remote = await tempDir("pi-web-shared-git-helper-remote-");
    const bin = await tempDir("pi-web-shared-git-helper-bin-");
    const helperMarker = join(cwd, "remote-helper-executed");
    const extMarker = join(cwd, "ext-executed");
    const helper = join(bin, "git-remote-example");
    runGit(remote, "init", "--bare");
    runGit(cwd, "push", remote, "main");
    await writeFile(helper, `#!/bin/sh
printf executed > ${JSON.stringify(helperMarker)}
IFS= read -r command
[ "$command" = "capabilities" ] || exit 1
printf 'connect\\n\\n'
IFS= read -r command
[ "$command" = "connect git-upload-pack" ] || exit 1
printf '\\n'
exec git-upload-pack ${JSON.stringify(remote)}
`, { mode: 0o755 });

    const result = await withIsolatedGitConfig(() => withPathPrefix(bin, () => git(["ls-remote", `example::${remote}`], 15_000, cwd)));
    expect(result.stdout).toContain("refs/heads/main");
    await expect(access(helperMarker)).resolves.toBeUndefined();

    runGit(cwd, "config", "remote.helper.url", remote);
    runGit(cwd, "config", "remote.helper.vcs", "example");
    const configuredResult = await withIsolatedGitConfig(() => withPathPrefix(bin, () => git(["ls-remote", "helper"], 15_000, cwd)));
    expect(configuredResult.stdout).toContain("refs/heads/main");

    runGit(cwd, "config", "protocol.ext.allow", "always");
    await expect(withIsolatedGitConfig(() => git(["ls-remote", `ext::touch ${extMarker}`], 15_000, cwd))).rejects.toThrow();
    await expect(access(extMarker)).rejects.toThrow();
  });

  it("rejects unsafe remote vcs helper identifiers before the helper can run", async () => {
    const cwd = await makeRepo();
    const remote = await tempDir("pi-web-shared-git-vcs-remote-");
    const helperDirectory = join(cwd, "git-remote-example");
    const helper = join(cwd, "fixture-helper");
    const marker = join(cwd, "unsafe-vcs-helper-executed");
    runGit(remote, "init", "--bare");
    await mkdir(helperDirectory);
    await writeFile(helper, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    runGit(cwd, "config", "remote.origin.url", remote);
    runGit(cwd, "config", "remote.origin.vcs", "example/../fixture-helper");

    await expect(withIsolatedGitConfig(() => git(["ls-remote", "origin"], 15_000, cwd))).rejects.toThrow("Unsafe Git remote helper identifier");
    await expect(access(marker)).rejects.toThrow();
  });

  it("inspects repositories with scp-style IPv6 and local double-colon remote paths", async () => {
    const cwd = await makeRepo();
    const localRemote = await tempDir("pi-web-shared-git-local::remote-");
    runGit(localRemote, "init", "--bare");
    runGit(cwd, "remote", "add", "ipv6", "git@[::1]:repo.git");
    runGit(cwd, "remote", "add", "local", localRemote);

    await expect(withIsolatedGitConfig(() => gitStatus(cwd))).resolves.toMatchObject({ ok: true, isRepo: true });
    await expect(withIsolatedGitConfig(() => gitLog(cwd))).resolves.toMatchObject({ ok: true, isRepo: true });
  });

  it("does not run repository signature or alternate-ref programs", async () => {
    const cwd = await makeRepo();
    const signatureMarker = join(cwd, "signature-program-executed");
    const alternateMarker = join(cwd, "alternate-refs-executed");
    const signatureProgram = join(cwd, "signature-program.cjs");
    const alternateProgram = join(cwd, "alternate-refs.cjs");
    const tree = runGit(cwd, "rev-parse", "HEAD^{tree}");
    const signedCommit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd,
      encoding: "utf8",
      input: `tree ${tree}
author Pi Web Tests <pi-web@example.test> 1 +0000
committer Pi Web Tests <pi-web@example.test> 1 +0000
gpgsig -----BEGIN PGP SIGNATURE-----
 fake
 -----END PGP SIGNATURE-----

signed fixture
`,
    }).trim();
    runGit(cwd, "update-ref", "refs/heads/signed-fixture", signedCommit);
    await writeFile(signatureProgram, `require("node:fs").writeFileSync(${JSON.stringify(signatureMarker)}, "executed");\n`);
    runGit(cwd, "config", "gpg.program", `"${process.execPath}" "${signatureProgram}"`);
    runGit(cwd, "config", "log.showSignature", "true");

    await expect(gitLog(cwd)).resolves.toMatchObject({ ok: true, isRepo: true });
    await expect(gitCommitDetails(signedCommit, cwd)).resolves.toMatchObject({ ok: true, commit: { hash: signedCommit } });
    await expect(access(signatureMarker)).rejects.toThrow();

    const alternate = await makeRepo();
    const remote = await tempDir("pi-web-shared-git-alternate-remote-");
    await mkdir(join(cwd, ".git", "objects", "info"), { recursive: true });
    await writeFile(join(cwd, ".git", "objects", "info", "alternates"), `${join(alternate, ".git", "objects")}\n`);
    runGit(remote, "init", "--bare");
    runGit(alternate, "push", remote, "main");
    runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await writeFile(alternateProgram, `require("node:fs").writeFileSync(${JSON.stringify(alternateMarker)}, "executed");\n`);
    runGit(cwd, "config", "core.alternateRefsCommand", `"${process.execPath}" "${alternateProgram}"`);
    await expect(withIsolatedGitConfig(() => git(["fetch", "--prune", remote], 15_000, cwd))).resolves.toMatchObject({});
    await expect(access(alternateMarker)).rejects.toThrow();
  });

  it("does not run a repository default SSH signing-key command", async () => {
    const cwd = await makeRepo();
    const marker = join(cwd, "default-signing-key-command-executed");
    const command = join(cwd, "default-signing-key-command.cjs");
    await writeFile(command, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("key::synthetic");\n`);
    runGit(cwd, "config", "gpg.format", "ssh");
    runGit(cwd, "config", "commit.gpgSign", "true");
    runGit(cwd, "config", "gpg.ssh.defaultKeyCommand", `"${process.execPath}" "${command}"`);

    await expect(withIsolatedGitConfig(() => git(["commit", "--allow-empty", "-m", "synthetic signed commit"], 15_000, cwd))).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
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
    await rm(child, { recursive: true });

    const remote = await tempDir("pi-web-shared-git-remote-");
    runGit(remote, "init", "--bare");
    runGit(cwd, "remote", "add", "origin", remote);
    runGit(cwd, "add", "tracked.txt", "untracked.txt", "image.png");
    runGit(cwd, "commit", "-m", "update");
    runGit(cwd, "push", "-u", "origin", "main");
    await expect(gitSync(cwd)).resolves.toMatchObject({ ok: true, status: { isRepo: true, branch: "main" } });
  }, 15_000);

  it("syncs an advancing flat repository with a dirty parent from a nested directory", async () => {
    const cwd = await makeRepo();
    const remote = await tempDir("pi-web-shared-git-flat-remote-");
    const updater = await tempDir("pi-web-shared-git-flat-updater-");
    const nested = join(cwd, "nested");
    const treeSpoof = "flat 160000 name.txt";
    const rawSpoof = ":160000 160000 path spoof.txt";
    await writeFile(join(cwd, treeSpoof), "ordinary tracked file\n");
    runGit(cwd, "add", treeSpoof);
    runGit(cwd, "commit", "-m", "add mode-like filename");
    runGit(remote, "init", "--bare", "-b", "main");
    runGit(cwd, "remote", "add", "origin", remote);
    runGit(cwd, "push", "-u", "origin", "main");
    await writeFile(join(cwd, rawSpoof), "ordinary replayed file\n");
    runGit(cwd, "--literal-pathspecs", "add", rawSpoof);
    runGit(cwd, "commit", "-m", "add raw-metadata-like filename");
    runGit(updater, "clone", remote, ".");
    runGit(updater, "config", "user.name", "Pi Web Tests");
    runGit(updater, "config", "user.email", "pi-web@example.test");
    await writeFile(join(updater, "remote.txt"), "remote advance\n");
    runGit(updater, "add", "remote.txt");
    runGit(updater, "commit", "-m", "remote advance");
    runGit(updater, "push", "origin", "main");
    await mkdir(nested);
    await writeFile(join(cwd, "tracked.txt"), "preserved local edit\n");

    await expect(gitSync(nested)).resolves.toMatchObject({
      ok: true,
      status: {
        root: await realpath(cwd),
        files: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt", label: "modified" })]),
      },
    });
    await expect(access(join(cwd, "remote.txt"))).resolves.toBeUndefined();
    await expect(access(join(cwd, treeSpoof))).resolves.toBeUndefined();
    await expect(access(join(cwd, rawSpoof))).resolves.toBeUndefined();
  });

  it("allows contained image symlinks but rejects escapes and non-files", async () => {
    const cwd = await makeRepo();
    const outside = await tempDir("pi-web-shared-git-outside-");
    await writeFile(join(outside, "secret.png"), "outside");
    await symlink(join(outside, "secret.png"), join(cwd, "leaf.png"));
    await symlink(outside, join(cwd, "linked"));
    await symlink(join(cwd, "image.png"), join(cwd, "contained.png"));
    await mkdir(join(cwd, "directory.png"));

    await expect(readGitImage({ cwd, path: "contained.png", version: "after", staged: false })).resolves.toMatchObject({
      file: await realpath(join(cwd, "image.png")),
      displayPath: "contained.png",
    });
    await expect(readGitImage({ cwd, path: "leaf.png", version: "after", staged: false })).rejects.toThrow("outside the repository");
    await expect(readGitImage({ cwd, path: "linked/secret.png", version: "after", staged: false })).rejects.toThrow("outside the repository");
    await expect(readGitImage({ cwd, path: "directory.png", version: "after", staged: false })).rejects.toThrow("Image not found");
  });
});
