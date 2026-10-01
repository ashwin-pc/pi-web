import { parseWorkItem, workItemKey, type WorkItem, type WorkRecord, type WorkViewContext, type WorkViewCommand, type WorkDraftCommand } from "../../shared/work.js";
import { resourceFromUrl, type ResourceRef } from "../../shared/resourceRef.js";
import type { AppPanelManager } from "../layout/rightPanel.js";
import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import { sessionRuntime } from "../app/sessionState.js";
import type { SessionsController } from "../sessions/sessionDrawer.js";
import type { FilesPanelController } from "../files/panel.js";
import type { WebPanelsController } from "../extensions/webPanels.js";
import { iconElement } from "../app/icons.js";
import { openFolderPicker } from "../files/folderPicker.js";
import { createForeignViews } from "./foreignViews.js";
import type { WorkspaceDescriptor } from "./client.js";
import "./workShell.css";

export function workspaceMode() {
  const choice = new URL(location.href).searchParams.get("shell");
  if (choice) return choice !== "chat";
  try { return localStorage.getItem("pi-web.shell") !== "chat"; } catch { return true; }
}
type Scene = { items: WorkItem[]; active?: string; companion?: string; pinned: string[]; revision: number; runWorkspaceId?: string; titles: Record<string, string> };
type Pending = { type: "view"; command: WorkViewCommand } | { type: "draft"; command: WorkDraftCommand };
type Options = { api: ApiClient; elements: AppElements; state: AppState; sessions: SessionsController; panels: AppPanelManager; files: FilesPanelController;
  webPanels: WebPanelsController; openResource: (ref: ResourceRef) => Promise<void>; openPreview: (path: string, workspaceId?: string) => Promise<void>; onError: (error: unknown) => void };
