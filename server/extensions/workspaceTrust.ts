import { realpathSync } from "node:fs";
import { relative } from "node:path";
import type { createSettingsStore } from "../settings.js";
import { resolveWorkspacePiWebExtensionPaths } from "../extensions.js";

type SettingsStore = ReturnType<typeof createSettingsStore>;

export type WorkspaceExtensionTrustStatus = {
  workspace: string;
  trusted: boolean;
  extensions: Array<{ path: string }>;
  trustedWorkspaces: string[];
};

export function realWorkspacePath(cwd: string): string {
  return realpathSync.native(cwd);
}

export class WorkspaceExtensionTrust {
  private trusted = new Set<string>();

  constructor(private readonly settingsStore: SettingsStore) {}

  async initialize(): Promise<void> {
    const settings = await this.settingsStore.read();
    this.trusted = new Set(settings.trustedExtensionWorkspaces ?? []);
  }

  isTrusted(cwd: string): boolean {
    return this.trusted.has(realWorkspacePath(cwd));
  }

  trustedWorkspaces(): string[] {
    return [...this.trusted].sort();
  }

  extensionPaths(cwd: string): string[] {
    if (!this.isTrusted(cwd)) return [];
    return resolveWorkspacePiWebExtensionPaths(realWorkspacePath(cwd));
  }

  status(cwd: string): WorkspaceExtensionTrustStatus {
    const workspace = realWorkspacePath(cwd);
    return {
      workspace,
      trusted: this.trusted.has(workspace),
      extensions: resolveWorkspacePiWebExtensionPaths(workspace)
        .map((path) => ({ path: relative(workspace, path) || path })),
      trustedWorkspaces: this.trustedWorkspaces(),
    };
  }

  async trust(cwd: string): Promise<WorkspaceExtensionTrustStatus> {
    const workspace = realWorkspacePath(cwd);
    await this.settingsStore.setWorkspaceExtensionTrust(workspace, true);
    this.trusted.add(workspace);
    return this.status(workspace);
  }

  async revoke(workspace: string): Promise<void> {
    if (!this.trusted.has(workspace)) return;
    await this.settingsStore.setWorkspaceExtensionTrust(workspace, false);
    this.trusted.delete(workspace);
  }
}
