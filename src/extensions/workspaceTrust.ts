import type { ApiClient } from "../app/api.js";

type WorkspaceTrustStatus = {
  workspace: string;
  trusted: boolean;
  extensions: Array<{ path: string }>;
  trustedWorkspaces: string[];
};

export type WorkspaceTrustController = {
  refresh(sessionId: string): Promise<void>;
};

export function createWorkspaceTrust(options: {
  api: ApiClient;
  getSessionId(): string;
}): WorkspaceTrustController {
  function required<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing workspace extension trust UI: ${selector}`);
    return element;
  }
  const notice = required<HTMLElement>("#workspaceExtensionTrustNotice");
  const list = required<HTMLUListElement>("#workspaceExtensionTrustList");
  const status = required<HTMLElement>("#workspaceExtensionTrustStatus");
  const trustButton = required<HTMLButtonElement>("#workspaceExtensionTrustButton");
  const dismissButton = required<HTMLButtonElement>("#workspaceExtensionDismissButton");
  const settings = required<HTMLElement>("#workspaceExtensionTrustSettings");

  const dismissed = new Set<string>();
  let current: WorkspaceTrustStatus | undefined;
  let refreshId = 0;

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

  function renderSettings(value: WorkspaceTrustStatus) {
    settings.replaceChildren();
    const heading = document.createElement("h4");
    heading.textContent = "Trusted workspaces";
    const hint = document.createElement("p");
    hint.className = "settingsHint";
    hint.textContent = "Project-local pi-web extensions run in the server process. Revocation takes effect the next time each session loads extensions.";
    settings.append(heading, hint);
    const feedback = document.createElement("p");
    feedback.className = "settingsHint workspaceTrustSettingsStatus";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    if (!value.trustedWorkspaces.length) {
      const empty = document.createElement("p");
      empty.className = "settingsHint";
      empty.textContent = "No workspace extensions are trusted.";
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
          body: JSON.stringify({ workspace }),
        }).then((next) => {
          if (current?.workspace === workspace) {
            dismissed.add(workspace);
            current = { ...current, trusted: false, trustedWorkspaces: next.trustedWorkspaces };
          } else if (current) {
            current = { ...current, trustedWorkspaces: next.trustedWorkspaces };
          }
          if (current) render(current);
          const message = "Workspace trust revoked. Existing sessions change on their next extension load.";
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

  function render(value: WorkspaceTrustStatus) {
    current = value;
    list.replaceChildren(...value.extensions.map((extension) => {
      const item = document.createElement("li");
      const path = document.createElement("code");
      path.textContent = extension.path;
      item.append(path);
      return item;
    }));
    status.textContent = "";
    notice.hidden = value.trusted || value.extensions.length === 0 || dismissed.has(value.workspace);
    renderSettings(value);
  }

  dismissButton.addEventListener("click", () => {
    if (current) dismissed.add(current.workspace);
    notice.hidden = true;
  });

  trustButton.addEventListener("click", () => {
    const sessionId = options.getSessionId();
    if (!sessionId) return;
    trustButton.disabled = true;
    trustButton.setAttribute("aria-busy", "true");
    status.textContent = "Loading workspace extensions…";
    void request("/api/extensions/workspace-trust", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }).then((value) => {
      render(value);
      status.textContent = "Workspace trusted. Extensions loaded for this session.";
    }).catch((error) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      trustButton.disabled = false;
      trustButton.removeAttribute("aria-busy");
    });
  });

  document.addEventListener("pi-web-open-settings", () => {
    void refresh(options.getSessionId()).catch(() => undefined);
  });

  async function refresh(sessionId: string) {
    if (!sessionId) return;
    const id = ++refreshId;
    const params = new URLSearchParams({ sessionId });
    const value = await request(`/api/extensions/workspace-trust?${params}`);
    if (id === refreshId) render(value);
  }

  return { refresh };
}
