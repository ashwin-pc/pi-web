/* Browser-only Pi Web interface probe. Files, MCP connection and agent are sample data. */
(() => {
  "use strict";
  const workspaces = [
    { id: "pi-web", name: "Pi Web", label: "Responsive agent workspace", color: "gold", icon: "P" },
    { id: "trail-notes", name: "Trail Notes", label: "A second project: routes, data and plans", color: "blue", icon: "T" },
  ];
  /** @typedef {{id: string, workspaceIds: string[], name: string, summary: string, initial: string[]}} Activity */
  /** @type {Activity[]} Activities reference workspaces; no workspace is their parent. */
  const activities = [
    { id: "coordinate-release", workspaceIds: ["pi-web", "trail-notes"], name: "Coordinate the release", summary: "Pi Web checklist + Trail Notes roadmap", initial: ["pi-release-doc", "trail-roadmap-doc"] },
    { id: "pi-navigation", workspaceIds: ["pi-web"], name: "Workspace navigation", summary: "Design document + running shell", initial: ["pi-nav", "pi-preview"] },
    { id: "pi-release", workspaceIds: ["pi-web"], name: "Prepare the release", summary: "Checklist + working changes", initial: ["pi-release-doc", "pi-diff"] },
    { id: "trail-usage", workspaceIds: ["trail-notes"], name: "Explore usage", summary: "Dashboard + analysis notes", initial: ["trail-dashboard", "trail-analysis"] },
    { id: "trail-roadmap", workspaceIds: ["trail-notes"], name: "Plan the next release", summary: "Roadmap + planning board", initial: ["trail-roadmap-doc", "trail-board"] },
  ];
  // Files belong to workspaces; apps and browser pages retain their own owners.
  const resources = {
    "pi-nav": { workspaceId: "pi-web", path: "docs/workspace-shell.md", type: "doc", title: "Workspace navigation", text: "Open your work before starting a conversation.\n\nFiles, apps and browser pages stay open when Chat closes.\nChat is available when needed.\n\nDesktop\n- Keep the current file steady.\n- Open related files and apps alongside it.\n- Name the project on each file.\n\nMobile\n- One file or app at a time.\n- Keep switching within thumb reach.\n- Returning restores the file and draft.\n\nReview\n- Check tap targets at 44px.\n- Check navigation with Chat closed.\n" },
    "pi-preview": { workspaceId: "pi-web", path: "examples/workspace-shell.html", type: "shell-app", title: "Running workspace shell" },
    "pi-release-doc": { workspaceId: "pi-web", path: "docs/release-checklist.md", type: "doc", title: "Release checklist", text: "Before the next prototype release\n\n[ ] Review workspace navigation\n[ ] Verify mobile file and app switching\n[ ] Check packaged shared modules\n[ ] Review architectural notes\n\nRelease notes\n\n" },
    "pi-diff": { workspaceId: "pi-web", path: "src/workspace/shell.css", type: "diff", title: "Working changes" },
    "pi-readme": { workspaceId: "pi-web", path: "README.md", type: "doc", title: "Pi Web README", text: "Pi Web\n\nA browser workspace for files, apps and agents.\nThis README belongs to the Pi Web workspace.\n" },
    "trail-dashboard": { workspaceId: "trail-notes", path: "apps/usage-dashboard.html", type: "dashboard", title: "Usage dashboard" },
    "trail-analysis": { workspaceId: "trail-notes", path: "notes/analysis.md", type: "doc", title: "Analysis notes", text: "Questions for this week's route data\n\n- Which routes are getting repeat visits?\n- Does weekend usage differ from weekdays?\n\nObservations\n\n" },
    "trail-data": { workspaceId: "trail-notes", path: "data/usage.csv", type: "table", title: "Route data" },
    "trail-roadmap-doc": { workspaceId: "trail-notes", path: "docs/roadmap.md", type: "doc", title: "Next release", text: "Trail Notes — next release\n\nNow\n- Understand repeat route visits\n- Simplify saving a route\n\nNext\n- Share a weekend collection\n- Add a compact map view\n\nDecisions\n\n" },
    "trail-board": { workspaceId: "trail-notes", path: "apps/planning-board.html", type: "board", title: "Planning board" },
    "trail-readme": { workspaceId: "trail-notes", path: "README.md", type: "doc", title: "Trail Notes README", text: "Trail Notes\n\nRoutes, observations and ideas for the next weekend.\nThis README belongs to the Trail Notes workspace.\n" },
  };
  // Lucide icon nodes from Pi Web's existing MIT-licensed dependency.
  const iconNodes = {"Layers":[["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]],"PanelsTopLeft":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M9 21V9"}]],"PanelRight":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}]],"PanelLeft":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],"Maximize2":[["path",{"d":"M15 3h6v6"}],["path",{"d":"m21 3-7 7"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M9 21H3v-6"}]],"Minimize2":[["path",{"d":"m14 10 7-7"}],["path",{"d":"M20 10h-6V4"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M4 14h6v6"}]],"Folder":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],"FileText":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]],"GitBranch":[["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],"MessageCircle":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"ArrowLeftRight":[["path",{"d":"M8 3 4 7l4 4"}],["path",{"d":"M4 7h16"}],["path",{"d":"m16 21 4-4-4-4"}],["path",{"d":"M20 17H4"}]],"ArrowUpRight":[["path",{"d":"M7 7h10v10"}],["path",{"d":"M7 17 17 7"}]],"X":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"Search":[["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],"Plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"Bell":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]],"Grid2X2":[["path",{"d":"M12 3v18"}],["path",{"d":"M3 12h18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"Link":[["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],"CircleCheck":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],"ChevronDown":[["path",{"d":"m6 9 6 6 6-6"}]],"Globe":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],"Pin":[["path",{"d":"M12 17v5"}],["path",{"d":"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"}]],"PinOff":[["path",{"d":"M12 17v5"}],["path",{"d":"M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"}],["path",{"d":"m2 2 20 20"}],["path",{"d":"M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"}]],"ArrowUp":[["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],"Columns2":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 3v18"}]],"Paperclip":[["path",{"d":"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"}]]};
  iconNodes.Square = [["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }]];
  Object.assign(resources, {
    browser: { type: "browser", title: "Browser", url: "https://pi-web.example/preview" },
    "release-planner": { type: "mcp-app", title: "Release planner", connectionId: "planning-tools-demo" },
  });
  const PREFIX = "pi-web.multitasking-probe.v3/";
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconNodes[name] || iconNodes.FileText).map(([tag, attributes]) => '<' + tag + ' ' + Object.entries(attributes).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '/>').join('') + '</svg>';
  let tabId = crypto.randomUUID();
  try { tabId = sessionStorage.getItem(PREFIX + "tab") || tabId; sessionStorage.setItem(PREFIX + "tab", tabId); } catch { /* A window can operate without storage. */ }
  const memory = new Map(), sceneCache = new Map(), conflicts = new Map(), knownVersions = new Map();
  const processing = new Set();
  let runGeneration = 0, autoFinish = true;
  let current = null, chatOpen = false, drawerOpen = true, launcherOpen = false, overlay = null;
  let routeProblem = "", workSearch = "", composing = false, restoring = false, overlayReturnFocus = null;
  const mobile = () => matchMedia("(max-width: 1024px)").matches;
  const ws = (id) => workspaces.find((item) => item.id === id);
  const act = (id) => activities.find((item) => item.id === id);
  const item = (id) => resources[id] ? { id, ...resources[id] } : null;
  function get(key, fallback) {
    if (memory.has(key)) return memory.get(key);
    try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? "null") ?? fallback; } catch { return fallback; }
  }
  function put(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Keep the current window usable. */ }
  }
  const list = (key) => { const value = get(key, []); return Array.isArray(value) ? value : []; };
  function scope(workId) {
    const work = act(workId);
    if (!work) return [];
    // Files belong to roots; connected apps and browser tabs have other owners.
    return [...new Set([...work.workspaceIds, ...list("references/" + workId).map((id) => item(id)?.workspaceId)])].filter(ws);
  }
  const scopeName = (ids) => ids.map((id) => ws(id)?.name).filter(Boolean).join(" + ");
  const known = (workId) => [...new Set([...act(workId).initial, ...list("references/" + workId)])].filter(item);
  const docKey = (source) => "document/" + JSON.stringify([source.workspaceId, source.path]);
  function readDoc(source) {
    const key = docKey(source);
    if (conflicts.has(key)) return conflicts.get(key).local;
    const value = get(key, { saved: source.text, draft: source.text, version: 0 });
    return typeof value.draft === "string" && typeof value.saved === "string" && Number.isSafeInteger(value.version) ? value : { saved: source.text, draft: source.text, version: 0 };
  }
  function scene(workId) {
    const work = act(workId);
    const raw = sceneCache.get(workId) ?? get("scene/" + workId, { open: [work.initial[0]], active: work.initial[0], beside: null, pinned: [work.initial[0]], positions: {}, filters: {}, revision: 0, browserPage: "pi-web" });
    const open = (Array.isArray(raw.open) ? raw.open : [work.initial[0]]).filter((id) => known(workId).includes(id));
    const value = { ...raw, open, active: open.includes(raw.active) ? raw.active : open[0], beside: open.includes(raw.beside) && raw.beside !== raw.active ? raw.beside : null, pinned: (raw.pinned || []).filter((id) => open.includes(id)), positions: raw.positions || {}, filters: raw.filters || {} };
    sceneCache.set(workId, value); return value;
  }
  function saveScene(workId, value, userChange = false) { if (userChange) value.revision++; sceneCache.set(workId, value); put("scene/" + workId, value); }
  function attach(workId, id) { if (!act(workId) || !item(id)) return; const refs = list("references/" + workId); if (!refs.includes(id)) put("references/" + workId, [...refs, id]); }
  const jobs = () => list("jobs").filter((job) => act(job.workId) && ws(job.executionWorkspaceId) && Array.isArray(job.readWorkspaceIds));
  const jobFor = (workId) => jobs().findLast((job) => job.workId === workId);
  function status(workId) {
    const job = jobFor(workId);
    if (job?.status === "running") return { kind: "running", label: "Pi is working" };
    if (job && !job.seen && job.status !== "running") return { kind: "ready", label: "Answer ready" };
    if (known(workId).some((id) => item(id).type === "doc" && readDoc(item(id)).draft !== readDoc(item(id)).saved)) return { kind: "draft", label: "Draft kept" };
    return { kind: "idle", label: "Ready to continue" };
  }
  function captureEditors() {
    document.querySelectorAll("textarea[data-document]").forEach((editor) => { const value = scene(editor.dataset.work); value.positions[editor.dataset.document] = { from: editor.selectionStart, to: editor.selectionEnd, scroll: editor.scrollTop }; saveScene(editor.dataset.work, value); });
  }
  function writeRoute(replace = false) {
    const url = new URL(location.href);
    for (const key of ["work", "tab", "beside", "chat", "activity", "workspace", "view", "resource", "card"]) url.searchParams.delete(key);
    if (current) { const value = scene(current); url.searchParams.set("work", current); if (value.active) url.searchParams.set("tab", value.active); if (value.beside) url.searchParams.set("beside", value.beside); if (chatOpen) url.searchParams.set("chat", "1"); }
    history[replace ? "replaceState" : "pushState"]({}, "", url);
  }
  function readRoute() {
    const params = new URL(location.href).searchParams;
    const id = params.get("work") || params.get("activity");
    routeProblem = ""; current = act(id)?.id || null; chatOpen = params.get("chat") === "1";
    if (id && !current) routeProblem = "This work is unavailable in the demo.";
    if (current && params.get("workspace") && !scope(current).includes(params.get("workspace"))) { current = null; routeProblem = "This work does not include that workspace."; }
    if (current) {
      const value = scene(current), tab = params.get("tab") || params.get("resource");
      if (tab && !known(current).includes(tab)) { current = null; routeProblem = "This file or app has not been opened in this work."; }
      else {
        if (tab) { if (!value.open.includes(tab)) value.open.push(tab); value.active = tab; }
        const beside = params.get("beside"); value.beside = null;
        if (known(current).includes(beside) && beside !== value.active) { if (!value.open.includes(beside)) value.open.push(beside); value.beside = beside; }
        saveScene(current, value);
      }
    }
  }
  function navigate(workId) {
    if (!act(workId)) return;
    captureEditors(); current = workId; chatOpen = false; routeProblem = ""; workSearch = "";
    if (mobile()) drawerOpen = false;
    closeOverlay(); writeRoute(); render(false);
  }
  function openItem(workId, id, beside = false) {
    if (!act(workId) || !item(id)) return;
    captureEditors(); attach(workId, id); const value = scene(workId);
    if (!value.open.includes(id)) value.open.push(id);
    if (beside && value.active && value.active !== id) value.beside = id;
    else { const previous = value.active; value.active = id; if (value.beside === id) value.beside = previous !== id ? previous : null; }
    saveScene(workId, value, true); closeOverlay(); writeRoute(); render(false);
  }
  function closeItem(workId, id, agent = false) {
    const value = scene(workId);
    if (agent && value.pinned.includes(id)) return false;
    captureEditors(); value.open = value.open.filter((key) => key !== id); value.pinned = value.pinned.filter((key) => key !== id);
    if (value.active === id) value.active = value.beside || value.open[0];
    if (value.beside === id || value.beside === value.active) value.beside = null;
    saveScene(workId, value, !agent); return true;
  }
  function documentInput(editor) {
    const source = item(editor.dataset.document), key = docKey(source), latest = readDoc(source);
    if (conflicts.has(key)) { conflicts.get(key).local.draft = editor.value; put("recovery/" + tabId + "/" + key, conflicts.get(key).local); }
    else { const value = { ...latest, draft: editor.value, version: latest.version + 1 }; put(key, value); knownVersions.set(key, value.version); }
    const value = scene(editor.dataset.work); saveScene(editor.dataset.work, value, true); captureEditors();
    document.querySelectorAll(`[data-draft="${source.id}"]`).forEach((node) => node.textContent = editor.value === latest.saved ? "Saved" : "Draft kept");
  }
  function saveDocument(id) {
    const source = item(id), key = docKey(source), editor = document.querySelector(`[data-document="${id}"]`);
    if (!editor || conflicts.has(key)) return;
    const latest = readDoc(source); put(key, { saved: editor.value, draft: editor.value, version: latest.version + 1 }); render();
  }
  function resolveConflict(id, keepMine) {
    const source = item(id), key = docKey(source), conflict = conflicts.get(key); if (!conflict) return;
    if (keepMine) put(key, { ...conflict.local, version: conflict.remote.version + 1 });
    else put(key, conflict.remote);
    conflicts.delete(key); render();
  }
  const defaults = [
    { id: "pi-mobile", workspaceId: "pi-web", title: "Mobile navigation", status: "ready" },
    { id: "pi-package", workspaceId: "pi-web", title: "Packaged shared modules", status: "ready" },
    { id: "trail-save", workspaceId: "trail-notes", title: "Saving a route", status: "ready" },
    { id: "trail-map", workspaceId: "trail-notes", title: "Compact map", status: "missing" },
  ];
  function launchItems() { const saved = get("planner", {}); return defaults.map((entry) => ({ ...entry, status: ["ready", "missing"].includes(saved[entry.id]) ? saved[entry.id] : entry.status })); }
  function callPlanner(name, args, allowedRoots) {
    if (name === "get_launch_plan") return { items: launchItems().filter((entry) => allowedRoots.includes(entry.workspaceId)) };
    if (name === "set_launch_status") {
      const entry = defaults.find((entry) => entry.id === args?.id);
      if (!entry || !allowedRoots.includes(entry.workspaceId) || !["ready", "missing"].includes(args?.status)) throw new Error("This app cannot update that launch item.");
      put("planner", { ...get("planner", {}), [entry.id]: args.status }); return { item: { ...entry, status: args.status } };
    }
    throw new Error("This app tool is unavailable.");
  }
  // The same small backend is called by the agent and the sandboxed sample app.
  function plannerResult(roots) { const data = callPlanner("get_launch_plan", {}, roots); data.items = data.items.map((entry) => ({ ...entry, workspaceName: ws(entry.workspaceId).name })); return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false }; }
  function notifyPlannerFrames() {
    document.querySelectorAll('iframe[data-app="release-planner"]').forEach((frame) => frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: plannerResult(scope(frame.dataset.work)) }, "*"));
  }
  function guestDocument(kind, pageId = "pi-web", nonce = "") {
    const isPlanner = kind === "planner", title = pageId === "pi-web" ? "Pi Web preview" : "Trail Notes preview";
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
    const css = `*{box-sizing:border-box}body{margin:0;background:#0a0a0a;color:#f2f2f2;font:14px/1.55 system-ui;padding:20px}h1{font-size:25px;line-height:1.25;font-weight:550;margin:14px 0}p,small{color:#a3a3a3}small{font-size:10px}button{color:inherit;background:#131313;border:1px solid #363636;border-radius:8px;min-height:44px;padding:9px 12px;font:12px system-ui;cursor:pointer}button:focus-visible{outline:2px solid #e2b15f}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #242424;padding-bottom:12px}.gold{color:#e2b15f}.row{border:1px solid #242424;border-radius:10px;margin:12px 0;padding:14px}.row strong{display:block;font-weight:550}.row p{font-size:11px;margin:5px 0 12px}.status{color:#e2b15f;font-size:11px}.nav{display:flex;gap:6px;flex-wrap:wrap;margin:24px 0}.note{border-left:2px solid #e2b15f;padding:12px;background:#131313;font-size:12px}#error{color:#fb7185;font-size:12px}.planner .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px}.planner .row>div{min-width:0}.planner .row p{margin:4px 0 0}.planner .row button{flex:0 0 auto;font-size:10px}`;
    let body, script;
    if (isPlanner) {
      body = '<header><span class="gold">Release planner</span><small>Sample connected app</small></header><h1>Ready for launch?</h1><p>The launch checklist across your projects.</p><div id="items"></div><p id="error" role="status"></p>';
      script = `let next=1;const pending=new Map();const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function request(method,params){const id=next++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise(resolve=>pending.set(id,resolve))}function paint(data){document.getElementById('items').innerHTML=(data.items||[]).map(i=>'<section class="row"><div><small>'+esc(i.workspaceName)+'</small><strong>'+esc(i.title)+'</strong><p class="status">'+(i.status==='ready'?'Ready':'Still missing')+'</p></div><button data-id="'+esc(i.id)+'" data-status="'+(i.status==='ready'?'missing':'ready')+'">'+(i.status==='ready'?'Mark missing':'Mark ready')+'</button></section>').join('');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=async()=>{const r=await request('tools/call',{name:'set_launch_status',arguments:{id:b.dataset.id,status:b.dataset.status}});if(r.error)document.getElementById('error').textContent=r.error.message;else{const plan=await request('tools/call',{name:'get_launch_plan',arguments:{}});paint(plan.result.structuredContent)}})}addEventListener('message',e=>{if(e.source!==parent||e.data?.jsonrpc!=='2.0')return;const m=e.data;if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}if(m.method==='ui/notifications/tool-result')paint(m.params.structuredContent)});(async()=>{await request('ui/initialize',{appInfo:{name:'release-planner'}});parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');const r=await request('tools/call',{name:'get_launch_plan',arguments:{}});paint(r.result.structuredContent)})();`;
    } else {
      const pi = pageId === "pi-web";
      body = `<header><strong>${pi ? "π pi web" : "Trail Notes"}</strong><small>Sample preview page</small></header><h1>${pi ? "A place for your work." : "A map for the weekend."}</h1><p>${pi ? "Files and apps first. Bring Pi in whenever you need help." : "Save a route, keep a note, and find your way back."}</p><nav class="nav"><button data-tap>Files</button><button data-tap>Apps</button><button data-tap>Ask Pi</button></nav><section class="row" data-launch-status="ready" data-title="${pi ? "Mobile navigation" : "Saving a route"}"><strong>${pi ? "Mobile navigation" : "Saving a route"}</strong><p>Ready for the next release.</p></section>${pi ? "" : '<section class="row" data-launch-status="missing" data-title="Compact map"><strong>Compact map</strong><p>Coming next. The compact map still needs a launch check.</p></section>'}<div class="note">${pi ? "Your files stay open when Chat closes." : "Routes and notes stay together."}</div><p id="clicked"></p>`;
      script = `document.querySelectorAll('[data-tap]').forEach(b=>b.onclick=()=>document.getElementById('clicked').textContent=b.textContent+' opened in this sample page.');parent.postMessage({type:'demo/browser/inspection',nonce:${JSON.stringify(nonce)},pageId:${JSON.stringify(pageId)},title:document.title,targets:[...document.querySelectorAll('[data-tap]')].map(b=>({label:b.textContent,height:b.getBoundingClientRect().height})),checks:[...document.querySelectorAll('[data-launch-status]')].map(n=>({title:n.dataset.title,status:n.dataset.launchStatus}))},'*');`;
    }
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${isPlanner ? "Release planner" : title}</title><style>${css}</style><body${isPlanner ? ' class="planner"' : ''}>${body}<script>${script}<\/script></body></html>`;
  }
  function inspectBrowser(pageId, nonce) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.title = "Agent sample browser"; frame.className = "agentRuntime";
      const cleanup = () => { clearTimeout(timer); removeEventListener("message", receive); frame.remove(); };
      const receive = (event) => { const value = event.data; if (event.source !== frame.contentWindow || value?.type !== "demo/browser/inspection" || value.nonce !== nonce || value.pageId !== pageId) return; cleanup(); resolve(value); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("The sample browser did not respond.")); }, 4000);
      addEventListener("message", receive); frame.srcdoc = guestDocument("browser", pageId, nonce); $("agentRuntimes").append(frame);
    });
  }
  window.addEventListener("message", (event) => {
    const frame = [...document.querySelectorAll('iframe[data-app="release-planner"]')].find((frame) => frame.contentWindow === event.source);
    const message = event.data;
    if (!frame || message?.jsonrpc !== "2.0" || !Number.isSafeInteger(message.id) || !message.method) return;
    const reply = (value) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id: message.id, ...value }, "*");
    try {
      if (message.method === "ui/initialize") reply({ result: { protocolVersion: "demo", hostInfo: { name: "Pi Web prototype" }, hostCapabilities: { tools: {} } } });
      else if (message.method === "tools/call") {
        const data = callPlanner(message.params?.name, message.params?.arguments, scope(frame.dataset.work));
        if (data.items) data.items = data.items.map((entry) => ({ ...entry, workspaceName: ws(entry.workspaceId).name }));
        reply({ result: { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }], isError: false } });
        if (message.params.name === "set_launch_status") notifyPlannerFrames();
      } else throw new Error("This app request is unavailable.");
    } catch (error) { reply({ error: { code: -32601, message: error.message } }); }
  });
  function promptPlan(text) {
    const lower = text.toLowerCase();
    const noEdits = /read[ -]only|(?:don't|do not|never|without|avoid)[\s\w]{0,24}(?:add|update|edit|append|write|change)/.test(lower);
    const edit = !noEdits && /\b(add|update|edit|append|write)\b/.test(lower) && /checklist|release notes/.test(lower);
    const closeBrowser = /(?:close|hide|shut)[\s\w]{0,24}browser/.test(lower) && !/(?:don't|do not|never)[\s\w]{0,12}(?:close|hide|shut)[\s\w]{0,24}browser/.test(lower);
    const closePlanner = /(?:close|hide)[\s\w]{0,24}planner/.test(lower) && !/(?:don't|do not|never)[\s\w]{0,12}(?:close|hide)[\s\w]{0,24}planner/.test(lower);
    const pinPlanner = /\b(?:pin|keep)\b[\s\w]{0,28}planner/.test(lower);
    const unpinPlanner = /\bunpin\b[\s\w]{0,24}planner/.test(lower);
    const openBrowser = !closeBrowser && /browser|preview|website/.test(lower);
    const planner = !closePlanner && /planner|mcp|launch|missing|ready|release/.test(lower) || edit;
    const fileId = /readme/.test(lower) ? (/trail/.test(lower) ? "trail-readme" : "pi-readme") : /roadmap/.test(lower) && !planner ? "trail-roadmap-doc" : /(?:open|show|focus)[\s\w]{0,24}checklist/.test(lower) ? "pi-release-doc" : null;
    const showOnly = /show only|focus on|just show/.test(lower);
    return { edit, closeBrowser, closePlanner, pinPlanner, unpinPlanner, openBrowser, planner, fileId, showOnly, pageId: /trail.{0,20}(?:browser|preview)|(?:browser|preview).{0,20}trail/.test(lower) ? "trail-notes" : "pi-web" };
  }
  function chatState(workId) {
    const value = get("chat/" + workId, {}), members = scope(workId);
    return { ...value, prompt: value.prompt || "", executionWorkspaceId: members.includes(value.executionWorkspaceId) ? value.executionWorkspaceId : members[0], readWorkspaceIds: Array.isArray(value.readWorkspaceIds) ? value.readWorkspaceIds.filter((id) => members.includes(id)) : members };
  }
  function submitPrompt(text) {
    if (!current || !text.trim() || jobFor(current)?.status === "running") return;
    const state = chatState(current); if (!state.readWorkspaceIds.length) return;
    captureEditors(); const value = scene(current), plan = promptPlan(text);
    const source = item("pi-release-doc"), snapshot = readDoc(source);
    const job = { id: crypto.randomUUID(), workId: current, tabId, request: text.trim(), plan,
      executionWorkspaceId: state.executionWorkspaceId, readWorkspaceIds: [...state.readWorkspaceIds], started: Date.now(), due: Date.now() + 1400, status: "running", seen: true,
      previousScene: structuredClone(value), submittedRevision: value.revision,
      documentVersion: snapshot.version, documentDraft: snapshot.draft, calls: [], commands: null,
    };
    put("jobs", [...jobs(), job]); put("chat/" + current, { ...state, prompt: "" }); render(false);
  }
  function updateJob(id, change) { const values = jobs(); const index = values.findIndex((job) => job.id === id); if (index < 0) return; values[index] = { ...values[index], ...change }; put("jobs", values); }
  const viewReceipt = (id) => get("ui/" + tabId + "/" + id, { applied: false, restored: false });
  function arrangeFromJob(job, explicit = false) {
    const value = scene(job.workId), command = job.commands;
    if (!command) return;
    const previousScene = structuredClone(value);
    if (command.open.includes("browser")) value.browserPage = command.browserPage;
    for (const id of command.open) { attach(job.workId, id); if (!value.open.includes(id)) value.open.push(id); }
    value.pinned = value.pinned.filter((id) => !command.unpin?.includes(id));
    for (const id of command.pin) if (!value.pinned.includes(id)) value.pinned.push(id);
    for (const id of command.close) if (!value.pinned.includes(id)) {
      value.open = value.open.filter((other) => other !== id);
      if (value.active === id) value.active = value.open[0];
      if (value.beside === id) value.beside = null;
    }
    const display = command.show.filter((id) => value.open.includes(id));
    if (display.length) { value.active = display[0]; value.beside = display[1] || null; }
    if (value.beside === value.active) value.beside = null;
    saveScene(job.workId, value, explicit); put("ui/" + tabId + "/" + job.id, { applied: true, restored: false, previousScene }); updateJob(job.id, { seen: true });
  }
  async function finishJob(id) {
    let job = jobs().find((job) => job.id === id);
    if (!job || job.status !== "running" || processing.has(id)) return;
    const generation = runGeneration;
    processing.add(id);
    try {
      const plan = job.plan, calls = [], open = [], show = [], close = [], pin = [], unpin = [];
      let inspection = null, launch = { items: [] }, reply = "", edit = null;
      if (plan.planner) {
        calls.push({ name: "Planning tools · get_launch_plan", status: "done" }); launch = callPlanner("get_launch_plan", {}, job.readWorkspaceIds);
        open.push("release-planner"); show.push("release-planner");
      }
      if (plan.openBrowser) {
        if (!job.readWorkspaceIds.includes(plan.pageId)) throw new Error(`Include ${ws(plan.pageId).name} in Context to check its preview.`);
        inspection = await inspectBrowser(plan.pageId, job.id);
        calls.push({ name: "Browser · inspect preview page", status: "done" }); open.push("browser"); show.unshift("browser");
      }
      if (generation !== runGeneration || !jobs().some((entry) => entry.id === id && entry.status === "running")) return;
      if (plan.fileId) { if (!job.readWorkspaceIds.includes(item(plan.fileId).workspaceId)) throw new Error("Include this file's workspace in Context before asking Pi to open it."); open.push(plan.fileId); show.unshift(plan.fileId); }
      const missing = launch.items.filter((entry) => entry.status === "missing");
      if (plan.edit) {
        if (!scope(job.workId).includes("pi-web") || !job.readWorkspaceIds.includes("pi-web")) throw new Error("Open the Pi Web checklist in this work and include Pi Web in Context before asking for an edit.");
        const lines = missing.map((entry) => `[ ] Check ${ws(entry.workspaceId).name}: ${entry.title.toLowerCase()} before launch.`);
        if (!lines.length) reply = "The planner has no missing launch checks in the selected projects. I left the checklist as it was.";
        else {
          const source = item("pi-release-doc"), latest = readDoc(source);
          const additions = lines.filter((line) => !latest.draft.includes(line));
          edit = { documentId: source.id, workspaceId: source.workspaceId, lines: additions, state: "applied" };
          const editing = document.activeElement?.matches('[data-document="pi-release-doc"]');
          if (latest.version !== job.documentVersion || conflicts.has(docKey(source)) || editing || composing) {
            edit.state = "proposed"; reply = "The checklist changed while I was checking. I prepared an addition below and kept your current draft.";
          } else if (additions.length) {
            put(docKey(source), { ...latest, draft: latest.draft.replace(/\s*$/, "") + "\n\n" + additions.join("\n") + "\n", version: latest.version + 1 });
            reply = "I added the missing launch check to the Pi Web checklist as a draft. Your existing notes are kept.";
          } else reply = "That launch check is already in the Pi Web checklist.";
          calls.push({ name: "Files · update Pi Web / docs/release-checklist.md", status: edit.state });
          open.push(source.id); show.unshift(source.id);
        }
      } else if (plan.planner || plan.openBrowser) {
        const ready = launch.items.length - missing.length;
        reply = launch.items.length ? `${ready} of ${launch.items.length} checks are ready. ${missing.length ? missing.map((entry) => `${ws(entry.workspaceId).name}: ${entry.title} is still missing.`).join(" ") : "There are no missing checks in the planner."}` : "I checked the sample preview page.";
        if (inspection) reply += ` The ${ws(plan.pageId).name} preview has ${inspection.targets.length} controls, all ${inspection.targets.every((target) => target.height >= 44) ? "at least 44px high" : "not all 44px high"}.`;
      } else if (plan.fileId) reply = `I opened ${item(plan.fileId).title}.`;
      else if (plan.closeBrowser || plan.closePlanner || plan.unpinPlanner) reply = "";
      else reply = "This sample agent can open the preview and release planner, check what's missing, and add a launch check to the Pi Web checklist. Try one of the suggested prompts.";
      if (plan.pinPlanner) { attach(job.workId, "release-planner"); open.push("release-planner"); pin.push("release-planner"); if (!show.includes("release-planner")) show.push("release-planner"); reply += " The planner is pinned here."; }
      if (plan.closeBrowser) { close.push("browser"); reply += scene(job.workId).pinned.includes("browser") ? " The browser stays open because you pinned it. You can close it with its × button." : " I closed the browser tab."; }
      if (plan.unpinPlanner) { unpin.push("release-planner"); reply += " I unpinned the planner."; }
      if (plan.closePlanner) { close.push("release-planner"); reply += scene(job.workId).pinned.includes("release-planner") && !plan.unpinPlanner ? " The planner stays open because you pinned it. Ask me to unpin it first, or close it with ×." : " I closed the planner."; }
      const commands = { open: [...new Set(open)], show: [...new Set(show)].slice(0, plan.showOnly ? 1 : 2), close, pin, unpin, browserPage: plan.pageId };
      for (const key of commands.open) attach(job.workId, key);
      const canArrange = current === job.workId && scene(job.workId).revision === job.submittedRevision && !composing && !document.activeElement?.matches("textarea[data-document]");
      job = { ...job, status: "done", finished: Date.now(), calls, reply, edit, commands, inspection, launch, seen: current === job.workId && chatOpen };
      updateJob(id, job);
      if (canArrange) {
        if (plan.openBrowser) { const value = scene(job.workId); value.browserPage = plan.pageId; saveScene(job.workId, value); }
        arrangeFromJob(job);
        writeRoute();
      }
      render(); $("announcer").textContent = `${act(job.workId).name}: Pi's answer is ready.`;
    } catch (error) { if (generation !== runGeneration || jobs().find((entry) => entry.id === id)?.status !== "running") return; updateJob(id, { status: "failed", finished: Date.now(), reply: error.message, seen: current === job.workId && chatOpen }); render(); }
    finally { processing.delete(id); }
  }
  function applyEdit(id) {
    const job = jobs().find((job) => job.id === id); if (!job?.edit || job.edit.state !== "proposed") return;
    const source = item(job.edit.documentId), key = docKey(source); if (conflicts.has(key)) return;
    const latest = readDoc(source), additions = job.edit.lines.filter((line) => !latest.draft.includes(line));
    if (additions.length) put(key, { ...latest, draft: latest.draft.replace(/\s*$/, "") + "\n\n" + additions.join("\n") + "\n", version: latest.version + 1 });
    updateJob(id, { edit: { ...job.edit, state: "applied" }, reply: "I added the launch check to your current Pi Web draft, keeping your latest notes." });
    openItem(job.workId, source.id);
  }
  function restoreView(id) {
    const job = jobs().find((job) => job.id === id); if (!job || job.workId !== current) return;
    captureEditors(); const value = scene(current), previous = structuredClone(viewReceipt(id).previousScene || job.previousScene);
    previous.open = [...new Set([...previous.open, ...value.pinned])]; previous.pinned = [...value.pinned]; previous.positions = value.positions; previous.filters = value.filters; previous.revision = value.revision + 1;
    saveScene(current, previous); put("ui/" + tabId + "/" + id, { ...viewReceipt(id), applied: false, restored: true }); writeRoute(); render(false);
  }
  const itemIcon = (source) => ({ doc: "FileText", diff: "GitBranch", browser: "Globe", "mcp-app": "Grid2X2" }[source.type] || "PanelsTopLeft");
  const ownerLabel = (source) => source.workspaceId ? ws(source.workspaceId).name : source.type === "browser" ? "Sample web page" : "Planning tools · sample MCP app";
  function workRows(query = "") {
    return activities.filter((work) => `${work.name} ${scopeName(scope(work.id))}`.toLowerCase().includes(query.toLowerCase())).map((work) => {
      const state = status(work.id);
      return `<button class="workRow ${current === work.id ? "active" : ""}" data-work="${work.id}"><strong>${escape(work.name)}</strong><small>${escape(scopeName(scope(work.id)))}</small><span><i class="statusDot ${state.kind}"></i>${state.label}</span></button>`;
    }).join("") || '<p class="emptyList">No work matches this search.</p>';
  }
  function renderDrawer() {
    return `<aside class="workDrawer" aria-label="Your work"><header><span>Work</span><button class="iconButton" data-toggle-work aria-label="Close work drawer">${icon("PanelLeft")}</button></header><label class="workSearch">${icon("Search")}<input data-work-search aria-label="Find work or a project" placeholder="Find work or a project" value="${escape(workSearch)}"></label><div class="workList">${workRows(workSearch)}</div><footer>Choose what you’re working on.<br>Files and apps open in the tabs below.</footer></aside>`;
  }
  function renderDocument(source) {
    const value = readDoc(source), key = docKey(source); if (!conflicts.has(key)) knownVersions.set(key, value.version);
    const conflict = conflicts.has(key) ? `<div class="conflict">Changed in another tab. Your draft is kept.<div><button class="button" data-resolve="${source.id}" data-mine="true">Keep this draft</button><button class="button" data-resolve="${source.id}" data-mine="false">Use other draft</button></div></div>` : "";
    return `<div class="editor">${conflict}<h2>${escape(source.title)}</h2><textarea data-document="${source.id}" data-work="${current}" aria-label="${escape(source.path)} in ${escape(ws(source.workspaceId).name)}" spellcheck="false">${escape(value.draft)}</textarea><footer><span data-draft="${source.id}">${value.draft === value.saved ? "Saved" : "Draft kept"}</span><button class="button" data-save="${source.id}" ${conflicts.has(key) ? "disabled" : ""}>Save in ${escape(ws(source.workspaceId).name)}</button></footer></div>`;
  }
  function renderBody(source) {
    const value = scene(current);
    if (source.type === "doc") return renderDocument(source);
    if (source.type === "mcp-app") return `<iframe data-app="release-planner" data-work="${current}" title="Release planner connected app" sandbox="allow-scripts" srcdoc="${escape(guestDocument("planner"))}"></iframe>`;
    if (source.type === "browser") {
      const root = value.browserPage === "trail-notes" ? "trail-notes" : "pi-web";
      return `<div class="browser"><form class="addressBar" data-browser-address><span>${icon("Globe")}</span><input name="address" aria-label="Browser address" value="https://${root}.example/preview"><button class="iconButton" aria-label="Navigate to sample page">${icon("ArrowUpRight")}</button></form><div class="browserPage"><iframe title="${escape(ws(root).name)} sample browser page" sandbox="allow-scripts" srcdoc="${escape(guestDocument("browser", root))}"></iframe></div><footer>Sample preview · <button data-browser-page="${root === "pi-web" ? "trail-notes" : "pi-web"}">Visit ${root === "pi-web" ? "Trail Notes" : "Pi Web"}</button></footer></div>`;
    }
    if (source.type === "shell-app") return `<iframe title="Generated Pi Web app" sandbox="allow-scripts" srcdoc="${escape(guestDocument("browser", "pi-web"))}"></iframe>`;
    if (source.type === "diff") return '<pre class="diff">src/workspace/shell.css\n\n<span class="removed">- padding: 44px 0 0;</span><span class="added">+ padding: 16px 24px;</span><span class="added">+ min-width: 0;</span>\nKeep the file owner visible.\n\nWorking tree · 2 additions, 1 deletion</pre>';
    if (source.type === "dashboard") {
      const range = value.filters[source.id] || "30", data = range === "7" ? [34,52,69,47,81,93,74] : [49,58,46,72,63,85,78];
      return `<div class="dashboard"><small>Trail Notes · Usage</small><h2>Routes people return to.</h2><div class="range">${["7","30"].map((period) => `<button data-range="${period}" data-item="${source.id}" class="button ${range === period ? "selected" : ""}">Last ${period} days</button>`).join("")}</div><div class="metrics"><div><b>${range === "7" ? "428" : "1,840"}</b><small>Route visits</small></div><div><b>${range === "7" ? "38%" : "31%"}</b><small>Returning visitors</small></div></div><div class="chart">${data.map((height) => `<i style="--bar:${height}%"></i>`).join("")}</div><p>Keep observations in the analysis notes.</p></div>`;
    }
    if (source.type === "table") return '<div class="tableWrap"><h2>Route data</h2><table><tr><th>Route</th><th>Visits</th><th>Repeat</th></tr><tr><td>Ridge loop</td><td>182</td><td>42%</td></tr><tr><td>River path</td><td>146</td><td>36%</td></tr></table></div>';
    if (source.type === "board") return `<div class="board"><h2>Plan the next release</h2>${["Simplify saving a route", "Share a weekend collection", "Add a compact map"].map((name,index) => `<div><strong>${name}</strong><button class="button" data-board="${index}">${value.filters["board"+index] ? "Selected" : "Add to release"}</button></div>`).join("")}</div>`;
    return "";
  }
  function renderView(id, beside = false) {
    const source = item(id), value = scene(current); if (!source) return "";
    const pinned = value.pinned.includes(id);
    return `<section class="view ${beside ? "besideView" : ""}" data-view="${id}" data-owner="${source.workspaceId || source.connectionId || "browser-session"}"><header><span class="viewIcon">${icon(itemIcon(source))}</span><span class="viewName"><strong>${escape(source.title)}</strong><small>${escape(ownerLabel(source))}${source.path ? " / " + escape(source.path) : ""}</small></span><button class="iconButton ${pinned ? "pinned" : ""}" data-pin="${id}" aria-label="${pinned ? "Unpin" : "Pin"} ${escape(source.title)}" title="${pinned ? "Unpin" : "Pin"}">${icon("Pin")}</button><button class="iconButton" data-only="${id}" aria-label="Show only ${escape(source.title)}" title="Show only">${icon("Maximize2")}</button><button class="iconButton" data-close-item="${id}" aria-label="Close ${escape(source.title)}">${icon("X")}</button></header><div class="viewBody">${renderBody(source)}</div></section>`;
  }
  function renderTabs() {
    const value = current ? scene(current) : { open: [] };
    return `<nav class="bottomTabs" aria-label="Open files, apps and pages">${value.open.map((id) => { const source = item(id); return `<div class="bottomTab ${value.active === id ? "active" : ""} ${value.beside === id ? "beside" : ""}" data-tab="${id}"><button data-open-item="${id}">${icon(itemIcon(source))}<span><strong>${escape(source.title)}</strong><small>${escape(source.workspaceId ? ws(source.workspaceId).name : source.type === "mcp-app" ? "Connected app" : "Browser")}</small></span>${value.pinned.includes(id) ? icon("Pin") : ""}</button><button class="tabClose" data-close-item="${id}" aria-label="Close ${escape(source.title)}">${icon("X")}</button></div>`; }).join("")}${current ? `<button class="tabAdd" data-picker aria-label="Open a file, app or browser">${icon("Plus")}</button>` : '<span class="tabsEmpty">Files and apps appear here when you open them.</span>'}</nav>`;
  }
  const suggestions = [
    "Open the Pi Web preview in a browser and the release planner. Compare them and tell me what is missing for the launch.",
    "Add the missing check to the Pi Web checklist, keep the planner pinned, and close the browser.",
  ];
  function renderChat() {
    if (!chatOpen || !current) return "";
    const state = chatState(current), values = jobs().filter((job) => job.workId === current), running = jobFor(current)?.status === "running";
    return `<section class="chatPopup" aria-label="Pi chat for ${escape(act(current).name)}"><header><span class="piMark">π</span><span><strong>Pi <small>demo</small></strong><small>${escape(act(current).name)}</small></span><button class="iconButton" data-close-chat aria-label="Minimize Pi chat">${icon("Minimize2")}</button></header><div class="chatMessages" role="log" aria-live="polite">${values.map((job) => `<article class="message user">${escape(job.request)}</article><article class="message assistant">${job.status === "running" ? '<span class="runningText"><i class="statusDot running"></i>Checking the sample files and apps…</span>' : `<p>${escape(job.reply)}</p>${job.commands?.open.length ? `<div class="chatLinks">${job.commands.open.map((id) => `<button data-open-item="${id}">${icon(itemIcon(item(id)))}${escape(item(id).title)}</button>`).join("")}</div>` : ""}${job.edit?.lines.length ? `<div class="editResult"><small>Pi Web / docs/release-checklist.md · ${job.edit.state === "applied" ? "Draft updated" : "Proposed addition"}</small><pre>${escape(job.edit.lines.join("\n"))}</pre>${job.edit.state === "proposed" ? `<button class="button accent" data-apply-edit="${job.id}" ${conflicts.has(docKey(item("pi-release-doc"))) ? "disabled" : ""}>Add to my current draft</button>` : ""}</div>` : ""}${job.calls?.length ? `<details class="toolCalls"><summary>${job.calls.length} steps</summary>${job.calls.map((call) => `<span>${icon("CircleCheck")}${escape(call.name)}</span>`).join("")}</details>` : ""}${viewReceipt(job.id).applied && !viewReceipt(job.id).restored ? `<button class="restoreView" data-restore-view="${job.id}">Restore my previous view</button>` : ""}`}</article>`).join("") || `<div class="chatWelcome"><p>What would you like to do?</p><span>Pi can open files and apps, compare them, or help edit your draft.</span><div>${suggestions.map((prompt,index) => `<button data-suggestion="${index}">${index ? "Update the checklist" : "Check the launch"}${icon("ArrowUpRight")}</button>`).join("")}</div></div>`}</div><form class="composer" data-agent-form><details class="chatContext"><summary>${icon("Paperclip")}Context · ${escape(scopeName(state.readWorkspaceIds))}</summary><label>Run in<select name="executionWorkspace">${scope(current).map((id) => `<option value="${id}" ${state.executionWorkspaceId === id ? "selected" : ""}>${escape(ws(id).name)}</option>`).join("")}</select></label><fieldset><legend>Use files and planner items from</legend>${scope(current).map((id) => `<label><input type="checkbox" name="readWorkspace" value="${id}" ${state.readWorkspaceIds.includes(id) ? "checked" : ""}>${escape(ws(id).name)}</label>`).join("")}</fieldset></details><textarea name="request" data-prompt aria-label="Message Pi" placeholder="Ask Pi to open, compare or edit…">${escape(state.prompt)}</textarea><footer><span>Pi · sample agent</span>${running ? `<button class="stopButton button quiet" type="button" data-stop-agent>${icon("Square")}Stop</button>` : ""}<button class="sendButton" data-send aria-label="Send message to Pi" ${running || !state.readWorkspaceIds.length ? "disabled" : ""}>${icon("ArrowUp")}</button></footer></form></section>`;
  }
  function renderLauncher() {
    return `<div class="actionLauncher ${launcherOpen ? "open" : ""}"><div class="actionLauncherMenu">${current ? `<button class="actionLauncherItem" style="--fan-y:-160px" data-picker data-category="browser">${icon("Globe")}Browser</button><button class="actionLauncherItem" style="--fan-y:-110px" data-picker data-category="apps">${icon("Grid2X2")}Apps</button><button class="actionLauncherItem" style="--fan-y:-60px" data-picker data-category="files">${icon("Folder")}Files</button><button class="actionLauncherItem" style="--fan-y:-10px" data-open-chat>${icon("MessageCircle")}Ask Pi</button>` : `<button class="actionLauncherItem" style="--fan-y:-10px" data-toggle-work>${icon("PanelLeft")}Find work</button>`}</div><button class="actionLauncherToggle" data-launcher aria-label="Open workspace actions" aria-expanded="${launcherOpen}"><img src="mascot.png" width="56" height="56" alt=""></button></div>`;
  }
  function render(preserveFocus = true) {
    if (composing) return;
    captureEditors(); const active = document.activeElement;
    const focus = preserveFocus && active?.matches("textarea") ? { selector: active.hasAttribute("data-prompt") ? "[data-prompt]" : `[data-document="${active.dataset.document}"]`, from: active.selectionStart, to: active.selectionEnd, scroll: active.scrollTop } : null;
    const ready = jobs().filter((job) => !job.seen && job.status !== "running").length, running = jobs().filter((job) => job.status === "running").length;
    const value = current ? scene(current) : null, latest = current ? jobFor(current) : null;
    const pending = latest?.commands && latest.commands.open.length + latest.commands.close.length + latest.commands.pin.length > 0 && !viewReceipt(latest.id).applied && !viewReceipt(latest.id).restored;
    $("app").innerHTML = `<div class="shell ${drawerOpen ? "withDrawer" : ""} ${chatOpen ? "withChat" : ""}">${renderDrawer()}<header class="topbar"><button class="workToggle button quiet" data-toggle-work aria-expanded="${!mobile() && drawerOpen}">${icon("PanelLeft")}Work</button><button class="brand" data-home aria-label="Pi Web home">π</button><div class="currentWork"><strong>${current ? escape(act(current).name) : "pi web"}</strong><small>${current ? escape(scopeName(scope(current))) : "Your files, apps and projects"}</small></div><div class="topActions">${current ? `<button class="button quiet" data-picker>${icon("Plus")}Open</button><button class="button quiet splitButton" data-split>${icon("Columns2")}${value.beside ? "Single view" : "Split"}</button><button class="button quiet" data-open-chat>${icon("MessageCircle")}Ask Pi</button>` : ""}<button class="button quiet updatesButton" data-updates>${icon("Bell")}<span>${ready ? ready + " ready" : running ? running + " running" : "Updates"}</span></button></div></header><main class="stage">${current ? `<div class="viewNotice ${pending ? "pending" : ""}"><span>${pending ? "Pi has files and apps ready for this work." : value.beside ? "Two views of this work. Switch files and apps in the tabs below." : "Open files, apps or a browser. Keep Pi close when you need help."}</span>${pending ? `<button data-show-job="${latest.id}">Show</button>` : ""}</div><div class="viewGrid ${value.beside ? "split" : ""}">${value.active ? renderView(value.active) : '<div class="emptyStage"><h2>What would you like to open?</h2><button class="button" data-picker>Files, apps or a browser</button></div>'}${value.beside ? renderView(value.beside, true) : ""}</div>` : `<div class="home"><div class="piMark">π</div><h1>What are you working on?</h1><p>Choose a task from Work.<br>Open its files, apps and browser pages in the tabs below.</p>${routeProblem ? `<p class="routeProblem">${escape(routeProblem)}</p>` : ""}<button class="button accent" data-work="coordinate-release">Continue the release check${icon("ArrowUpRight")}</button><p class="homeNote">Pi is available as a floating chat whenever you need a hand.</p></div>`}</main>${renderTabs()}<footer class="prototypeFoot"><span>Interactive demo · sample files, app connection and agent</span><button data-reset>Reset demo</button></footer>${renderChat()}${renderLauncher()}</div>`;
    bind(); restoring = true;
    document.querySelectorAll("textarea[data-document]").forEach((editor) => { const position = scene(editor.dataset.work).positions[editor.dataset.document]; if (position) { editor.setSelectionRange(position.from,position.to); editor.scrollTop=position.scroll; } });
    if (focus) { const editor = document.querySelector(focus.selector); if (editor) { editor.focus({ preventScroll:true }); editor.setSelectionRange(focus.from,focus.to); editor.scrollTop=focus.scroll; } }
    const messages = document.querySelector(".chatMessages"); if (messages) messages.scrollTop=messages.scrollHeight;
    restoring = false;
  }
  function closeLauncher() { launcherOpen = false; document.querySelector(".actionLauncher")?.classList.remove("open"); document.querySelector("[data-launcher]")?.setAttribute("aria-expanded","false"); }
  function openChat() {
    if (!current) return; captureEditors(); chatOpen=true; closeOverlay(); closeLauncher();
    for (const job of jobs().filter((job) => job.workId===current && job.status!=="running" && !job.seen)) updateJob(job.id,{seen:true});
    writeRoute(true); render(false); document.querySelector("[data-prompt]")?.focus();
  }
  function toggleWork() {
    closeLauncher();
    if (mobile()) showOverlay("work", "Choose your work", `<label class="workSearch">${icon("Search")}<input data-work-search aria-label="Find work or a project" placeholder="Find work or a project"></label><div class="workList">${workRows()}</div>`);
    else { drawerOpen=!drawerOpen; put("drawer",drawerOpen); render(); }
  }
  function showPicker(category="files") {
    if (!current) return; closeLauncher();
    const files = Object.keys(resources).filter((id)=>item(id).type==="doc" || item(id).type==="diff");
    const apps = ["release-planner","pi-preview","trail-dashboard","trail-board","trail-data"];
    const rows = (ids) => ids.map((id)=>`<button class="pickerRow" data-open-item="${id}">${icon(itemIcon(item(id)))}<span><strong>${escape(item(id).title)}</strong><small>${escape(ownerLabel(item(id)))}</small></span>${icon("ArrowUpRight")}</button>`).join("");
    showOverlay("picker", "Open in " + act(current).name, `<div class="pickerTabs">${["files","apps","browser"].map((key)=>`<button class="button ${category===key?"selected":""}" data-picker-category="${key}">${key[0].toUpperCase()+key.slice(1)}</button>`).join("")}</div><div class="pickerContent">${category==="files"?rows(files):category==="apps"?rows(apps):`<button class="pickerRow" data-browser-open="pi-web">${icon("Globe")}<span><strong>Pi Web preview</strong><small>https://pi-web.example/preview</small></span></button><button class="pickerRow" data-browser-open="trail-notes">${icon("Globe")}<span><strong>Trail Notes preview</strong><small>https://trail-notes.example/preview</small></span></button>`}</div>`);
  }
  function showUpdates() {
    closeLauncher(); const values=jobs().filter((job)=>job.status==="running"||!job.seen);
    showOverlay("updates","Updates",values.map((job)=>`<article class="update"><small>${escape(act(job.workId).name)} · ${escape(scopeName(job.readWorkspaceIds))}</small><h2>${job.status==="running"?"Pi is working":"Pi has an answer"}</h2><p>${escape(job.status==="running"?job.request:job.reply)}</p>${job.status!=="running"?`<button class="button accent" data-visit-job="${job.id}">Open this work and answer</button>`:""}</article>`).join("")||'<p class="emptyList">No updates waiting.</p>');
  }
  function showOverlay(type,title,body) {
    captureEditors(); if (!overlay) overlayReturnFocus=document.activeElement;
    overlay={type}; $("overlay").innerHTML=`<div class="overlayShade"><section class="modal" role="dialog" aria-modal="true" aria-label="${escape(title)}"><header><h2>${escape(title)}</h2><button class="iconButton" data-close-overlay aria-label="Close ${escape(title)}">${icon("X")}</button></header>${body}</section></div>`;
    bind($("overlay")); $("overlay").querySelector("[data-close-overlay]").onclick=closeOverlay;
    $("overlay").querySelector(".overlayShade").onpointerdown=(event)=>{if(event.target.classList.contains("overlayShade"))closeOverlay();};
    $("overlay").querySelector("input,button").focus();
  }
  function closeOverlay() { overlay=null; $("overlay").innerHTML=""; if(overlayReturnFocus?.isConnected)overlayReturnFocus.focus({preventScroll:true});overlayReturnFocus=null; }
  function bind(root=$("app")) {
    const all=(selector,callback)=>root.querySelectorAll(selector).forEach((node)=>node.onclick=()=>{closeLauncher();callback(node);});
    all("button[data-work]",node=>navigate(node.dataset.work));
    all("[data-toggle-work]",toggleWork);
    all("[data-home]",()=>{captureEditors();current=null;chatOpen=false;routeProblem="";writeRoute();render(false);});
    all("[data-open-chat]",openChat);
    all("[data-stop-agent]",()=>{const job=jobFor(current);if(job?.status==="running")updateJob(job.id,{status:"stopped",seen:true,finished:Date.now(),reply:"Stopped. Your open files and drafts are kept."});render();});
    all("[data-close-chat]",()=>{captureEditors();chatOpen=false;writeRoute(true);render(false);});
    all("[data-picker]",node=>showPicker(node.dataset.category||"files"));
    all("[data-picker-category]",node=>showPicker(node.dataset.pickerCategory));
    all("[data-open-item]",node=>openItem(current,node.dataset.openItem));
    all("[data-close-item]",node=>{closeItem(current,node.dataset.closeItem);writeRoute();render(false);});
    all("[data-pin]",node=>{captureEditors();const value=scene(current);value.pinned=value.pinned.includes(node.dataset.pin)?value.pinned.filter(id=>id!==node.dataset.pin):[...value.pinned,node.dataset.pin];saveScene(current,value,true);render();});
    all("[data-only]",node=>{captureEditors();const value=scene(current);value.active=node.dataset.only;value.beside=null;saveScene(current,value,true);writeRoute();render(false);});
    all("[data-split]",()=>{captureEditors();const value=scene(current);if(value.beside)value.beside=null;else value.beside=value.open.find(id=>id!==value.active)||null;saveScene(current,value,true);writeRoute();render(false);if(!value.beside&&value.open.length<2)showPicker();});
    all("[data-save]",node=>saveDocument(node.dataset.save));
    all("[data-resolve]",node=>resolveConflict(node.dataset.resolve,node.dataset.mine==="true"));
    all("[data-range]",node=>{const value=scene(current);value.filters[node.dataset.item]=node.dataset.range;saveScene(current,value,true);render();});
    all("[data-board]",node=>{const value=scene(current);value.filters["board"+node.dataset.board]=!value.filters["board"+node.dataset.board];saveScene(current,value,true);render();});
    all("[data-browser-open]",node=>{attach(current,"browser");const value=scene(current);value.browserPage=node.dataset.browserOpen;saveScene(current,value);openItem(current,"browser");});
    all("[data-browser-page]",node=>{const value=scene(current);value.browserPage=node.dataset.browserPage;saveScene(current,value,true);render();});
    all("[data-updates]",showUpdates);
    all("[data-visit-job]",node=>{const job=jobs().find(job=>job.id===node.dataset.visitJob);if(!job)return;navigate(job.workId);if(job.commands)arrangeFromJob(job,true);openChat();writeRoute(true);render(false);});
    all("[data-show-job]",node=>{const job=jobs().find(job=>job.id===node.dataset.showJob);if(!job)return;captureEditors();arrangeFromJob(job,true);writeRoute();render(false);});
    all("[data-restore-view]",node=>restoreView(node.dataset.restoreView));
    all("[data-apply-edit]",node=>applyEdit(node.dataset.applyEdit));
    all("[data-suggestion]",node=>{const state=chatState(current);put("chat/"+current,{...state,prompt:suggestions[Number(node.dataset.suggestion)]});render(false);document.querySelector("[data-prompt]")?.focus();});
    all("[data-reset]",reset);
    root.querySelectorAll("[data-work-search]").forEach(input=>input.oninput=()=>{workSearch=input.value;root.querySelector(".workList").innerHTML=workRows(workSearch);root.querySelectorAll("button[data-work]").forEach(node=>node.onclick=()=>navigate(node.dataset.work));});
    root.querySelectorAll("textarea[data-document]").forEach(editor=>{
      editor.oninput=()=>documentInput(editor);editor.onblur=()=>{if(!restoring)captureEditors();};
      editor.oncompositionstart=()=>{composing=true;};editor.oncompositionend=()=>{composing=false;documentInput(editor);render();};
    });
    const form=root.querySelector("[data-agent-form]");
    if(form){
      form.onsubmit=event=>{event.preventDefault();submitPrompt(form.elements.request.value);};
      form.elements.request.oninput=()=>put("chat/"+current,{...chatState(current),prompt:form.elements.request.value});
      form.elements.request.oncompositionstart=()=>{composing=true;};form.elements.request.oncompositionend=()=>{composing=false;render();};
      form.onchange=()=>{const state=chatState(current),readWorkspaceIds=[...form.querySelectorAll('[name="readWorkspace"]:checked')].map(node=>node.value);put("chat/"+current,{...state,executionWorkspaceId:form.elements.executionWorkspace.value,readWorkspaceIds});form.querySelector("[data-send]").disabled=!readWorkspaceIds.length||jobFor(current)?.status==="running";};
    }
    const address=root.querySelector("[data-browser-address]");
    if(address)address.onsubmit=event=>{event.preventDefault();let target;try{target=new URL(address.elements.address.value);}catch{}if(!target||!["pi-web.example","trail-notes.example"].includes(target.hostname)){announce("This demo includes only the two sample preview pages.");return;}const value=scene(current);value.browserPage=target.hostname.startsWith("trail")?"trail-notes":"pi-web";saveScene(current,value,true);render();};
    const launcher=root.querySelector("[data-launcher]");
    if(launcher)launcher.onclick=()=>{launcherOpen=!launcherOpen;root.querySelector(".actionLauncher").classList.toggle("open",launcherOpen);launcher.setAttribute("aria-expanded",String(launcherOpen));};
  }
  function announce(text) { $("announcer").textContent=text;const notice=document.querySelector(".viewNotice span");if(notice)notice.textContent=text; }
  function reset() {
    runGeneration++; autoFinish = true;
    try{for(const key of Object.keys(localStorage))if(key.startsWith(PREFIX))localStorage.removeItem(key);}catch{}
    memory.clear();sceneCache.clear();conflicts.clear();knownVersions.clear();current=null;chatOpen=false;launcherOpen=false;workSearch="";routeProblem="";
    closeOverlay();$("app").innerHTML="";writeRoute(true);render(false);
  }
  window.addEventListener("popstate",()=>{captureEditors();readRoute();closeOverlay();render(false);});
  window.addEventListener("beforeunload",captureEditors);
  window.addEventListener("resize",()=>render());
  window.addEventListener("storage",event=>{
    if(!event.key?.startsWith(PREFIX))return;const key=event.key.slice(PREFIX.length);memory.delete(key);
    if(key.startsWith("document/")&&event.newValue){
      const active=document.activeElement;
      if(active?.matches("textarea[data-document]")&&docKey(item(active.dataset.document))===key){
        const incoming=JSON.parse(event.newValue),previous=event.oldValue?JSON.parse(event.oldValue):{saved:item(active.dataset.document).text};
        if(active.value!==incoming.draft&&active.value!==previous.saved){const local={saved:previous.saved,draft:active.value,version:knownVersions.get(key)||0};conflicts.set(key,{local,remote:incoming});put("recovery/"+tabId+"/"+key,local);}
      }
      render();
    }else if(key==="planner")notifyPlannerFrames();
    else if(key==="jobs"||key.startsWith("references/")){render();if(overlay?.type==="updates")showUpdates();}
    // Other windows cannot select this window's work or views.
  });
  document.addEventListener("keydown",event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();if(overlay)closeOverlay();else if(mobile())toggleWork();else{drawerOpen=true;render();document.querySelector("[data-work-search]")?.focus();}}
    if(event.key==="Escape"){if(overlay)closeOverlay();else if(launcherOpen)closeLauncher();else if(chatOpen){chatOpen=false;writeRoute(true);render(false);}}
    if(event.key==="Tab"&&overlay){const nodes=[...$("overlay").querySelectorAll("button:not(:disabled),input,select,textarea")],first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  });
  setInterval(()=>{if(autoFinish)for(const job of jobs())if(job.status==="running"&&job.tabId===tabId&&Date.now()>=job.due)void finishJob(job.id);},200);
  window.piWebDemo=Object.freeze({snapshot:()=>({current,chatOpen,drawerOpen,jobs:jobs(),work:activities.map(work=>({...work,workspaceIds:scope(work.id)})),scenes:activities.map(work=>({id:work.id,view:scene(work.id)})),planner:launchItems()}),finishJob,setAutoFinish:(enabled)=>{autoFinish=Boolean(enabled);},reset});
  drawerOpen=get("drawer",true);readRoute();render(false);
})();