function button(text: string, action: () => void, icon?: Parameters<typeof iconElement>[0]) {
  const node = document.createElement("button"); node.type = "button"; node.className = "workButton"; if (icon) node.append(iconElement(icon)); node.append(text); node.onclick = action; return node;
}
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) || "null") || fallback; } catch { return fallback; } }
export function createWorkShell(options: Options) {
  const { api, elements, state, sessions, panels, files, webPanels } = options;
  let records: WorkRecord[] = [], roots: WorkspaceDescriptor[] = [], currentId = "", switching = false, applying = 0, composing = false, viewEpoch = 0;
  let chatOpen = false, drawerOpen = matchMedia("(min-width:1025px)").matches, ready = false, initializing = false;
  const windowId = api.clientId, scenes = new Map<string, Scene>(), pending = new Map<string, Pending>(), receipts = new Set(stored<string[]>("pi-web.work.receipts", []));
  let previousView: { workId: string; scene: Scene } | undefined;
  let lastError = "";
  const completed = new Set<string>();
  const current = () => records.find(work => work.id === currentId);
  const root = (id: string) => roots.find(root => root.id === id);
  const scene = (): Scene => {
    let value = scenes.get(currentId); if (!value) {
      const saved = stored<Scene>("pi-web.work.scene/" + currentId, { items: current()?.references || [], pinned: [], revision: 0, titles: {} });
      value = { ...saved, items: saved.items.map(parseWorkItem).filter((item): item is WorkItem => Boolean(item)), pinned: saved.pinned || [], titles: saved.titles || {}, revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0 }; scenes.set(currentId, value);
    }
    return value;
  };
  function persist(userChange = false) { if (!currentId) return; if (userChange && !applying) scene().revision++; try { sessionStorage.setItem("pi-web.work.scene/" + currentId, JSON.stringify(scene())); localStorage.setItem("pi-web.work.last", currentId); } catch { /* Keep the live window usable. */ } }
  async function request(path: string, body?: unknown, method = "POST") {
    const response = await fetch(path, { headers: api.headers(), ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || "Workspace request failed"), { status: response.status }); return data;
  }
  const header = document.createElement("header"); header.className = "workToolbar";
  const title = document.createElement("div"); title.className = "workTitle";
  const heading = document.createElement("strong"), subtitle = document.createElement("small"); title.append(heading, subtitle);
  const toggle = button("Work", () => toggleDrawer(), "panel-left"), open = button("Open", () => void picker().catch(options.onError), "plus"), split = button("Split", () => void toggleSplit().catch(options.onError), "columns-2"), ask = button("Ask Pi", () => void openChat().catch(options.onError), "message-circle"), updates = button("Updates", () => showUpdates(), "bell");
  toggle.id = "workToggle"; toggle.setAttribute("aria-controls", "workDrawer"); ask.id = "workAskPi"; open.id = "workOpen"; split.id = "workSplit"; updates.id = "workUpdates";
  header.append(toggle, title, open, split, ask, updates);
  const drawer = document.createElement("aside"); drawer.id = "workDrawer"; drawer.className = "workDrawer"; drawer.setAttribute("aria-label", "Your work");
  const drawerHeader = document.createElement("header"), drawerLabel = document.createElement("strong"); drawerLabel.textContent = "Work";
  drawerHeader.append(drawerLabel, button("New", () => workDetails(), "plus"));
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "Find work or a project"; search.setAttribute("aria-label", "Find work or a project");
  const rows = document.createElement("div"); rows.className = "workRows";
  const drawerFooter = document.createElement("footer"); drawerFooter.append(button("Preferences", () => elements.settingsButton.click(), "settings"), button("Edit this work", () => workDetails(current()), "pencil")); drawer.append(drawerHeader, search, rows, drawerFooter);
  const shade = document.createElement("div"); shade.className = "workDrawerShade"; shade.onclick = () => toggleDrawer(false);
  const tabs = document.createElement("nav"); tabs.id = "workTabs"; tabs.className = "workTabs"; tabs.setAttribute("aria-label", "Open files, apps and pages");
  const notice = document.createElement("div"); notice.className = "workNotice"; notice.setAttribute("aria-live", "polite");
  const empty = document.createElement("section"); empty.className = "workEmpty"; const emptyTitle = document.createElement("h1"); emptyTitle.textContent = "What are you working on?"; empty.append(emptyTitle, button("Create work", () => workDetails(), "plus"));
  document.body.prepend(header, drawer, shade, notice, empty); document.body.append(tabs);
  document.querySelector(".workspaceNav")?.remove();
  for (const node of document.querySelectorAll<HTMLElement>(".app > .appSidePanel:not(#sessionDrawer), .app > .appPanelBackdrop:not(#sessionBackdrop)")) document.body.append(node);
  const chat = document.querySelector<HTMLElement>("main.app")!; chat.classList.add("workChat"); chat.setAttribute("aria-label", "Pi chat");
  const chatHeader = document.createElement("header"); chatHeader.className = "workChatHeader"; const pi = document.createElement("strong"); pi.textContent = "π Pi";
  chatHeader.append(pi, button("Minimize", () => setChatOpen(false), "minimize-2")); chat.prepend(chatHeader); chat.hidden = true;
  const context = document.createElement("details"); context.className = "workChatContext"; const contextTitle = document.createElement("summary"); contextTitle.textContent = "Projects for Pi"; const contextBody = document.createElement("div"); context.append(contextTitle, contextBody); chatHeader.after(context);
  elements.sessionButton.setAttribute("aria-label", "Conversations"); elements.sessionButton.title = "Conversations";
  const foreign = createForeignViews({ panels, headers: api.headers, workId: () => currentId, onError: options.onError, onBrowser: item => openItem(item), onTitle: (id, item, title) => { if (id !== currentId) return; const key = workItemKey(item); if (scene().titles[key] === title) return; scene().titles[key] = title; persist(); render(); } });
  const companionFile = document.createElement("section"); companionFile.id = "workCompanionFile"; companionFile.hidden = true;
  const companionHeader = document.createElement("header"), companionTitle = document.createElement("strong"), companionBody = document.createElement("div"); companionBody.className = "workCompanionEditor";
  let mountedFile: Extract<ResourceRef, { kind: "file" }> | undefined;
  const companionClose = button("Close", () => undefined, "x");
  companionHeader.append(companionTitle, button("Save", () => { if (mountedFile) void files.saveFile(mountedFile).catch(options.onError); }), button("Ask Pi", () => { if (mountedFile) window.dispatchEvent(new CustomEvent("pi-web-ask-resource", { detail: { resource: mountedFile, selection: files.selection(mountedFile) } })); }), companionClose);
  companionFile.append(companionHeader, companionBody); document.body.append(companionFile);
  panels.register({ id: "workCompanionFile", panel: companionFile, closeButton: companionClose, onClose: () => { if (mountedFile) files.releaseFile(mountedFile); mountedFile = undefined; } });
  function setChatOpen(value: boolean) { chatOpen = value; chat.hidden = !value; document.body.classList.toggle("workChatOpen", value); const url = new URL(location.href); if (value) url.searchParams.set("chat", "1"); else url.searchParams.delete("chat"); history.replaceState(history.state, "", url); if (!value) sessions.setSessionDrawerOpen(false); }
  function toggleDrawer(value = !drawerOpen) { drawerOpen = value; document.body.classList.toggle("workDrawerOpen", value); toggle.setAttribute("aria-expanded", String(value)); shade.hidden = !value; }
  function label(item: WorkItem) {
    return scene().titles[workItemKey(item)] || (item.kind === "file" || item.kind === "preview" ? item.path.split("/").at(-1)! : item.kind === "diff" ? item.path.split("/").at(-1)! + " changes" : item.kind === "files" ? "Files" : item.kind === "git" ? "Git" : item.kind === "app" ? webPanels.entries().find(entry => entry.key === item.key)?.label || item.key : item.kind === "mcp-app" ? item.toolName : "Browser");
  }
  function owner(item: WorkItem) { return "workspaceId" in item ? root(item.workspaceId)?.name || item.workspaceId : item.kind === "browser" ? "Browser" : item.kind === "mcp-app" ? "Connected app" : "Extension app"; }
  function renderDrawer() {
    const query = search.value.toLowerCase(); rows.replaceChildren();
    for (const work of records.filter(work => `${work.title} ${work.workspaceIds.map(id => root(id)?.name).join(" ")}`.toLowerCase().includes(query))) {
      const row = button("", () => void selectWork(work.id).catch(options.onError)); row.className = "workRow"; row.dataset.work = work.id; row.setAttribute("aria-current", String(work.id === currentId));
      const name = document.createElement("strong"), projects = document.createElement("small"), status = document.createElement("span"); name.textContent = work.title; projects.textContent = work.workspaceIds.map(id => root(id)?.name || "Unavailable project").join(" + "); status.className = "workRowStatus"; row.append(name, projects, status); rows.append(row);
    }
    updateStatuses();
  }
  function updateStatuses() {
    for (const work of records) { const node = rows.querySelector<HTMLElement>(`[data-work="${CSS.escape(work.id)}"] .workRowStatus`); if (node) node.textContent = work.sessionIds.some(id => sessionRuntime(state, id).isRunning) ? "Pi is working" : [...pending.values()].some(entry => entry.command.context.workId === work.id) ? "Changes ready" : work.sessionIds.some(id => completed.has(id) || state.sessionUnreadStates.some(unread => unread.sessionId === id)) ? "Pi replied" : "Ready to continue"; }
    const count = pending.size + completed.size; updates.textContent = count ? `${count} ready` : "Updates";
  }
  function render() {
    const work = current(); heading.textContent = work?.title || "pi web"; subtitle.textContent = work?.workspaceIds.map(id => root(id)?.name || "Unavailable project").join(" + ") || "Files, apps and projects";
    empty.hidden = Boolean(work && scene().active); open.disabled = split.disabled = ask.disabled = !work; split.textContent = work && scene().companion ? "Single view" : "Split";
    tabs.replaceChildren();
    if (work) for (const item of scene().items) {
      const key = workItemKey(item), tab = document.createElement("div"); tab.className = "workTab"; tab.dataset.tab = key; tab.classList.toggle("active", scene().active === key); tab.classList.toggle("companion", scene().companion === key);
      const choose = button("", () => void openItem(item).catch(options.onError)), name = document.createElement("strong"), project = document.createElement("small"); name.textContent = label(item); project.textContent = owner(item); choose.append(name, project); choose.title = "path" in item ? `${owner(item)} / ${item.path}` : label(item);
      const pin = button("", () => togglePin(key), "pin"); pin.classList.toggle("pinned", scene().pinned.includes(key)); pin.setAttribute("aria-label", `${scene().pinned.includes(key) ? "Unpin" : "Pin"} ${label(item)}`);
      const close = button("", () => void closeItem(key).catch(options.onError), "x"); close.setAttribute("aria-label", "Close " + label(item)); tab.append(choose, pin, close); tabs.append(tab);
    }
    if (work) tabs.append(button("Open", () => void picker(), "plus"));
    notice.replaceChildren();
    const awaiting = [...pending.values()].filter(entry => entry.command.context.workId === currentId);
    if (lastError) notice.append(document.createTextNode(lastError), button("Dismiss", () => { lastError = ""; render(); }));
    else if (awaiting.length) notice.append(document.createTextNode("Pi has changes ready for this work."), button("Show", () => showUpdates()));
    else if (previousView?.workId === currentId) notice.append(document.createTextNode("Pi changed the arrangement."), button("Restore my previous view", () => void restoreView().catch(options.onError)));
    renderDrawer(); renderContext();
  }
  function renderContext() {
    contextBody.replaceChildren(); const work = current(); if (!work) return;
    const run = document.createElement("select"); run.setAttribute("aria-label", "Run Pi in project");
    for (const id of work.workspaceIds) { const option = document.createElement("option"); option.value = id; option.textContent = root(id)?.name || id; run.append(option); }
    run.value = scene().runWorkspaceId || work.workspaceIds[0]; run.onchange = () => { scene().runWorkspaceId = run.value; persist(true); void ensureSession().catch(options.onError); };
    const runLabel = document.createElement("label"); runLabel.textContent = "Run in"; runLabel.append(run); contextBody.append(runLabel);
    const selected = stored<string[]>("pi-web.work.read/" + work.id, work.workspaceIds);
    const guardReads = () => { const checked = contextBody.querySelectorAll('input:checked').length; for (const node of contextBody.querySelectorAll<HTMLInputElement>('input')) node.disabled = checked === 1 && node.checked; };
    for (const id of work.workspaceIds) { const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.value = id; check.checked = selected.includes(id) || !selected.some(id => work.workspaceIds.includes(id)) && id === work.workspaceIds[0]; check.name = "workReadRoot"; check.onchange = () => { const roots = [...contextBody.querySelectorAll<HTMLInputElement>('input:checked')].map(node => node.value); guardReads(); try { sessionStorage.setItem("pi-web.work.read/" + work.id, JSON.stringify(roots)); } catch { /* Keep the checked UI usable. */ } }; label.append(check, root(id)?.name || id); contextBody.append(label); }
    guardReads();
  }
  search.oninput = renderDrawer;
  async function refresh() { const data = await request("/api/work"); records = data.work; roots = data.workspaces; }
  let catalogueQueue: Promise<unknown> = Promise.resolve();
  function mutate(workId: string, change: (record: WorkRecord) => Partial<WorkRecord>) {
    const task = catalogueQueue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const record = records.find(work => work.id === workId); if (!record) throw new Error("This work is unavailable");
        try { const data = await request("/api/work/" + workId, { ...change(record), expectedRevision: record.revision }, "PATCH"); records = records.map(work => work.id === workId ? data.work : work); return; }
        catch (e) { if (attempt || (e as { status?: number }).status !== 409) throw e; await refresh(); }
      }
    }); catalogueQueue = task.catch(() => undefined); return task;
  }
  function associate(item: WorkItem, id = currentId) {
    if (item.kind === "browser") return;
    if (records.find(work => work.id === id)?.references.some(ref => workItemKey(ref) === workItemKey(item))) return;
    void mutate(id, work => ({ references: [...work.references, item] })).catch(options.onError);
  }
  async function ensureSession() {
    const record = current(); if (!record) throw new Error("Choose work first");
    const targetRoot = root(scene().runWorkspaceId || record.workspaceIds[0]); if (!targetRoot) throw new Error("The selected project is unavailable");
    if (record.sessionIds.includes(state.currentSessionId) && state.currentCwd === targetRoot.root) return;
    switching = true;
    try {
      const data = await request("/api/sessions");
      const existing = data.sessions.find((session: { id: string; cwd: string }) => record.sessionIds.includes(session.id) && session.cwd === targetRoot.root);
      if (existing) await sessions.openSessionById(existing.id); else { await sessions.startNewSession(targetRoot.root); const sessionId = state.currentSessionId; await mutate(record.id, work => ({ sessionIds: [...new Set([...work.sessionIds, sessionId])] })); }
    } finally { switching = false; }
  }
  async function openChat() { const workId = currentId; await ensureSession(); if (currentId !== workId) return; completed.delete(state.currentSessionId); setChatOpen(true); renderContext(); elements.promptEl.focus(); }
  async function bindSession() {
    if (!ready || switching || !current() || !chatOpen || current()!.sessionIds.includes(state.currentSessionId)) return;
    const workId = currentId, sessionId = state.currentSessionId, cwd = state.currentCwd;
    let workspace = roots.find(root => root.root === cwd);
    if (!workspace) { workspace = (await request("/api/workspaces", { root: cwd })).workspace; if (!roots.some(root => root.id === workspace!.id)) roots.push(workspace!); }
    await mutate(workId, work => ({ sessionIds: [...new Set([...work.sessionIds, sessionId])], workspaceIds: [...new Set([...work.workspaceIds, workspace!.id])] })); render();
  }
  function panelId(item: WorkItem) { return item.kind === "file" || item.kind === "files" ? "files" : item.kind === "git" || item.kind === "diff" ? "git" : item.kind === "preview" ? "generated-app" : item.kind === "app" ? "web-extension" : foreign.panelId(item); }
  async function showItem(item: WorkItem) {
    const url = new URL(location.href); url.searchParams.set("work", currentId); if ("workspaceId" in item) url.searchParams.set("workspaceId", item.workspaceId); history.replaceState(history.state, "", url);
    if (item.kind === "file" || item.kind === "diff") await options.openResource(item);
    else if (item.kind === "files" || item.kind === "git") { panels.navigate(item.kind); files.sessionChanged(); }
    else if (item.kind === "preview") await options.openPreview(item.path, item.workspaceId);
    else if (item.kind === "app") { if (state.currentSessionId !== item.sessionId) { switching = true; try { await sessions.openSessionById(item.sessionId); } finally { switching = false; } } webPanels.open(item.key); }
    else await foreign.open(item, currentId);
  }
  async function openItem(item: WorkItem, alongside = false, user = true) {
    const work = current(); if (!work) return;
    if (user && matchMedia("(max-width:1024px)").matches) setChatOpen(false);
    const epoch = ++viewEpoch;
    if ("workspaceId" in item && !work.workspaceIds.includes(item.workspaceId)) throw new Error("Add this project to the work before opening its files");
    const value = scene(), key = workItemKey(item), old = value.items.find(item => workItemKey(item) === value.active);
    const priorCompanion = value.items.find(other => workItemKey(other) === value.companion);
    if (!value.items.some(item => workItemKey(item) === key)) value.items.push(item);
    if (item.kind === "file") value.items = value.items.filter(other => !(other.kind === "files" && other.workspaceId === item.workspaceId));
    applying++;
    panels.setCompanion();
    try {
      await showItem(item); if (currentId !== work.id || epoch !== viewEpoch) return; value.active = key;
      const second = alongside ? old : priorCompanion && workItemKey(priorCompanion) === key ? old : priorCompanion;
      if (second && workItemKey(second) !== key && second.kind === "file" && item.kind === "file") {
        const primary = alongside ? second : item, beside = alongside ? item : second;
        await showItem(beside); mountedFile = beside; companionTitle.textContent = owner(beside) + " / " + beside.path; files.mountFile(beside, companionBody);
        if (currentId !== work.id || epoch !== viewEpoch) return;
        await showItem(primary); if (currentId !== work.id || epoch !== viewEpoch) return; value.active = workItemKey(primary); value.companion = workItemKey(beside); panels.setCompanion("workCompanionFile");
      } else if (second && workItemKey(second) !== key && panelId(second) !== panelId(item)) {
        const primary = alongside ? second : item, beside = alongside ? item : second;
        await showItem(beside); if (currentId !== work.id || epoch !== viewEpoch) return; await showItem(primary); if (currentId !== work.id || epoch !== viewEpoch) return; value.active = workItemKey(primary); value.companion = workItemKey(beside); panels.setCompanion(panelId(beside));
      } else value.companion = undefined;
      const url = new URL(location.href); url.searchParams.set("work", work.id); url.searchParams.set("tab", value.active!); if (value.companion) url.searchParams.set("beside", value.companion); else url.searchParams.delete("beside"); history.replaceState(history.state, "", url);
      persist(); render();
      associate(item, work.id);
    } finally { applying--; if (user && currentId === work.id && epoch === viewEpoch) persist(true); }
  }
  async function closeItem(key: string, user = true) {
    if (!user && scene().pinned.includes(key)) return;
    const value = scene(); value.items = value.items.filter(item => workItemKey(item) !== key); value.pinned = value.pinned.filter(pin => pin !== key);
    if (value.companion === key) { value.companion = undefined; panels.setCompanion(); }
    if (value.active === key) { const next = value.items.at(-1); if (next) await openItem(next, false, user); else { panels.closePrimary(); value.active = undefined; } }
    persist(user); render();
  }
  function togglePin(key = scene().active) { if (!key) return; scene().pinned = scene().pinned.includes(key) ? scene().pinned.filter(pin => pin !== key) : [...scene().pinned, key]; persist(true); render(); }
  async function toggleSplit() { if (scene().companion) { scene().companion = undefined; panels.setCompanion(); persist(true); render(); } else await picker("files", true); }
  async function selectWork(id: string, push = true) {
    const record = records.find(work => work.id === id); if (!record) throw new Error("This work is unavailable");
    const before = new URL(location.href), showChat = !push && before.searchParams.get("chat") === "1";
    viewEpoch++; persist(push); currentId = id; setChatOpen(false); panels.setCompanion();
    const value = scene(), first: WorkItem = { kind: "files", workspaceId: record.workspaceIds[0] };
    value.items = value.items.filter(item => "workspaceId" in item ? record.workspaceIds.includes(item.workspaceId) : item.kind === "app" ? record.sessionIds.includes(item.sessionId) : true);
    value.pinned = value.pinned.filter(key => value.items.some(item => workItemKey(item) === key));
    if (!push && before.searchParams.get("tab")) value.active = before.searchParams.get("tab")!;
    if (!push) value.companion = before.searchParams.get("beside") || undefined;
    if (!value.items.length) value.items.push(first); const item = value.items.find(item => workItemKey(item) === value.active) || value.items[0];
    const url = new URL(location.href); for (const key of ["path", "repo", "staged", "app", "appPath", "tab", "beside", "chat"]) url.searchParams.delete(key); url.searchParams.set("work", id); url.searchParams.set("workspaceId", "workspaceId" in item ? item.workspaceId : record.workspaceIds[0]);
    if (push) history.pushState(history.state, "", url); else history.replaceState(history.state, "", url);
    await openItem(item, false, false);
    if (showChat) await openChat();
    if (matchMedia("(max-width:1024px)").matches) toggleDrawer(false); render();
  }
  function dialog(title: string) {
    const root = document.createElement("dialog"); root.className = "workDialog"; const header = document.createElement("header"), h = document.createElement("h2"); h.textContent = title; header.append(h, button("Close", () => root.close(), "x")); root.append(header); document.body.append(root); root.onclose = () => root.remove(); root.showModal(); return root;
  }
  function workDetails(record?: WorkRecord) {
    const modal = dialog(record ? "Edit work" : "New work"), form = document.createElement("form"), name = document.createElement("input"); name.required = true; name.maxLength = 160; name.placeholder = "What are you working on?"; name.setAttribute("aria-label", "Work name"); name.value = record?.title || "";
    const projects = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = "Projects"; projects.append(legend);
    function projectRows() { const before = projects.querySelectorAll("label").length ? [...projects.querySelectorAll<HTMLInputElement>('input:checked')].map(node => node.value) : record?.workspaceIds || (roots.length === 1 ? [roots[0].id] : []); projects.querySelectorAll("label").forEach(node => node.remove()); for (const workspace of roots) { const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.name = "project"; check.value = workspace.id; check.checked = before.includes(workspace.id); label.append(check, workspace.name + " · " + workspace.root); projects.append(label); } }
    projectRows();
    const error = document.createElement("p"); error.setAttribute("role", "status");
    const save = document.createElement("button"); save.type = "submit"; save.className = "workButton"; save.textContent = record ? "Save work" : "Create work";
    form.append(name, projects, button("Add project folder", () => {
      modal.onclose = null; modal.style.display = "none"; modal.close();
      openFolderPicker({ onClose: () => { modal.style.display = ""; modal.onclose = () => modal.remove(); modal.showModal(); name.focus(); }, startPath: state.currentCwd || "/", getBookmarks: () => state.favoriteFolders, setBookmarks: () => undefined, api: {
        list: async (path, signal) => { const response = await fetch("/api/fs/dirs?path=" + encodeURIComponent(path), { headers: api.headers(), signal }); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; },
        create: async (parent, name) => (await request("/api/fs/dirs", { parent, name })).path,
        select: async path => { const workspace = (await request("/api/workspaces", { root: path })).workspace; if (!roots.some(root => root.id === workspace.id)) roots.push(workspace); projectRows(); const check = projects.querySelector<HTMLInputElement>(`input[value="${CSS.escape(workspace.id)}"]`); if (check) check.checked = true; },
      } });
    }, "folder-plus"), error, save); modal.append(form); name.focus();
    form.onsubmit = event => { event.preventDefault(); void (async () => {
      try {
        await catalogueQueue;
        const latest = records.find(work => work.id === record?.id) || record;
        const workspaceIds = [...projects.querySelectorAll<HTMLInputElement>('input:checked')].map(node => node.value);
        let sessionIds = latest?.sessionIds || [];
        if (record) { const listed = (await request("/api/sessions")).sessions as Array<{ id: string; cwd: string }>; sessionIds = sessionIds.filter(id => { const session = listed.find(session => session.id === id), workspace = session && roots.find(root => root.root === session.cwd); return !workspace || workspaceIds.includes(workspace.id); }); }
        const references = latest?.references.filter(item => "workspaceId" in item ? workspaceIds.includes(item.workspaceId) : item.kind === "app" ? sessionIds.includes(item.sessionId) : true) || [];
        const data = record ? await request("/api/work/" + record.id, { title: name.value, workspaceIds, sessionIds, references, expectedRevision: latest!.revision }, "PATCH") : await request("/api/work", { title: name.value, workspaceIds, sessionIds: [] }); await refresh(); modal.close(); await selectWork(data.work.id);
      }
      catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
    })(); };
  }
  async function picker(category = "files", alongside = false) {
    const work = current(); if (!work) return;
    const modal = dialog("Open in " + work.title), nav = document.createElement("nav"), body = document.createElement("div"); body.className = "workPickerBody";
    for (const choice of ["files", "apps", "browser"]) nav.append(button(choice[0].toUpperCase() + choice.slice(1), () => { modal.close(); void picker(choice, alongside); })); modal.append(nav, body);
    const choose = (item: WorkItem) => { modal.close(); if (currentId !== work.id) return; void openItem(item, alongside).catch(options.onError); };
    const pathForm = (label: string, action: (text: string, workspaceId: string) => void, isUrl = false) => {
      const form = document.createElement("form"), input = document.createElement("input"), project = document.createElement("select"), submit = document.createElement("button"); input.required = true; input.placeholder = isUrl ? "https://…" : "Workspace-relative path"; input.setAttribute("aria-label", label); submit.textContent = label;
      for (const id of work.workspaceIds) { const option = document.createElement("option"); option.value = id; option.textContent = root(id)?.name || id; project.append(option); }
      if (!isUrl) form.append(project); form.append(input, submit); form.onsubmit = event => { event.preventDefault(); action(input.value, project.value); }; body.append(form);
    };
    if (category === "files") {
      for (const ref of work.references.filter(ref => ["file", "diff"].includes(ref.kind))) body.append(button(label(ref) + " · " + owner(ref), () => choose(ref)));
      for (const id of work.workspaceIds) { body.append(button("Files · " + (root(id)?.name || id), () => choose({ kind: "files", workspaceId: id }), "folder-tree"), button("Git · " + (root(id)?.name || id), () => choose({ kind: "git", workspaceId: id }), "git-branch")); }
      pathForm("Open file", (path, workspaceId) => { const item = parseWorkItem({ kind: "file", workspaceId, path }); if (item) choose(item); });
    } else if (category === "browser") {
      pathForm("Open browser", url => { void foreign.createBrowser(url, work.id).then(choose).catch(e => { const error = document.createElement("p"); error.setAttribute("role", "alert"); error.textContent = e.message; body.append(error); }); }, true);
    } else {
      if (work.sessionIds.includes(state.currentSessionId)) for (const app of webPanels.entries()) body.append(button(app.label, () => choose({ kind: "app", sessionId: state.currentSessionId, key: app.key }), "grid-2x2"));
      pathForm("Run saved HTML", (path, workspaceId) => { const item = parseWorkItem({ kind: "preview", workspaceId, path }); if (item) choose(item); });
      body.append(button("Connect MCP server", () => { const connect = dialog("Connect MCP server"), form = document.createElement("form"), name = document.createElement("input"), url = document.createElement("input"), submit = document.createElement("button"), status = document.createElement("p"); name.placeholder = "Connection name"; name.setAttribute("aria-label", "Connection name"); url.type = "url"; url.required = true; url.placeholder = "MCP endpoint URL"; url.setAttribute("aria-label", "MCP endpoint URL"); submit.textContent = "Connect"; form.append(name, url, status, submit); connect.append(form); form.onsubmit = e => { e.preventDefault(); void request(`/api/work/${work.id}/mcp`, { name: name.value, url: url.value }).then(() => { connect.close(); modal.close(); void picker("apps", alongside); }).catch(e => { status.textContent = e.message; }); }; }, "plug"));
      const connections = (await request(`/api/work/${work.id}/mcp`)).connections;
      if (!modal.isConnected) return;
      for (const connection of connections) {
        if (connection.error) { const error = document.createElement("p"); error.textContent = connection.name + ": " + connection.error; body.append(error); }
        for (const tool of connection.apps) body.append(button(`${tool.title || tool.name} · ${connection.name}`, () => {
          const launch = dialog(tool.title || tool.name), form = document.createElement("form"), args = document.createElement("textarea"), submit = document.createElement("button"), status = document.createElement("p"); args.value = "{}"; args.setAttribute("aria-label", "App tool arguments as JSON"); submit.textContent = "Run and open app"; form.append(args, status, submit); launch.append(form); form.onsubmit = event => { event.preventDefault(); void (async () => { try { await request(`/api/work/${work.id}/mcp/${connection.id}/call`, { name: tool.name, arguments: JSON.parse(args.value) }); launch.close(); choose({ kind: "mcp-app", connectionId: connection.id, toolName: tool.name }); } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); } })(); };
        }, "grid-2x2"));
      }
    }
  }
  function isEditing() { const active = document.activeElement; return composing || Boolean(document.querySelector("dialog[open]")) || Boolean(active?.closest(".cm-editor, #fileEditor, #workCompanionFile")) || Boolean(active?.matches('input, textarea, [contenteditable="true"]') && (active.id !== "prompt" || elements.promptEl.value.trim())); }
  function markReceipt(id: string) { receipts.add(id); pending.delete(id); try { sessionStorage.setItem("pi-web.work.receipts", JSON.stringify([...receipts])); } catch { /* Keep window-local decisions in memory. */ } }
  async function applyView(command: WorkViewCommand) {
    if (!previousView || previousView.workId !== currentId) previousView = { workId: currentId, scene: structuredClone(scene()) }; const active = document.activeElement;
    if (command.action === "open") await openItem(command.item, command.alongside, false);
    else if (command.action === "close") await closeItem(workItemKey(command.item), false);
    else { const key = workItemKey(command.item); if (command.action === "pin" && !scene().pinned.includes(key)) scene().pinned.push(key); if (command.action === "unpin") scene().pinned = scene().pinned.filter(pin => pin !== key); persist(); }
    if (command.action === "open" && matchMedia("(max-width:1024px)").matches) setChatOpen(false);
    markReceipt(command.id); if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true }); render();
  }
  async function receive(entry: Pending) {
    const command = entry.command; if (receipts.has(command.id)) return; pending.set(command.id, entry);
    const foreground = command.context.workId === currentId && command.context.windowId === windowId && command.context.revision === scene().revision && !isEditing() && !document.hidden;
    if (foreground) {
      if (entry.type === "view") await applyView(entry.command);
      else if (files.applyDraft(entry.command.draft, entry.command.mode)) { markReceipt(command.id); render(); }
    }
    render();
  }
  function showUpdates() {
    const modal = dialog("Updates");
    for (const id of completed) { const work = records.find(work => work.sessionIds.includes(id)); if (!work) continue; const section = document.createElement("section"); section.append(document.createTextNode("Pi replied in " + work.title), button("Read reply", () => { modal.close(); void (async () => { if (currentId !== work.id) await selectWork(work.id); switching = true; try { await sessions.openSessionById(id); } finally { switching = false; } completed.delete(id); setChatOpen(true); render(); })().catch(options.onError); })); modal.append(section); }
    if (!pending.size) { const p = document.createElement("p"); p.textContent = "No changes waiting. Pi's conversations remain available from Work."; modal.append(p); }
    for (const entry of pending.values()) {
      const section = document.createElement("section"), title = document.createElement("h3"); title.textContent = records.find(work => work.id === entry.command.context.workId)?.title || "Work"; section.append(title);
      if (entry.type === "view") section.append(document.createTextNode(`${entry.command.action[0].toUpperCase() + entry.command.action.slice(1)} ${label(entry.command.item)} · ${owner(entry.command.item)}`), button("Show in this work", () => { modal.close(); void (async () => { if (currentId !== entry.command.context.workId) await selectWork(entry.command.context.workId); await applyView(entry.command); })().catch(options.onError); }));
      else { const pre = document.createElement("pre"); pre.textContent = entry.command.draft.text; section.append(pre, button(entry.command.mode === "append" ? "Add to my current draft" : "Apply to unchanged draft", () => { void (async () => { if (currentId !== entry.command.context.workId) await selectWork(entry.command.context.workId); await openItem(entry.command.draft.resource); if (files.applyDraft(entry.command.draft, entry.command.mode, entry.command.mode === "append")) { markReceipt(entry.command.id); modal.close(); render(); } else pre.prepend("Your draft changed. Copy the proposed text and merge it into your current draft.\n\n"); })().catch(options.onError); })); }
      section.append(button("Dismiss", () => { markReceipt(entry.command.id); section.remove(); render(); })); modal.append(section);
    }
  }
  async function restoreView() {
    if (previousView?.workId !== currentId) return;
    const restored = previousView.scene, pins = scene().pinned; restored.pinned = pins;
    for (const item of scene().items) if (pins.includes(workItemKey(item)) && !restored.items.some(other => workItemKey(other) === workItemKey(item))) restored.items.push(item);
    restored.revision = scene().revision + 1; scenes.set(currentId, restored); previousView = undefined;
    const active = restored.items.find(item => workItemKey(item) === restored.active), companion = restored.items.find(item => workItemKey(item) === restored.companion);
    if (active) await openItem(active, false, false); if (companion) await openItem(companion, true, false); persist(); render();
  }
  function focus(ref: ResourceRef) {
    if (applying) return;
    if (!ready || !current() || !current()!.workspaceIds.includes(ref.workspaceId)) return;
    const key = workItemKey(ref), value = scene(); if (value.active === key || value.companion === key) return;
    if (!value.items.some(item => workItemKey(item) === key)) value.items.push(ref);
    if (ref.kind === "file") value.items = value.items.filter(other => !(other.kind === "files" && other.workspaceId === ref.workspaceId));
    value.active = key; associate(ref); const url = new URL(location.href); url.searchParams.set("work", currentId); url.searchParams.set("tab", key); history.replaceState(history.state, "", url); persist(!applying); render();
  }
  window.addEventListener("pi-web-open-chat", () => void openChat().catch(options.onError));
  window.addEventListener("pi-web-work-run", ((event: CustomEvent) => { if (event.detail.type === "agent_start") completed.delete(event.detail.sessionId); else if (event.detail.type === "agent_settled" && records.some(work => work.sessionIds.includes(event.detail.sessionId)) && !(chatOpen && state.currentSessionId === event.detail.sessionId)) completed.add(event.detail.sessionId); updateStatuses(); }) as EventListener);
  let viewQueue: Promise<unknown> = Promise.resolve();
  window.addEventListener("pi-web-work-event", ((event: CustomEvent) => { if (event.detail.type === "work_view" || event.detail.type === "work_draft") { const entry = { type: event.detail.type === "work_view" ? "view" : "draft", command: event.detail.command } as Pending; viewQueue = viewQueue.then(() => receive(entry)).catch(options.onError); } }) as EventListener);
  window.addEventListener("pi-web-panel-navigation", ((event: CustomEvent) => {
    if (!ready || !current() || applying) return;
    const detail = event.detail;
    if (detail.action === "close") {
      const companion = scene().items.find(item => workItemKey(item) === scene().companion), primary = scene().items.find(item => workItemKey(item) === scene().active);
      const closed = detail.id === "workCompanionFile" || companion && panelId(companion) === detail.id ? scene().companion : primary && panelId(primary) === detail.id ? scene().active : undefined;
      if (closed) void closeItem(closed).catch(options.onError);
    }
    if (detail.action === "open" && detail.surface && detail.id !== "workCompanionFile") queueMicrotask(() => {
      if (applying || !current()) return; if (matchMedia("(max-width:1024px)").matches) setChatOpen(false); const url = new URL(location.href), resource = resourceFromUrl(url); if (resource) { focus(resource); return; }
      const item = parseWorkItem(detail.surface === "files" || detail.surface === "git" ? { kind: detail.surface, workspaceId: url.searchParams.get("workspaceId") } : detail.surface === "app" ? { kind: "app", sessionId: state.currentSessionId, key: url.searchParams.get("app") } : detail.surface === "preview" ? { kind: "preview", workspaceId: url.searchParams.get("workspaceId"), path: url.searchParams.get("appPath") } : null);
      if (item && !scene().items.some(other => workItemKey(other) === workItemKey(item))) { scene().items.push(item); scene().active = workItemKey(item); associate(item); persist(true); render(); }
    });
  }) as EventListener);
  document.addEventListener("input", event => { if (event.target instanceof Element && event.target.closest(".cm-editor, #fileEditor")) persist(true); }, true);
  document.addEventListener("compositionstart", () => { composing = true; }); document.addEventListener("compositionend", () => { composing = false; });
  document.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); toggleDrawer(true); search.focus(); } if (event.key === "Escape" && !document.querySelector("dialog[open]")) { if (chatOpen) setChatOpen(false); else if (drawerOpen) toggleDrawer(false); } });
  window.addEventListener("popstate", () => { const id = new URL(location.href).searchParams.get("work"); if (id && records.some(work => work.id === id)) void selectWork(id, false).catch(options.onError); });
  window.setInterval(updateStatuses, 1000);
  return {
    error(error: unknown) { lastError = error instanceof Error ? error.message : String(error); render(); },
    toggleDrawer, togglePin, openChat, focus, bindSession,
    context(): WorkViewContext | undefined { const work = current(); if (!work || !work.sessionIds.includes(state.currentSessionId)) return; const readWorkspaceIds = [...contextBody.querySelectorAll<HTMLInputElement>('input:checked')].map(node => node.value); const drafts = scene().items.flatMap(item => item.kind === "file" && readWorkspaceIds.includes(item.workspaceId) ? files.draft(item) || [] : []).filter(draft => draft.text.length <= 7000).slice(0, 8); return { workId: work.id, windowId, revision: scene().revision, readWorkspaceIds, drafts }; },
    async init() {
      if (ready || initializing) return;
      initializing = true;
      try {
        await refresh();
        if (!records.length) { const workspace = roots.find(root => root.root === state.currentCwd) || roots[0]; if (workspace) { const data = await request("/api/work", { title: workspace.name, workspaceIds: [workspace.id], sessionIds: state.currentSessionId ? [state.currentSessionId] : [] }); records.push(data.work); } }
        const params = new URL(location.href).searchParams, wanted = params.get("work"); let remembered = ""; try { remembered = localStorage.getItem("pi-web.work.last") || ""; } catch { /* Ignore unavailable storage. */ }
        const cited = params.get("sessionId");
        let citedWork = cited ? records.find(work => work.sessionIds.includes(cited)) : undefined;
        if (cited && !citedWork && !wanted) { const workspace = roots.find(root => root.root === state.currentCwd); if (workspace) { const data = await request("/api/work", { title: workspace.name, workspaceIds: [workspace.id], sessionIds: [state.currentSessionId] }); citedWork = data.work; records.push(data.work); } }
        if (wanted && !records.some(work => work.id === wanted)) throw new Error("The requested work is unavailable");
        const id = wanted || citedWork?.id || records.find(work => work.id === remembered)?.id || records[0]?.id;
        ready = true; toggleDrawer(drawerOpen);
        if (id) { const link = resourceFromUrl(new URL(location.href)), showChat = params.get("chat") === "1" || Boolean(cited); if (cited) sceneForCitation(id); await selectWork(id, false); if (link && current()!.workspaceIds.includes(link.workspaceId)) await openItem(link, false, false); if (showChat) await openChat(); }
        const [views, drafts] = await Promise.all([request("/api/work/views"), request("/api/work/drafts")]);
        for (const command of views.commands) if (!receipts.has(command.id)) pending.set(command.id, { type: "view", command });
        for (const command of drafts.commands) if (!receipts.has(command.id)) pending.set(command.id, { type: "draft", command }); render();
      } catch (error) { ready = false; throw error; }
      finally { initializing = false; }
    },
  };
  function sceneForCitation(id: string) { const previous = currentId; currentId = id; const workspace = roots.find(root => root.root === state.currentCwd); if (workspace && current()!.workspaceIds.includes(workspace.id)) scene().runWorkspaceId = workspace.id; currentId = previous; }
}
