import type { RightPanelManager } from "../layout/rightPanel.js";
import type { WorkspaceDescriptor } from "./client.js";

/** A generated document has scripts but no host origin, credentials or tool bridge. */
export function initGeneratedApp(options: {
  panels: RightPanelManager; headers: () => HeadersInit; workspace: () => Promise<WorkspaceDescriptor>;
}) {
  const panel = document.createElement("section"); panel.hidden = true; panel.className = "generatedAppPanel";
  panel.setAttribute("aria-label", "Generated app");
  const header = document.createElement("header"); header.className = "generatedAppHeader";
  const title = document.createElement("strong"); title.textContent = "Generated app";
  const boundary = document.createElement("span"); boundary.textContent = "Sandbox · no workspace access";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close generated app");
  const body = document.createElement("div"); body.className = "generatedAppBody";
  header.append(title, boundary, close); panel.append(header, body); document.body.append(panel);
  let generation = 0;
  async function load() {
    const serial = ++generation;
    body.textContent = "Loading…";
    try {
      const path = new URL(location.href).searchParams.get("appPath") || "";
      if (!/\.html?$/i.test(path)) throw new Error("Choose an HTML file to run as an app");
      const workspace = await options.workspace();
      const query = new URLSearchParams({ workspaceId: workspace.id, path });
      const response = await fetch(`/api/files/read?${query}`, { headers: options.headers() });
      const data = await response.json();
      if (!response.ok || !data.ok || typeof data.content !== "string") throw new Error(data.error || "Could not load generated app");
      if (serial !== generation) return;
      const frame = document.createElement("iframe"); frame.title = `Generated app: ${path}`;
      frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${data.content}`;
      title.textContent = path.split("/").pop() || "Generated app";
      body.replaceChildren(frame);
    } catch (error) { if (serial === generation) body.textContent = error instanceof Error ? error.message : String(error); }
  }
  const handle = options.panels.register({ id: "generated-app", surface: "preview", panel, closeButton: close, width: "760px",
    onOpen: () => { void load(); }, onClose: () => { generation++; body.replaceChildren(); } });
  return {
    async open(path: string) {
      const workspace = await options.workspace();
      handle.open();
      const url = new URL(location.href); url.searchParams.set("surface", "preview"); url.searchParams.set("workspaceId", workspace.id); url.searchParams.set("appPath", path);
      history.replaceState(history.state, "", url);
      void load();
    },
  };
}
