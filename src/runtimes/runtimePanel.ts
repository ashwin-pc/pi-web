import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { setIcon } from "../app/icons.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";
import { connectRuntime as connectRuntimeApi, disconnectRuntime as disconnectRuntimeApi, listRuntimes, type RuntimeConfig, type RuntimeOption } from "./api.js";

export type RuntimePanelController = {
  init: () => void;
  refreshRuntimes: () => Promise<void>;
  isOpen: () => boolean;
};

type RuntimeSummary = RuntimeOption;

type RuntimeExample = {
  title: string;
  description: string;
  config: RuntimeConfig;
};

const runtimeExamples: RuntimeExample[] = [
  {
    title: "Apple container",
    description: "Attach to an already-running Apple container and use /workspace as the runtime folder namespace.",
    config: {
      id: "apple-container:pi-web",
      label: "Apple container: pi-web",
      kind: "container",
      command: "container",
      args: [
        "exec",
        "-i",
        "pi-web-runtime",
        "sh",
        "-lc",
        "cd /tmp/pi-web-runner && PI_RUNNER_CWD=/workspace npm exec --yes tsx server/runner.ts",
      ],
      cwd: "/workspace",
    },
  },
  {
    title: "Docker or Podman exec",
    description: "Attach to an existing container. Replace docker with podman if that is your runtime tool.",
    config: {
      id: "docker:pi-web",
      label: "Docker container: pi-web",
      kind: "container",
      command: "docker",
      args: [
        "exec",
        "-i",
        "pi-web-runtime",
        "sh",
        "-lc",
        "cd /workspace && PI_RUNNER_CWD=/workspace npm exec --yes tsx server/runner.ts",
      ],
      cwd: "/workspace",
    },
  },
  {
    title: "SSH host",
    description: "Run the runner on an existing SSH host. cwd is interpreted on that host.",
    config: {
      id: "ssh:devbox",
      label: "SSH devbox",
      kind: "ssh",
      command: "ssh",
      args: [
        "devbox",
        "cd ~/pi-web-runner && PI_RUNNER_CWD=~/workspace npm exec --yes tsx server/runner.ts",
      ],
      cwd: "~/workspace",
    },
  },
];

function formatConfig(config: RuntimeConfig) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function runtimeTitle(runtime: RuntimeSummary) {
  return runtime.label || runtime.id || "Runtime";
}

function runtimeKind(runtime: RuntimeSummary) {
  if (runtime.id === "local") return "local";
  return runtime.kind || "runtime";
}

function commandLine(runtime: RuntimeSummary) {
  if (!runtime.command) return "";
  const args = Array.isArray(runtime.args) ? runtime.args : [];
  return [runtime.command, ...args].join(" ");
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime config must be a JSON object.");
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const label = typeof item.label === "string" ? item.label.trim() : id;
  const command = typeof item.command === "string" ? item.command.trim() : "";
  const args = Array.isArray(item.args) ? item.args.map(String) : [];
  const cwd = typeof item.cwd === "string" ? item.cwd.trim() : "";
  const processCwd = typeof item.processCwd === "string" && item.processCwd.trim() ? item.processCwd.trim() : undefined;
  const kind = item.kind === "ssh" || item.kind === "local" || item.kind === "container" ? item.kind : undefined;
  if (!id) throw new Error("Runtime id is required.");
  if (!label) throw new Error("Runtime label is required.");
  if (!command) throw new Error("Runtime command is required.");
  if (!cwd) throw new Error("Runtime cwd is required.");
  return { id, label, command, args, cwd, ...(processCwd ? { processCwd } : {}), ...(kind ? { kind } : {}) };
}

