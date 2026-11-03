import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitConfigEntry = { scope: string; key: string; value: string };
export type GitConfigOverride = { key: string; value: string };

const trustedConfigScopes = new Set(["system", "global"]);
const unconditionalExecutableConfigDefaults = new Map([
  ["core.fsmonitor", "false"],
  ["core.gitproxy", "none"],
  ["core.alternateRefsCommand", "true"],
  ["core.editor", "true"],
  ["sequence.editor", "true"],
  ["gpg.program", "gpg"],
  ["gpg.openpgp.program", "gpg"],
  ["gpg.x509.program", "gpgsm"],
  ["gpg.ssh.program", "ssh-keygen"],
  ["gpg.ssh.defaultKeyCommand", "true"],
]);
const conditionalExecutableConfigDefaults = new Map([
  ["core.sshCommand", "ssh"],
  ["core.askPass", "true"],
]);
const defaultProtocolPolicies = new Map([
  ["protocol.allow", "user"],
  ["protocol.ext.allow", "never"],
  ["protocol.git.allow", "always"],
  ["protocol.http.allow", "always"],
  ["protocol.https.allow", "always"],
  ["protocol.ssh.allow", "always"],
]);
const remoteHelperIdentifier = /^[A-Za-z][A-Za-z0-9+.-]*$/;

function subsectionConfigKey(key: string) {
  const sectionSeparator = key.indexOf(".");
  const separator = key.lastIndexOf(".");
  if (sectionSeparator <= 0 || separator <= sectionSeparator + 1) return undefined;
  const section = key.slice(0, sectionSeparator).toLowerCase();
  if (!["filter", "remote", "tar", "url"].includes(section)) return undefined;
  return {
    section,
    subsection: key.slice(sectionSeparator + 1, separator),
    variable: key.slice(separator + 1).toLowerCase(),
  };
}

function configKeysEqual(left: string, right: string) {
  const leftSubsection = subsectionConfigKey(left);
  const rightSubsection = subsectionConfigKey(right);
  if (leftSubsection || rightSubsection) {
    return leftSubsection !== undefined &&
      rightSubsection !== undefined &&
      leftSubsection.section === rightSubsection.section &&
      leftSubsection.subsection === rightSubsection.subsection &&
      leftSubsection.variable === rightSubsection.variable;
  }
  return left.toLowerCase() === right.toLowerCase();
}

function parseGitConfig(output: string): GitConfigEntry[] {
  const fields = output.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index] || "";
    const separator = fields[index + 1].indexOf("\n");
    const key = separator < 0 ? fields[index + 1] : fields[index + 1].slice(0, separator);
    const value = separator < 0 ? "" : fields[index + 1].slice(separator + 1);
    if (scope && key) entries.push({ scope, key, value });
  }
  return entries;
}

function assertSafeRemoteConfig(entries: GitConfigEntry[]) {
  for (const entry of entries) {
    if (!/^remote\..+\.vcs$/i.test(entry.key)) continue;
    if (!remoteHelperIdentifier.test(entry.value)) {
      throw new Error(`Unsafe Git remote helper identifier: ${JSON.stringify(entry.value)}`);
    }
  }
}

function isUrlRewriteKey(key: string) {
  const normalized = key.toLowerCase();
  return normalized.startsWith("url.") && /\.(?:insteadof|pushinsteadof)$/.test(normalized);
}

export function isGitNetworkCommand(command: string | undefined) {
  return command !== undefined && ["fetch", "pull", "push", "ls-remote"].includes(command);
}

