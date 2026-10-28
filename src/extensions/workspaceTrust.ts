import type { ApiClient } from "../app/api.js";

type WorkspaceTrustStatus = {
  workspace: string;
  trusted: boolean;
  desiredTrusted?: boolean;
  appliedTrusted?: boolean | null;
  pendingReload?: boolean;
  busy?: boolean;
  resources: Array<{ kind: "extension" | "package" | "resource"; path: string }>;
  trustedWorkspaces: string[];
};

type RenderedWorkspaceTrustStatus = WorkspaceTrustStatus & {
  desiredTrusted: boolean;
  appliedTrusted: boolean | null;
  pendingReload: boolean;
  busy: boolean;
};

export type WorkspaceTrustController = {
  activate(sessionId: string): void;
  settle(sessionId: string): void;
  refresh(sessionId: string): Promise<void>;
};

export function createWorkspaceTrust(options: {
  api: ApiClient;
}): WorkspaceTrustController {
  function required<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing workspace extension trust UI: ${selector}`);
    return element;
  }
  const notice = required<HTMLElement>("#workspaceExtensionTrustNotice");
  const title = required<HTMLElement>("#workspaceExtensionTrustTitle");
  const explanation = required<HTMLElement>("#workspaceExtensionTrustExplanation");
  const workspacePath = required<HTMLElement>("#workspaceExtensionTrustWorkspace");
  const list = required<HTMLUListElement>("#workspaceExtensionTrustList");
  const status = required<HTMLElement>("#workspaceExtensionTrustStatus");
  const trustButton = required<HTMLButtonElement>("#workspaceExtensionTrustButton");
  const dismissButton = required<HTMLButtonElement>("#workspaceExtensionDismissButton");
  const settings = required<HTMLElement>("#workspaceExtensionTrustSettings");

  const dismissed = new Set<string>();
  let activeSessionId = "";
  let current: (RenderedWorkspaceTrustStatus & { sessionId: string }) | undefined;
  let generation = 0;
  let refreshId = 0;
  let needsRefresh = false;

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { ...options.api.headers(), ...(init.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data as WorkspaceTrustStatus & { ok: true };
  }

  function normalize(value: WorkspaceTrustStatus): RenderedWorkspaceTrustStatus {
    return {
      ...value,
      desiredTrusted: value.desiredTrusted ?? value.trusted,
      appliedTrusted: typeof value.appliedTrusted === "boolean" ? value.appliedTrusted : null,
      pendingReload: value.pendingReload === true,
      busy: value.busy === true,
    };
  }

  function renderSettings(value: WorkspaceTrustStatus) {
    settings.replaceChildren();
    const heading = document.createElement("h4");
    heading.textContent = "Trusted workspaces";
    const hint = document.createElement("p");
    hint.className = "settingsHint";
    hint.textContent = "Workspace settings and resources can execute extensions or install packages. Revocation takes effect on the next extension load.";
    settings.append(heading, hint);
    const feedback = document.createElement("p");
    feedback.className = "settingsHint workspaceTrustSettingsStatus";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    if (!value.trustedWorkspaces.length) {
      const empty = document.createElement("p");
      empty.className = "settingsHint";
      empty.textContent = "No workspaces are trusted.";
      settings.append(empty, feedback);
      return;
    }
    for (const workspace of value.trustedWorkspaces) {
      const row = document.createElement("div");
      row.className = "workspaceTrustSettingsRow";
      const path = document.createElement("code");
      path.textContent = workspace;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.setAttribute("aria-label", `Revoke workspace extension trust for ${workspace}`);
      revoke.addEventListener("click", () => {
        revoke.disabled = true;
        revoke.setAttribute("aria-busy", "true");
        void request("/api/extensions/workspace-trust", {
          method: "DELETE",
          body: JSON.stringify({ workspace, sessionId: activeSessionId }),
        }).then(async (next) => {
          if (current?.workspace !== workspace && current) {
            current = { ...current, trustedWorkspaces: next.trustedWorkspaces };
            render(current);
          }
          await refresh(activeSessionId).catch(() => undefined);
          const message = "Workspace trust revoked. Loaded sessions must be reloaded to unload its resources.";
          status.textContent = message;
          settings.querySelector<HTMLElement>(".workspaceTrustSettingsStatus")!.textContent = message;
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          status.textContent = message;
          feedback.textContent = message;
        }).finally(() => {
          revoke.disabled = false;
          revoke.removeAttribute("aria-busy");
        });
      });
      row.append(path, revoke);
      settings.append(row);
    }
    settings.append(feedback);
  }

  function render(input: WorkspaceTrustStatus, sessionId = current?.sessionId || activeSessionId) {
    const value = normalize(input);
    current = { ...value, sessionId };
    workspacePath.textContent = value.workspace;
    list.replaceChildren(...value.resources.map((resource) => {
      const item = document.createElement("li");
      const path = document.createElement("code");
      path.textContent = `${resource.kind === "package" ? "Project package" : resource.kind === "extension" ? "Extension" : "Project resource"}: ${resource.path}`;
      item.append(path);
      return item;
    }));
    const pendingGrant = value.pendingReload && value.desiredTrusted;
    const pendingRevoke = value.pendingReload && !value.desiredTrusted;
    title.textContent = pendingGrant
      ? "Workspace resources are ready to load"
      : pendingRevoke
        ? "Workspace resources must be unloaded"
        : "Trust this workspace’s resources?";
    explanation.textContent = pendingGrant
      ? "Workspace resources were trusted. Reload this session to load them."
      : pendingRevoke
        ? "Workspace trust was revoked. Reload this session to unload them."
        : "Workspace settings and resources can execute extensions, install packages, and affect agent behavior. Review them before loading.";
    trustButton.textContent = value.pendingReload ? "Reload" : "Trust and load";
    dismissButton.hidden = value.pendingReload;
    trustButton.disabled = value.busy;
    status.textContent = value.pendingReload && value.busy
      ? "Wait for the current response or compaction to finish before reloading."
      : "";
    notice.hidden = !value.pendingReload
      && (value.resources.length === 0 || value.desiredTrusted || dismissed.has(value.workspace));
    renderSettings(value);
  }

  dismissButton.addEventListener("click", () => {
    if (current) dismissed.add(current.workspace);
    notice.hidden = true;
  });

  trustButton.addEventListener("click", () => {
    const consent = current;
    const requestGeneration = generation;
    if (!consent || consent.sessionId !== activeSessionId || trustButton.disabled) return;
    trustButton.disabled = true;
    trustButton.setAttribute("aria-busy", "true");
    status.textContent = consent.pendingReload ? "Reloading workspace resources…" : "Loading workspace resources…";
    const operation = consent.pendingReload
      ? request("/api/extensions/reload", {
        method: "POST",
        body: JSON.stringify({ sessionId: consent.sessionId }),
      }).then(() => refresh(consent.sessionId))
      : request("/api/extensions/workspace-trust", {
        method: "POST",
        body: JSON.stringify({ sessionId: consent.sessionId, workspace: consent.workspace }),
      }).then((value) => {
        if (requestGeneration !== generation || consent.sessionId !== activeSessionId) return;
        refreshId += 1;
        render(value, consent.sessionId);
      });
    void operation.then(() => {
      if (requestGeneration !== generation || consent.sessionId !== activeSessionId) return;
      if (current?.pendingReload) {
        status.textContent = "Resources could not be fully applied. Reload remains required.";
      } else {
        status.textContent = consent.pendingReload
          ? "Workspace resources reloaded for this session."
          : "Workspace trusted. Resources loaded for this session.";
      }
    }).catch(async (error) => {
      if (requestGeneration !== generation || consent.sessionId !== activeSessionId) return;
      await refresh(consent.sessionId).catch(() => undefined);
      status.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (requestGeneration !== generation || consent.sessionId !== activeSessionId) return;
      trustButton.disabled = current?.busy ?? false;
      trustButton.removeAttribute("aria-busy");
    });
  });

  document.addEventListener("pi-web-open-settings", () => {
    void refresh(activeSessionId).catch(() => undefined);
  });
  document.addEventListener("pi-web-workspace-trust-changed", () => {
    void refresh(activeSessionId).catch(() => undefined);
  });
  document.addEventListener("pi-web-extensions-reloaded", () => {
    void refresh(activeSessionId).catch(() => undefined);
  });

  function activate(sessionId: string) {
    if (sessionId === activeSessionId) return;
    activeSessionId = sessionId;
    generation += 1;
    refreshId += 1;
    needsRefresh = Boolean(sessionId);
    current = undefined;
    notice.hidden = true;
    trustButton.disabled = true;
    trustButton.removeAttribute("aria-busy");
    status.textContent = "";
  }

  function settle(sessionId: string) {
    if (!sessionId || sessionId !== activeSessionId) return;
    if (!needsRefresh && !current?.pendingReload && !current?.busy) return;
    void refresh(sessionId).catch(() => undefined);
  }

  async function refresh(sessionId: string) {
    if (!sessionId || sessionId !== activeSessionId) return;
    const requestGeneration = generation;
    const requestId = ++refreshId;
    needsRefresh = false;
    const params = new URLSearchParams({ sessionId });
    const value = await request(`/api/extensions/workspace-trust?${params}`);
    if (requestGeneration === generation && requestId === refreshId && sessionId === activeSessionId) {
      render(value, sessionId);
    }
  }

  return { activate, settle, refresh };
}