export function createRuntimePanel(options: {
  elements: AppElements;
  api: ApiClient;
  rightPanels?: RightPanelManager;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): RuntimePanelController {
  const { elements, api, rightPanels, addMessage } = options;
  let runtimePanelHandle: RightPanelHandle | undefined;
  let hasRenderedExamples = false;

  function setRuntimeStatus(message: string, isError = false) {
    elements.runtimePanelStatusEl.textContent = message;
    elements.runtimePanelStatusEl.classList.toggle("error", isError);
  }

  function defaultConfigText() {
    return formatConfig(runtimeExamples[0].config);
  }

  function renderRuntimeList(runtimes: RuntimeSummary[]) {
    elements.runtimeListEl.replaceChildren();
    if (runtimes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "settingsHint";
      empty.textContent = "No runtimes are registered yet.";
      elements.runtimeListEl.append(empty);
      return;
    }

    for (const runtime of runtimes) {
      const card = document.createElement("article");
      card.className = `runtimeCard runtimeCard--${runtime.id === "local" ? "local" : "remote"}`;

      const header = document.createElement("div");
      header.className = "runtimeCardHeader";
      const titleWrap = document.createElement("div");
      titleWrap.className = "runtimeCardTitleWrap";
      const title = document.createElement("h4");
      title.textContent = runtimeTitle(runtime);
      const id = document.createElement("code");
      id.textContent = runtime.id;
      titleWrap.append(title, id);
      const badge = document.createElement("span");
      badge.className = "runtimeKindBadge";
      badge.textContent = `${runtimeKind(runtime)}${runtime.experimental ? " · experimental" : ""}`;
      header.append(titleWrap, badge);

      const details = document.createElement("dl");
      details.className = "runtimeDetails";
      const rows: Array<[string, string]> = [
        ["Default folder", runtime.cwd || runtime.workspace || "—"],
      ];
      if (runtime.workspace && runtime.workspace !== runtime.cwd) rows.push(["Workspace", runtime.workspace]);
      const line = commandLine(runtime);
      if (line) rows.push(["Command", line]);
      if (runtime.processCwd) rows.push(["Process cwd", runtime.processCwd]);
      if (runtime.network) rows.push(["Network", runtime.network]);
      if (typeof runtime.readOnly === "boolean") rows.push(["Read-only", runtime.readOnly ? "yes" : "no"]);
      for (const [label, value] of rows) {
        const term = document.createElement("dt");
        term.textContent = label;
        const desc = document.createElement("dd");
        desc.textContent = value;
        details.append(term, desc);
      }

      card.append(header, details);
      if (runtime.disconnectable) {
        const actions = document.createElement("div");
        actions.className = "runtimeCardActions";
        const disconnect = document.createElement("button");
        disconnect.type = "button";
        disconnect.textContent = "Disconnect";
        disconnect.addEventListener("click", () => disconnectRuntime(runtime).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setRuntimeStatus(message, true);
          addMessage("system", message, "error");
        }));
        actions.append(disconnect);
        card.append(actions);
      }
      elements.runtimeListEl.append(card);
    }
  }

  async function refreshRuntimes() {
    elements.runtimeRefreshButton.disabled = true;
    try {
      renderRuntimeList(await listRuntimes(api));
    } finally {
      elements.runtimeRefreshButton.disabled = false;
    }
  }

  function renderExamples() {
    if (hasRenderedExamples) return;
    hasRenderedExamples = true;
    elements.runtimeExamplesEl.replaceChildren();
    for (const example of runtimeExamples) {
      const card = document.createElement("article");
      card.className = "runtimeExample";
      const title = document.createElement("h4");
      title.textContent = example.title;
      const description = document.createElement("p");
      description.textContent = example.description;
      const code = document.createElement("pre");
      code.textContent = formatConfig(example.config).trimEnd();
      const actions = document.createElement("div");
      actions.className = "runtimeExampleActions";
      const use = document.createElement("button");
      use.type = "button";
      use.className = "runtimeExampleUse";
      use.textContent = "Use example";
      use.addEventListener("click", () => {
        elements.runtimeConnectJson.value = formatConfig(example.config);
        elements.runtimeConnectJson.focus();
        setRuntimeStatus(`Loaded ${example.title} example`);
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "runtimeExampleCopy";
      copy.textContent = "Copy JSON";
      copy.addEventListener("click", () => {
        copyText(formatConfig(example.config)).then(() => setRuntimeStatus(`Copied ${example.title} example`)).catch((error) => setRuntimeStatus(error instanceof Error ? error.message : String(error), true));
      });
      actions.append(use, copy);
      card.append(title, description, code, actions);
      elements.runtimeExamplesEl.append(card);
    }
  }

  async function connectRuntime() {
    let config: RuntimeConfig;
    try {
      config = normalizeRuntimeConfig(JSON.parse(elements.runtimeConnectJson.value));
    } catch (error) {
      setRuntimeStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }

    elements.runtimeConnectButton.disabled = true;
    setRuntimeStatus("Checking runtime…");
    try {
      const runtime = await connectRuntimeApi(api, config);
      setRuntimeStatus(`Connected ${runtime?.label || runtime?.id || config.label}`);
      await refreshRuntimes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeStatus(message, true);
      addMessage("system", message, "error");
    } finally {
      elements.runtimeConnectButton.disabled = false;
    }
  }

  async function disconnectRuntime(runtime: RuntimeSummary) {
    if (!window.confirm(`Disconnect runtime ${runtimeTitle(runtime)}? Existing runtime-bound sessions will remain listed but unavailable until the runtime is reconnected.`)) return;
    setRuntimeStatus(`Disconnecting ${runtimeTitle(runtime)}…`);
    await disconnectRuntimeApi(api, runtime.id);
    setRuntimeStatus(`Disconnected ${runtimeTitle(runtime)}`);
    await refreshRuntimes();
  }

  function prepareOpenRuntimes() {
    renderExamples();
    if (!elements.runtimeConnectJson.value.trim()) elements.runtimeConnectJson.value = defaultConfigText();
    setRuntimeStatus("");
    refreshRuntimes().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeStatus(message, true);
      addMessage("system", message, "error");
    });
  }

  function afterOpenRuntimes() {
    elements.runtimeCloseButton.focus();
  }

  function openRuntimes() {
    if (runtimePanelHandle) {
      runtimePanelHandle.open();
      return;
    }
    prepareOpenRuntimes();
    elements.runtimeBackdrop.hidden = false;
    elements.runtimePanel.hidden = false;
    afterOpenRuntimes();
  }

  function closeRuntimes() {
    if (runtimePanelHandle) {
      runtimePanelHandle.close();
      return;
    }
    elements.runtimePanel.hidden = true;
    elements.runtimeBackdrop.hidden = true;
    elements.runtimeButton.focus();
  }

  function init() {
    setIcon(elements.runtimeButton, "server");
    elements.runtimeRefreshButton.addEventListener("click", () => refreshRuntimes().catch((error) => setRuntimeStatus(error instanceof Error ? error.message : String(error), true)));
    elements.runtimeConnectButton.addEventListener("click", connectRuntime);

    runtimePanelHandle = rightPanels?.register({
      id: "runtimes",
      side: "right",
      panel: elements.runtimePanel,
      trigger: elements.runtimeButton,
      backdrop: elements.runtimeBackdrop,
      closeButton: elements.runtimeCloseButton,
      width: "460px",
      minWidth: 340,
      maxWidth: 760,
      onBeforeOpen: prepareOpenRuntimes,
      onOpen: afterOpenRuntimes,
      focusOnClose: elements.runtimeButton,
    });

    if (!runtimePanelHandle) {
      elements.runtimeButton.addEventListener("click", openRuntimes);
      elements.runtimeCloseButton.addEventListener("click", closeRuntimes);
      elements.runtimeBackdrop.addEventListener("click", closeRuntimes);
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.runtimePanel.hidden) closeRuntimes();
      });
    }
  }

  return {
    init,
    refreshRuntimes,
    isOpen: () => runtimePanelHandle?.isOpen() ?? !elements.runtimePanel.hidden,
  };
}