export function gitConfigHardeningOverrides(entries: GitConfigEntry[]): GitConfigOverride[] {
  assertSafeRemoteConfig(entries);
  const trusted = entries.filter((entry) => trustedConfigScopes.has(entry.scope));
  const repository = entries.filter((entry) => entry.scope === "local" || entry.scope === "worktree");
  const repositoryKeys = new Map(repository.map((entry) => [entry.key.toLowerCase(), entry.key]));
  const trustedProtocolAllow = trusted.filter((entry) => entry.key.toLowerCase() === "protocol.allow").at(-1)?.value;
  const overrides: GitConfigOverride[] = [];
  const add = (key: string, value: string) => overrides.push({ key, value });
  const resetToTrusted = (key: string, fallback?: string) => {
    if (fallback !== undefined) add(key, fallback);
    for (const entry of trusted) if (configKeysEqual(entry.key, key)) add(entry.key, entry.value);
  };
  const safeFallback = (key: string) => {
    if (key === "protocol.allow") return "user";
    if (key.startsWith("protocol.")) return trustedProtocolAllow ?? defaultProtocolPolicies.get(key) ?? "user";
    if (key.endsWith(".uploadpack")) return "git-upload-pack";
    if (key.endsWith(".receivepack")) return "git-receive-pack";
    if (key.endsWith(".proxy")) return "";
    if (key.endsWith(".promisor")) return "false";
    if (key.startsWith("diff.") || key.startsWith("merge.")) return "false";
    if (key.startsWith("tar.") && key.endsWith(".command")) return "false";
    return "";
  };

  resetToTrusted("core.hookspath", "/dev/null");
  add("submodule.recurse", "false");
  add("fetch.recurseSubmodules", "false");
  add("diff.ignoreSubmodules", "dirty");
  add("status.submoduleSummary", "false");
  add("diff.submodule", "short");
  for (const [key, fallback] of unconditionalExecutableConfigDefaults) resetToTrusted(key, fallback);
  for (const [key, fallback] of conditionalExecutableConfigDefaults) {
    const repositoryKey = repositoryKeys.get(key.toLowerCase());
    if (repositoryKey) resetToTrusted(repositoryKey, fallback);
  }

  const repositoryConfigKeys = new Set(repository.map((entry) => entry.key));
  for (const key of repositoryConfigKeys) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("url.") && /\.(?:insteadof|pushinsteadof)$/.test(normalized)) resetToTrusted(key);
    if ((normalized.startsWith("remote.") && /\.(?:promisor|partialclonefilter)$/.test(normalized)) || normalized === "extensions.partialclone") resetToTrusted(key, safeFallback(normalized));
    if (normalized.startsWith("tar.") && normalized.endsWith(".command")) resetToTrusted(key, "false");
  }

  const neutralizedFilters = new Set<string>();
  for (const key of [...repositoryConfigKeys].filter((key) => {
    const normalized = key.toLowerCase();
    return normalized === "credential.helper" ||
      /^credential\..+\.helper$/.test(normalized) ||
      /^filter\..+\.(?:clean|smudge|process)$/.test(normalized) ||
      normalized === "diff.external" ||
      /^diff\..+\.(?:command|textconv)$/.test(normalized) ||
      /^merge\..+\.driver$/.test(normalized) ||
      normalized === "protocol.allow" ||
      /^protocol\..+\.allow$/.test(normalized) ||
      /^remote\..+\.(?:proxy|uploadpack|receivepack)$/.test(normalized);
  })) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("filter.")) neutralizedFilters.add(key.slice(0, key.lastIndexOf(".")));
    resetToTrusted(key, safeFallback(normalized));
  }
  for (const filter of neutralizedFilters) {
    resetToTrusted(`${filter}.required`, "false");
  }
  if (repositoryKeys.has("protocol.allow") && trustedProtocolAllow === undefined) {
    for (const [key, fallback] of defaultProtocolPolicies) {
      if (key === "protocol.allow" || repositoryKeys.has(key)) continue;
      resetToTrusted(key, fallback);
    }
  }
  return overrides;
}

export function gitConfigEnv(
  overrides: GitConfigOverride[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  inheritedCommandConfig: GitConfigOverride[] = [],
) {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    // Git 2.44+ honors this; older versions ignore the unknown environment variable.
    GIT_NO_LAZY_FETCH: "1",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  const commandConfig = [...inheritedCommandConfig, ...overrides];
  commandConfig.forEach(({ key, value }, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(commandConfig.length);
  return env;
}

export type GitExecution = {
  entries: GitConfigEntry[];
  hasRepositoryUrlRewrites: boolean;
  env: NodeJS.ProcessEnv;
  args: (args: string[]) => string[];
};

export async function loadGitExecution(cwd: string): Promise<GitExecution> {
  const bootstrapEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const { stdout } = await execFileAsync("git", ["config", "--null", "--show-scope", "--list"], {
    cwd,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    env: bootstrapEnv,
  });
  const entries = parseGitConfig(stdout);
  const inheritedCommandConfig = entries
    .filter((entry) => entry.scope === "command")
    .map(({ key, value }) => ({ key, value }));
  const hasRepositoryUrlRewrites = entries.some(
    (entry) => (entry.scope === "local" || entry.scope === "worktree") && isUrlRewriteKey(entry.key),
  );
  const env = gitConfigEnv(gitConfigHardeningOverrides(entries), bootstrapEnv, inheritedCommandConfig);
  return {
    entries,
    hasRepositoryUrlRewrites,
    env,
    args(args) {
      const [command, ...commandArgs] = args;
      if (hasRepositoryUrlRewrites && isGitNetworkCommand(command)) {
        throw new Error(`Git ${command} is disabled because this repository configures URL rewrites`);
      }
      const displayHardening = ["diff", "show", "log"].includes(command) ? ["--no-ext-diff", "--no-textconv"] : [];
      const signatureHardening = ["show", "log"].includes(command) ? ["--no-show-signature"] : [];
      const submoduleDisplayPolicy = ["status", "diff"].includes(command) ? ["--ignore-submodules=dirty"] : [];
      const submoduleNetworkPolicy = ["fetch", "pull"].includes(command) ? ["--no-recurse-submodules"] : [];
      return [
        "--no-optional-locks",
        command,
        ...displayHardening,
        ...signatureHardening,
        ...submoduleDisplayPolicy,
        ...submoduleNetworkPolicy,
        ...commandArgs,
      ];
    },
  };
}
