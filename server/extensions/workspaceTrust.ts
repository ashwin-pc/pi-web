import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import {
  discoverExtensionEntryPaths,
  resolveWorkspacePiWebExtensionPaths,
} from "../extensions.js";

export type WorkspaceTrustResource = {
  kind: "extension" | "package" | "resource";
  path: string;
};

export type WorkspaceExtensionTrustStatus = {
  workspace: string;
  trusted: boolean;
  resources: WorkspaceTrustResource[];
  trustedWorkspaces: string[];
};

export function realWorkspacePath(cwd: string): string {
  return realpathSync.native(cwd);
}

function canonicalExtensionPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function projectSettingsResources(workspace: string): WorkspaceTrustResource[] {
  const settingsPath = join(workspace, ".pi", "settings.json");
  if (!existsSync(settingsPath)) return [];
  const fallback: WorkspaceTrustResource = { kind: "resource", path: ".pi/settings.json" };
  try {
    const value = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      packages?: unknown;
      extensions?: unknown;
    };
    const resources: WorkspaceTrustResource[] = [];
    if (Array.isArray(value.packages)) {
      for (const entry of value.packages) {
        const source = typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as { source?: unknown }).source
            : undefined;
        if (typeof source === "string" && source.trim()) {
          resources.push({ kind: "package", path: source.trim() });
        }
      }
    }
    if (Array.isArray(value.extensions)) {
      for (const entry of value.extensions) {
        if (typeof entry === "string" && entry.trim()) {
          resources.push({ kind: "extension", path: `.pi/settings.json → ${entry.trim()}` });
        }
      }
    }
    return resources.length ? resources : [fallback];
  } catch {
    return [fallback];
  }
}

function projectResources(workspace: string, trustedExtensionPaths: ReadonlySet<string>): WorkspaceTrustResource[] {
  const regularExtensionsDir = join(workspace, ".pi", "extensions");
  const discoveredRegularExtensions = discoverExtensionEntryPaths(regularExtensionsDir);
  const regularExtensions = discoveredRegularExtensions
    .filter((path) => !trustedExtensionPaths.has(canonicalExtensionPath(path)));
  const resources: WorkspaceTrustResource[] = [
    ...regularExtensions,
    ...resolveWorkspacePiWebExtensionPaths(workspace),
  ].map((path) => ({ kind: "extension" as const, path: relative(workspace, path) || path }));
  if (existsSync(regularExtensionsDir) && discoveredRegularExtensions.length === 0) {
    resources.push({ kind: "resource", path: ".pi/extensions" });
  }
  resources.push(...projectSettingsResources(workspace));

  for (const name of ["skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
    const path = join(workspace, ".pi", name);
    if (existsSync(path)) resources.push({ kind: "resource", path: relative(workspace, path) });
  }
  let ancestor = workspace;
  while (true) {
    const skills = join(ancestor, ".agents", "skills");
    if (existsSync(skills)) {
      resources.push({ kind: "resource", path: relative(workspace, skills) || skills });
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return resources;
}

function readTrustedWorkspacePaths(agentDir: string): string[] {
  const path = join(agentDir, "trust.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`);
  }
  const entries = Object.entries(parsed);
  for (const [workspace, decision] of entries) {
    if (decision !== true && decision !== false && decision !== null) {
      throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(workspace)} must be true, false, or null`);
    }
  }
  return entries
    .filter((entry): entry is [string, true] => isAbsolute(entry[0]) && entry[1] === true)
    .map(([workspace]) => workspace)
    .sort();
}

export class WorkspaceExtensionTrust {
  private readonly store: ProjectTrustStore;
  private readonly trustedExtensionPaths: ReadonlySet<string>;

  constructor(private readonly agentDir: string, trustedExtensionPaths: string[] = []) {
    this.store = new ProjectTrustStore(agentDir);
    this.trustedExtensionPaths = new Set(trustedExtensionPaths.map(canonicalExtensionPath));
  }

  requiresTrust(cwd: string): boolean {
    const workspace = realWorkspacePath(cwd);
    return hasTrustRequiringProjectResources(workspace)
      || resolveWorkspacePiWebExtensionPaths(workspace).length > 0;
  }

  isTrusted(cwd: string): boolean {
    const workspace = realWorkspacePath(cwd);
    return !this.requiresTrust(workspace) || this.store.get(workspace) === true;
  }

  trustedWorkspaces(): string[] {
    return readTrustedWorkspacePaths(this.agentDir);
  }

  extensionPaths(cwd: string): string[] {
    const workspace = realWorkspacePath(cwd);
    return this.isTrusted(workspace) ? resolveWorkspacePiWebExtensionPaths(workspace) : [];
  }

  status(cwd: string): WorkspaceExtensionTrustStatus {
    const workspace = realWorkspacePath(cwd);
    const trusted = this.isTrusted(workspace);
    const trustedWorkspaces = this.trustedWorkspaces();
    if (trusted && this.requiresTrust(workspace) && !trustedWorkspaces.includes(workspace)) {
      trustedWorkspaces.push(workspace);
      trustedWorkspaces.sort();
    }
    return {
      workspace,
      trusted,
      resources: projectResources(workspace, this.trustedExtensionPaths),
      trustedWorkspaces,
    };
  }

  trust(cwd: string): WorkspaceExtensionTrustStatus {
    const workspace = realWorkspacePath(cwd);
    this.store.set(workspace, true);
    return this.status(workspace);
  }

  revoke(workspace: string): void {
    // An explicit false entry must override a trusted ancestor from the native store.
    this.store.set(workspace, false);
  }
}
