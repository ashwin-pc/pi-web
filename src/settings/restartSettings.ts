import type { ApiClient } from "../app/api.js";
import { confirmSecurityAction } from "./securityDialog.js";

type SupervisorStatus = {
  ok?: boolean;
  childGeneration?: number;
  childPid?: number;
};

const requestTimeoutMs = 8_000;
const restartTimeoutMs = 30_000;
const pollIntervalMs = 500;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = requestTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal, credentials: "same-origin" });
  } finally {
    window.clearTimeout(timeout);
  }
}

function responseError(status: number, error?: string): string {
  if (status === 401) return "Restart authorization expired. Sign in again and retry.";
  if (status === 403) return "Restart was rejected by the server security policy.";
  return error || `Restart request failed (${status}).`;
}

export function createRestartSettings(options: {
  container: HTMLElement;
  navButton: HTMLButtonElement;
  api: ApiClient;
  setStatus: (message: string, isError?: boolean) => void;
}) {
  const { container, navButton, api, setStatus } = options;
  const buttonElement = container.querySelector<HTMLButtonElement>("#restartServerButton");
  const stateElement = container.querySelector<HTMLElement>("#restartServerState");
  if (!buttonElement || !stateElement) throw new Error("Missing restart settings controls");
  const button = buttonElement;
  const state = stateElement;
  let generation: number | undefined;
  let confirming = false;
  let restarting = false;

  function show(visible: boolean) {
    navButton.hidden = !visible;
    container.hidden = !visible;
  }

  async function readStatus(): Promise<SupervisorStatus> {
    const response = await fetchWithTimeout("/__supervisor/status", { headers: api.headers() });
    const data = await response.json().catch(() => ({})) as SupervisorStatus & { error?: string };
    if (!response.ok || !data.ok || typeof data.childGeneration !== "number") {
      throw new Error(responseError(response.status, data.error));
    }
    return data;
  }

  async function refreshCapability() {
    if (restarting) return;
    try {
      const status = await readStatus();
      generation = status.childGeneration;
      show(true);
      state.textContent = "Supervised restart is available.";
    } catch {
      show(false);
    }
  }

  async function appIsReady(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout("/api/system-info", { headers: api.headers() });
      if (!response.ok) return false;
      const data = await response.json().catch(() => ({})) as { ok?: boolean; system?: unknown };
      return data.ok !== false && Boolean(data.system);
    } catch {
      return false;
    }
  }

  async function waitForReplacement(previousGeneration: number) {
    const deadline = Date.now() + restartTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, pollIntervalMs));
      try {
        const candidate = await readStatus();
        if ((candidate.childGeneration ?? 0) <= previousGeneration || !candidate.childPid) continue;
        if (!await appIsReady()) continue;
        const confirmed = await readStatus();
        if (confirmed.childGeneration === candidate.childGeneration && confirmed.childPid) return confirmed;
      } catch {
        // A short unavailable window is expected while the child is replaced.
      }
    }
    throw new Error("Restart was accepted, but the replacement server did not become ready in time. The browser will keep trying to reconnect.");
  }

  async function restart() {
    if (confirming || restarting || generation === undefined) return;
    confirming = true;
    let confirmed: Awaited<ReturnType<typeof confirmSecurityAction>>;
    try {
      confirmed = await confirmSecurityAction({
        container,
        title: "Restart pi-web server?",
        detail: "This affects all sessions and may interrupt work while every browser reconnects.",
        confirmLabel: "Restart server",
      });
    } finally {
      confirming = false;
    }
    if (!confirmed || restarting) return;

    restarting = true;
    button.disabled = true;
    state.textContent = "Sending restart request…";
    setStatus("Sending restart request…");
    try {
      const response = await fetchWithTimeout("/api/restart", { method: "POST", headers: api.headers() });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (response.status !== 202 || !data.ok) throw new Error(responseError(response.status, data.error));
      state.textContent = "Restarting… Waiting for the replacement server.";
      setStatus("Restarting…");
      const replacement = await waitForReplacement(generation);
      generation = replacement.childGeneration;
      state.textContent = "Replacement server is ready. Sessions are reconnecting.";
      setStatus("Replacement server is ready");
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError"
        ? "The connection timed out, so restart acceptance could not be confirmed. Check the connection before retrying."
        : error instanceof TypeError || (error instanceof Error && /failed to fetch/i.test(error.message))
          ? "The connection failed, so restart acceptance could not be confirmed. Check the connection before retrying."
          : error instanceof Error ? error.message : String(error);
      state.textContent = message;
      setStatus(message, true);
    } finally {
      restarting = false;
      button.disabled = false;
    }
  }

  button.addEventListener("click", () => void restart());
  show(false);
  return { refreshCapability };
}
