/* A browser-only interface probe. Workspaces, resources and jobs are sample data. */
(() => {
  "use strict";
  const PREFIX = "pi-web.multitasking-probe.v2/";
  const tabId = crypto.randomUUID();
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
  // A resource belongs to its workspace. Activities only reference it.
  const resources = {
    "pi-nav": { workspaceId: "pi-web", path: "docs/workspace-shell.md", type: "doc", title: "Workspace navigation", text: "The workspace is the primary context.\n\nFiles, Git, documents and apps are peer surfaces.\nChat is available when needed.\n\nDesktop\n- Keep the current resource steady.\n- Show related resources alongside it.\n- Name the workspace and activity on every context.\n\nMobile\n- One primary resource at a time.\n- Keep switching within thumb reach.\n- Returning restores the resource and draft.\n\nReview\n- Check tap targets at 44px.\n- Check navigation with Chat closed.\n" },
    "pi-preview": { workspaceId: "pi-web", path: "examples/workspace-shell.html", type: "shell-app", title: "Running workspace shell" },
    "pi-release-doc": { workspaceId: "pi-web", path: "docs/release-checklist.md", type: "doc", title: "Release checklist", text: "Before the next prototype release\n\n[ ] Review workspace navigation\n[ ] Verify mobile resource switching\n[ ] Check packaged shared modules\n[ ] Review architectural notes\n\nRelease notes\n\n" },
    "pi-diff": { workspaceId: "pi-web", path: "src/workspace/shell.css", type: "diff", title: "Working changes" },
    "pi-readme": { workspaceId: "pi-web", path: "README.md", type: "doc", title: "Pi Web README", text: "Pi Web\n\nA browser workspace for resources, apps and agents.\nThis README belongs to the Pi Web workspace.\n" },
    "trail-dashboard": { workspaceId: "trail-notes", path: "apps/usage-dashboard.html", type: "dashboard", title: "Usage dashboard" },
    "trail-analysis": { workspaceId: "trail-notes", path: "notes/analysis.md", type: "doc", title: "Analysis notes", text: "Questions for this week's route data\n\n- Which routes are getting repeat visits?\n- Does weekend usage differ from weekdays?\n\nObservations\n\n" },
    "trail-data": { workspaceId: "trail-notes", path: "data/usage.csv", type: "table", title: "Route data" },
    "trail-roadmap-doc": { workspaceId: "trail-notes", path: "docs/roadmap.md", type: "doc", title: "Next release", text: "Trail Notes — next release\n\nNow\n- Understand repeat route visits\n- Simplify saving a route\n\nNext\n- Share a weekend collection\n- Add a compact map view\n\nDecisions\n\n" },
    "trail-board": { workspaceId: "trail-notes", path: "apps/planning-board.html", type: "board", title: "Planning board" },
    "trail-readme": { workspaceId: "trail-notes", path: "README.md", type: "doc", title: "Trail Notes README", text: "Trail Notes\n\nRoutes, observations and ideas for the next weekend.\nThis README belongs to the Trail Notes workspace.\n" },
  };
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Lucide nodes from Pi Web's existing icon dependency (MIT).
  const iconNodes = {"Layers":[["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]],"PanelsTopLeft":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M9 21V9"}]],"PanelRight":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}]],"Maximize2":[["path",{"d":"M15 3h6v6"}],["path",{"d":"m21 3-7 7"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M9 21H3v-6"}]],"Minimize2":[["path",{"d":"m14 10 7-7"}],["path",{"d":"M20 10h-6V4"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M4 14h6v6"}]],"Folder":[["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],"FileText":[["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]],"GitBranch":[["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],"MessageCircle":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"ArrowLeftRight":[["path",{"d":"M8 3 4 7l4 4"}],["path",{"d":"M4 7h16"}],["path",{"d":"m16 21 4-4-4-4"}],["path",{"d":"M20 17H4"}]],"ArrowUpRight":[["path",{"d":"M7 7h10v10"}],["path",{"d":"M7 17 17 7"}]],"X":[["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],"Search":[["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],"Plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"Bell":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]],"Grid2X2":[["path",{"d":"M12 3v18"}],["path",{"d":"M3 12h18"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}]],"Link":[["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],"CircleCheck":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],"ChevronDown":[["path",{"d":"m6 9 6 6 6-6"}]]};
  const icon = (name) => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconNodes[name] || iconNodes.FileText).map(([tag, attributes]) => '<' + tag + ' ' + Object.entries(attributes).map(([key, value]) => key + '=\"' + escape(value) + '\"').join(' ') + '/>').join('') + '</svg>';
  const memory = new Map();
  const conflicts = new Map();
  const knownVersions = new Map();
  const sceneCache = new Map();
  const lastCache = new Map();
  let primary = null;
  let companion = null;
  let focused = null;
  let workspaceLens = null;
  let viewMode = "expanded";
  let docked = null;
  let compact = [];
  let launcherOpen = false;
  let overlay = null;
  let restoring = false;
  let composing = false;
  let routeProblem = "";
  const mobile = () => matchMedia("(max-width: 1024px)").matches;
  const ws = (id) => workspaces.find((item) => item.id === id);
  const act = (id) => activities.find((item) => item.id === id);
  const get = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? "null") ?? fallback; }
    catch { return memory.get(key) ?? fallback; }
  };
  const put = (key, value) => {
    memory.set(key, value);
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Private/storage-disabled browsing remains usable. */ }
  };
  function workspaceIdsFor(activityId) {
    const activity = act(activityId);
    if (!activity) return [];
    // Inferring additional membership only from ordinary workspace resources
    // prevents report/session resolution from recursing through this function.
    const attached = get("references/" + activityId, []).map((id) => resources[id]?.workspaceId);
    return [...new Set([...activity.workspaceIds, ...attached])].filter((id) => ws(id));
  }
  const workspaceNames = (ids) => ids.map((id) => ws(id)?.name).filter(Boolean).join(" + ");
  const activityScope = (id) => workspaceNames(workspaceIdsFor(id));
  function allowedResource(activityId, item) {
    if (!item || !act(activityId)) return false;
    if (item.type === "chat") return item.activityId === activityId;
    if (item.type === "report") return item.job.activityId === activityId;
    return workspaceIdsFor(activityId).includes(item.workspaceId);
  }
  const docKey = (resource) => "document/" + JSON.stringify([resource.workspaceId, resource.path]);
  function readDoc(resource) {
    const key = docKey(resource);
    if (conflicts.has(key)) return conflicts.get(key).local;
    const value = get(key, { saved: resource.text, draft: resource.text, version: 0 });
    return typeof value.draft === "string" && typeof value.saved === "string" && Number.isSafeInteger(value.version)
      ? value : { saved: resource.text, draft: resource.text, version: 0 };
  }
  function jobs() {
    return get("jobs", []).filter((job) => act(job.activityId) && ws(job.executionWorkspaceId)
      && Array.isArray(job.workspaceIds) && job.workspaceIds.every((id) => ws(id))
      && ["running", "ready", "reviewed"].includes(job.status));
  }
  const jobFor = (activityId) => jobs().findLast((job) => job.activityId === activityId);
  function resource(id) {
    if (resources[id]) return { id, ...resources[id] };
    if (id?.startsWith("chat:")) {
      const owner = act(id.slice(5));
      if (owner) return { id, workspaceId: null, type: "chat", path: "Agent session", activityId: owner.id, title: "Optional agent session" };
    }
    if (id?.startsWith("report:")) {
      const job = jobs().find((item) => item.id === id.slice(7));
      if (job && job.status !== "running") return { id, workspaceId: job.executionWorkspaceId, type: "report", path: ".pi/reports/" + job.activityId + ".md", title: "Review report", job };
    }
    return null;
  }
  function available(activityId) {
    const activity = act(activityId);
    const ids = [...activity.initial, ...get("references/" + activityId, [])];
    if (get("session/" + activityId, null)) ids.push("chat:" + activityId);
    const job = jobFor(activityId);
    if (job && job.status !== "running") ids.push("report:" + job.id);
    return [...new Set(ids)].filter((id) => allowedResource(activityId, resource(id)));
  }
  function scene(activityId) {
    const activity = act(activityId);
    const value = sceneCache.get(activityId) ?? get("scene/" + activityId, { open: activity.initial, active: activity.initial[0], positions: {}, filters: {}, appTab: "Files" });
    const valid = available(activityId);
    const open = (Array.isArray(value.open) ? value.open : activity.initial).filter((id) => valid.includes(id));
    const result = { ...value, open, active: open.includes(value.active) ? value.active : open[0], positions: value.positions ?? {}, filters: value.filters ?? {} };
    sceneCache.set(activityId, result);
    return result;
  }
  const saveScene = (activityId, value) => { sceneCache.set(activityId, value); put("scene/" + activityId, value); };
  function resumeActivity(workspaceId) {
    const candidate = lastCache.get(workspaceId) ?? get("last/" + workspaceId, null);
    return workspaceIdsFor(candidate).includes(workspaceId) ? candidate : activities.find((item) => item.workspaceIds.length === 1 && workspaceIdsFor(item.id).includes(workspaceId)).id;
  }
  function status(activityId) {
    const job = jobFor(activityId);
    if (job?.status === "running") return { label: "Agent reviewing in background", kind: "running" };
    if (job?.status === "ready") return { label: "Review ready", kind: "ready" };
    if (available(activityId).some((id) => resource(id)?.type === "doc" && readDoc(resource(id)).draft !== readDoc(resource(id)).saved)) return { label: "Draft kept", kind: "draft" };
    return { label: "Ready to resume", kind: "idle" };
  }
  function activityStatus(activityId) {
    const item = status(activityId);
    return `<span class="activityStatus"><i class="statusDot ${item.kind}"></i>${item.label}</span>`;
  }
  const mini = () => '<span class="miniScene" aria-hidden="true"><i></i><i></i></span>';
  function captureEditors() {
    document.querySelectorAll("textarea[data-resource]").forEach((editor) => {
      const activityId = editor.dataset.activity;
      const value = scene(activityId);
      value.positions[editor.dataset.resource] = { from: editor.selectionStart, to: editor.selectionEnd, scroll: editor.scrollTop };
      saveScene(activityId, value);
    });
  }
  function writeRoute(replace = false) {
    const url = new URL(location.href);
    for (const key of ["workspace", "activity", "beside", "view", "resource", "card"]) url.searchParams.delete(key);
    if (primary) {
      if (workspaceLens) url.searchParams.set("workspace", workspaceLens);
      url.searchParams.set("activity", primary);
      if (companion) url.searchParams.set("beside", companion);
      if (viewMode === "resource") {
        url.searchParams.set("view", "resource");
        if (scene(primary).active) url.searchParams.set("resource", scene(primary).active);
      }
      if (docked) url.searchParams.set("card", docked);
    }
    history[replace ? "replaceState" : "pushState"]({}, "", url);
  }
  function readRoute() {
    const params = new URL(location.href).searchParams;
    const workspaceId = params.get("workspace");
    const activityId = params.get("activity");
    routeProblem = "";
    primary = null;
    companion = null;
    docked = act(params.get("card"))?.id || null;
    viewMode = params.get("view") === "resource" ? "resource" : "expanded";
    workspaceLens = ws(workspaceId)?.id || null;
    if (workspaceId && !ws(workspaceId)) routeProblem = "This workspace is unavailable in the prototype.";
    else if (activityId && !act(activityId)) routeProblem = "This activity is unavailable in the prototype.";
    else if (activityId && workspaceId && !workspaceIdsFor(activityId).includes(workspaceId)) routeProblem = "This activity does not include the selected workspace.";
    else primary = activityId || (workspaceId ? resumeActivity(workspaceId) : null);
    if (primary && params.get("resource")) {
      const id = params.get("resource");
      if (!available(primary).includes(id)) { primary = null; routeProblem = "This resource is not attached to the selected activity."; }
      else {
        const value = scene(primary);
        if (!value.open.includes(id)) value.open = [...value.open, id].slice(-3);
        value.active = id;
        saveScene(primary, value);
      }
    }
    const beside = params.get("beside");
    if (primary && act(beside) && beside !== primary) companion = beside;
    focused = primary;
    compact = get("compact", []).filter((id) => act(id));
  }
  function navigate(activityId, asCompanion = false) {
    if (!act(activityId)) return;
    captureEditors();
    if (asCompanion && primary && activityId !== primary && !mobile()) companion = activityId;
    else {
      primary = activityId;
      if (companion === primary) companion = null;
      focused = primary;
      viewMode = "expanded";
      docked = null;
      const ids = workspaceIdsFor(primary);
      workspaceLens = ids.length === 1 ? ids[0] : null;
      for (const id of ids) { lastCache.set(id, primary); put("last/" + id, primary); }
    }
    routeProblem = "";
    writeRoute();
    closeOverlay();
    render(false);
  }
  function openResource(activityId, id) {
    const item = resource(id);
    if (!item || !act(activityId) || (item.type === "chat" && item.activityId !== activityId)
      || (item.type === "report" && item.job.activityId !== activityId)) throw new Error("This resource cannot be attached to the activity");
    captureEditors();
    const refs = get("references/" + activityId, []);
    if (!refs.includes(id)) put("references/" + activityId, [...refs, id]);
    const value = scene(activityId);
    if (!value.open.includes(id)) value.open = [...value.open, id].slice(-3);
    value.active = id;
    saveScene(activityId, value);
    if (primary === activityId && workspaceLens && !workspaceIdsFor(activityId).includes(workspaceLens)) workspaceLens = null;
    writeRoute(true);
    render(false);
  }
  function closeResource(activityId, id) {
    captureEditors();
    const value = scene(activityId);
    value.open = value.open.filter((other) => other !== id);
    if (value.active === id) value.active = value.open[0];
    saveScene(activityId, value);
    writeRoute(true);
    render(false);
  }
  function focusResource(activityId, id) {
    if (!available(activityId).includes(id)) return;
    captureEditors();
    const inspected = docked;
    if (primary !== activityId) navigate(activityId);
    if (inspected === activityId && !mobile()) docked = inspected;
    const value = scene(activityId);
    if (!value.open.includes(id)) value.open = [...value.open, id].slice(-3);
    value.active = id;
    saveScene(activityId, value);
    viewMode = "resource";
    focused = activityId;
    compact = [...new Set([...compact, activityId])];
    put("compact", compact);
    writeRoute();
    closeOverlay();
    render(false);
  }
  function showActivityCard(activityId) {
    if (!act(activityId)) return;
    captureEditors();
    if (mobile()) {
      overlayReturnFocus = document.activeElement;
      overlay = { type: "activity", activityId };
      $("overlay").innerHTML = `<div class="overlayShade"><section class="activitySheet" role="dialog" aria-modal="true" aria-label="${escape(act(activityId).name)} activity">${renderActivityCard(activityId, true)}</section></div>`;
      bindActivityCards($("overlay"));
      bindOverlayClose();
      $("overlay").querySelector("button").focus();
    } else {
      docked = activityId;
      if (primary) viewMode = "resource";
      writeRoute();
      closeOverlay();
      render(true);
    }
  }
  function keepCompact(activityId) {
    if (!act(activityId)) return;
    captureEditors();
    compact = [...new Set([...compact, activityId])];
    put("compact", compact);
    docked = null;
    writeRoute();
    closeOverlay();
    render(true);
  }
  function openChat(activityId) {
    if (!get("session/" + activityId, null)) put("session/" + activityId, { prompt: "", created: Date.now() });
    openResource(activityId, "chat:" + activityId);
  }
  function startReview(activityId, request, executionWorkspaceId, contextWorkspaceIds) {
    const current = jobFor(activityId);
    if (current?.status === "running") return;
    const activity = act(activityId);
    const members = workspaceIdsFor(activityId);
    if (!members.includes(executionWorkspaceId) || !contextWorkspaceIds.length || contextWorkspaceIds.some((id) => !members.includes(id))) return;
    const job = { id: crypto.randomUUID(), executionWorkspaceId,
      workspaceIds: [...contextWorkspaceIds], activityId, request,
      // Capture ownership and submitted content when the request is made.
      resources: available(activityId).map(resource).filter((item) => item.type !== "chat" && item.type !== "report" && contextWorkspaceIds.includes(item.workspaceId)).map((item) => ({ workspaceId: item.workspaceId, path: item.path, type: item.type, ...(item.type === "doc" ? { snapshot: readDoc(item).draft } : {}) })),
      status: "running", started: Date.now(), due: Date.now() + 45_000 };
    put("jobs", [...jobs(), job]);
    const session = get("session/" + activityId, {});
    put("session/" + activityId, { ...session, prompt: request, request, executionWorkspaceId, contextWorkspaceIds });
    render(true);
  }
  function finishJob(id) {
    const next = jobs();
    const item = next.find((job) => job.id === id);
    if (!item || item.status !== "running") return;
    item.status = "ready";
    item.finished = Date.now();
    put("jobs", next);
    // Completion updates availability/status, never navigation or visible resources.
    render(true);
    refreshActivitySheet();
    $("announcer").textContent = `${act(item.activityId).name}, ${workspaceNames(item.workspaceIds)}: review ready.`;
  }
  function reviewReport(activityId) {
    const job = jobFor(activityId);
    if (!job || job.status === "running") return;
    const next = jobs();
    next.find((item) => item.id === job.id).status = "reviewed";
    put("jobs", next);
    openResource(activityId, "report:" + job.id);
  }
  function saveDocument(id, editor) {
    const item = resource(id);
    const key = docKey(item);
    const latest = get(key, readDoc(item));
    if (conflicts.has(key)) return;
    const value = { saved: editor.value, draft: editor.value, version: latest.version + 1 };
    put(key, value);
    knownVersions.set(key, value.version);
    render(true);
  }
  function documentInput(editor) {
    const item = resource(editor.dataset.resource);
    const key = docKey(item);
    const latest = get(key, { saved: item.text, draft: item.text, version: 0 });
    if (conflicts.has(key)) {
      const conflict = conflicts.get(key);
      conflict.local.draft = editor.value;
      put("recovery/" + tabId + "/" + key, conflict.local);
    } else {
      const value = { ...latest, draft: editor.value, version: latest.version + 1 };
      put(key, value);
      knownVersions.set(key, value.version);
      document.querySelectorAll(`textarea[data-resource="${item.id}"]`).forEach((other) => {
        if (other !== editor) {
          const from = other.selectionStart, to = other.selectionEnd;
          other.value = editor.value;
          other.setSelectionRange(from, to);
        }
      });
    }
    const positions = scene(editor.dataset.activity);
    positions.positions[item.id] = { from: editor.selectionStart, to: editor.selectionEnd, scroll: editor.scrollTop };
    saveScene(editor.dataset.activity, positions);
    document.querySelectorAll(`[data-draft="${item.id}"]`).forEach((node) => node.textContent = editor.value === latest.saved ? "Saved" : "Draft kept");
  }
  function resolveConflict(id, keepMine) {
    const item = resource(id), key = docKey(item), conflict = conflicts.get(key);
    if (!conflict) return;
    const latest = get(key, conflict.remote);
    if (keepMine) put(key, { ...conflict.local, version: latest.version + 1 });
    conflicts.delete(key);
    try { localStorage.removeItem(PREFIX + "recovery/" + tabId + "/" + key); } catch { /* No persistent storage. */ }
    render(true);
  }
  function workspaceBadges(ids) {
    return `<span class="workspaceBadges">${ids.map((id) => `<span class="workspaceBadge" data-owner-workspace="${id}">${icon("Folder")}${escape(ws(id).name)}</span>`).join("")}</span>`;
  }
  function overviewRow(activity) {
    return `<div class="workRow">${mini()}<div class="workDescription"><strong>${escape(activity.name)}</strong><small>${escape(activity.summary)}</small>${activityStatus(activity.id)}</div><button class="iconButton" data-card="${activity.id}" aria-label="Inspect ${escape(activity.name)}">${icon("PanelRight")}</button><button class="button" data-open-activity="${activity.id}">Resume</button></div>`;
  }
  function renderOverview() {
    const shared = activities.filter((activity) => workspaceIdsFor(activity.id).length > 1);
    return `<section class="overview"><div class="label">pi web / your work</div><h1>Pick up where you left off.</h1><p>Activities bring related work together, across any of your workspaces.</p>
      ${routeProblem ? `<div class="overviewTip">${escape(routeProblem)}</div>` : ""}
      <section class="sharedWork"><header><span>${icon("Link")}Across workspaces</span><small>One activity, several projects</small></header>${shared.map(overviewRow).join("")}</section>
      <div class="workspaceCards">${workspaces.map((workspace) => `<section class="workspaceCard"><h2>${icon("Folder")}${escape(workspace.name)}<small>${jobs().filter((job) => job.workspaceIds.includes(workspace.id) && job.status === "running").length} running</small></h2><p>${escape(workspace.label)}</p>${activities.filter((activity) => workspaceIdsFor(activity.id).length === 1 && workspaceIdsFor(activity.id).includes(workspace.id)).map(overviewRow).join("")}</section>`).join("")}</div>
      <div class="overviewTip">${icon("Layers")}<span>An activity keeps its resources and optional agents together. Open a resource, inspect its activity beside it, or keep the activity as a compact card.</span></div></section>`;
  }
  function renderActivityCard(activityId, sheet = false) {
    const activity = act(activityId), job = jobFor(activityId);
    return `<section class="activityCard" data-card-activity="${activityId}"><header><span>${icon("Layers")}Activity</span><button class="iconButton" ${sheet ? "data-close-overlay" : "data-dock-close"} aria-label="Close activity card">${icon("X")}</button></header><div class="cardBody"><h2>${escape(activity.name)}</h2><p>${escape(activity.summary)}</p>${workspaceBadges(workspaceIdsFor(activityId))}${activityStatus(activityId)}<div class="cardLabel">Resources</div><div class="cardResources">${available(activityId).filter((id) => resource(id).type !== "chat").map((id) => {
      const item = resource(id);
      return `<button data-card-resource="${id}" data-activity="${activityId}">${icon(item.type === "report" ? "CircleCheck" : "FileText")}<span><strong>${escape(item.title)}</strong><small>${escape(ws(item.workspaceId)?.name || "Activity")} · ${escape(item.path)}</small></span></button>`;
    }).join("")}</div>${job ? `<div class="cardJob"><i class="statusDot ${status(activityId).kind}"></i><span>${job.status === "running" ? "Review running" : "Review complete"}<small>Runs in ${escape(ws(job.executionWorkspaceId).name)}<br>Context: ${escape(workspaceNames(job.workspaceIds))}</small></span></div>` : ""}</div><footer><button class="button" data-expanded-activity="${activityId}">${icon("Maximize2")}Show related resources</button><button class="button quiet" data-compact="${activityId}">${icon("Minimize2")}Keep compact</button><button class="button quiet" data-card-chat="${activityId}">${icon("MessageCircle")}Ask agent</button></footer></section>`;
  }
  function bindActivityCards(root) {
    root.querySelectorAll("[data-card-resource]").forEach((node) => node.onclick = () => { closeOverlay(); focusResource(node.dataset.activity, node.dataset.cardResource); });
    root.querySelectorAll("[data-compact]").forEach((node) => node.onclick = () => keepCompact(node.dataset.compact));
    root.querySelectorAll("[data-expanded-activity]").forEach((node) => node.onclick = () => {
      captureEditors();
      if (primary !== node.dataset.expandedActivity) navigate(node.dataset.expandedActivity);
      viewMode = "expanded"; docked = null; closeOverlay(); writeRoute(); render(false);
    });
    root.querySelectorAll("[data-dock-close]").forEach((node) => node.onclick = () => keepCompact(docked));
    root.querySelectorAll("[data-card-chat]").forEach((node) => node.onclick = () => {
      const owner = node.dataset.cardChat;
      closeOverlay(); if (primary !== owner) navigate(owner); openChat(owner);
    });
  }
  function renderDoc(item, activityId) {
    const value = readDoc(item), key = docKey(item);
    if (!conflicts.has(key)) knownVersions.set(key, value.version);
    return `<div class="editor">${conflicts.has(key) ? `<div class="conflict">Changed in another tab. Your draft is kept.<br><button class="button" data-resolve="${item.id}" data-keep="true">Keep this draft</button><button class="button" data-resolve="${item.id}" data-keep="false">Use other draft</button></div>` : ""}<div class="docTitle">${item.title}</div><textarea aria-label="${escape(item.path)} in ${escape(ws(item.workspaceId).name)}" spellcheck="false" data-resource="${item.id}" data-activity="${activityId}">${escape(value.draft)}</textarea><div class="editorFooter"><span>Document · ${ws(item.workspaceId).name}</span><button class="button" data-save="${item.id}" data-activity="${activityId}" ${conflicts.has(key) ? "disabled" : ""}>Save</button></div></div>`;
  }
  function renderBody(item, activityId) {
    const view = scene(activityId);
    switch (item.type) {
      case "doc": return renderDoc(item, activityId);
      case "shell-app": return `<div class="appPreview"><div class="eyebrow">Generated app · Workspace shell</div><h2>A place for the work.</h2><p>Resources and apps are available before you open an agent session.</p><div class="sampleNav">${["Files", "Git", "Apps"].map((label) => `<button data-sample-tab="${label}" data-activity="${activityId}" class="${view.appTab === label ? "active" : ""}">${label}</button>`).join("")}</div><div class="sampleCard"><strong>${escape(view.appTab || "Files")}</strong><ul><li>Workspace resources</li><li>Clear context and ownership</li><li>Optional agent assistance</li></ul></div><div class="boundary">Saved HTML app · sample interactive preview</div></div>`;
      case "diff": return '<div class="diff">src/workspace/shell.css\n\n<span class="removed">- padding: 44px 0 0;</span><span class="added">+ padding: 16px 24px;</span><span class="added">+ min-width: 0;</span>\nKeep resource views inside their\nworkspace and activity context.\n\nWorking tree · 2 additions, 1 deletion</div>';
      case "dashboard": {
        const range = view.filters[item.id] || "30";
        const data = range === "7" ? [34, 52, 69, 47, 81, 93, 74] : [49, 58, 46, 72, 63, 85, 78];
        return `<div class="dashboard"><div class="eyebrow">Trail Notes · Usage</div><h2>Routes people return to.</h2><div class="range">${["7", "30"].map((period) => `<button data-range="${period}" data-resource="${item.id}" data-activity="${activityId}" class="${range === period ? "selected" : ""}">Last ${period} days</button>`).join("")}</div><div class="metrics"><div class="metric"><b>${range === "7" ? "428" : "1,840"}</b><span>Route visits</span></div><div class="metric"><b>${range === "7" ? "38%" : "31%"}</b><span>Returning visitors</span></div></div><div class="chart">${data.map((height) => `<i style="--bar:${height}%"></i>`).join("")}</div><div class="chartLabel"><span>Earlier</span><span>Most recent</span></div><p style="color:#88a7c8;font-size:11px;line-height:1.8;margin-top:25px">Weekends bring more returning visitors. Keep notes alongside the dashboard.</p></div>`;
      }
      case "table": return '<div class="dataTable"><p>data/usage.csv · Trail Notes workspace</p><table><thead><tr><th>Route</th><th>Visits</th><th>Repeat</th></tr></thead><tbody><tr><td>Ridge loop</td><td>182</td><td>42%</td></tr><tr><td>River path</td><td>146</td><td>36%</td></tr><tr><td>Forest trail</td><td>100</td><td>31%</td></tr></tbody></table><p>Shared data resource; this view belongs to the current activity.</p></div>';
      case "board": return `<div class="appPreview"><div class="eyebrow">Planning board</div><h2>Next up.</h2>${["Simplify saving a route", "Share a weekend collection", "Add a compact map"].map((label, index) => `<div class="sampleCard"><strong>${label}</strong><button class="button" data-board="${index}" data-activity="${activityId}">${view.filters["board" + index] ? "✓ Selected for this release" : "Add to this release"}</button></div>`).join("")}</div>`;
      case "chat": {
        const session = get("session/" + activityId, {}), job = jobFor(activityId), owner = act(activityId);
        const members = workspaceIdsFor(activityId);
        const target = members.includes(session.executionWorkspaceId) ? session.executionWorkspaceId : members[0];
        const selected = session.contextWorkspaceIds || members;
        const context = available(activityId).map(resource).filter((source) => !["chat", "report"].includes(source.type));
        return `<div class="chatBody"><div class="chatContext">${icon("Layers")}${escape(owner.name)}<br>${context.map((source) => `${escape(ws(source.workspaceId).name)} / ${escape(source.path)}`).join("<br>")}</div><div class="chatMessages">${session.request ? `<p class="chatRequest">${escape(session.request)}</p>` : "<p>Bring an agent into this activity when you need one.</p>"}${job ? `<p>${job.status === "running" ? "Reviewing the submitted resources. You can close this surface and keep working elsewhere." : "The review is available as a report in this activity."}</p>` : "<p>Your resource views remain available while the agent works.</p>"}</div><form class="chatForm" data-agent-form="${activityId}"><div class="agentTarget"><label>Run in<select name="executionWorkspace" aria-label="Agent execution workspace">${members.map((id) => `<option value="${id}" ${id === target ? "selected" : ""}>${escape(ws(id).name)}</option>`).join("")}</select></label><fieldset><legend>Read-only context</legend>${members.map((id) => `<label><input type="checkbox" name="contextWorkspace" value="${id}" ${selected.includes(id) ? "checked" : ""}>${escape(ws(id).name)}</label>`).join("")}</fieldset></div><textarea aria-label="Request for ${escape(owner.name)}" name="request" placeholder="Ask about the resources in this activity…">${escape(session.prompt || "")}</textarea><button class="button accent" ${job?.status === "running" || !selected.some((id) => members.includes(id)) ? "disabled" : ""}>${job?.status === "running" ? "Review running" : "Start a review"}</button></form></div>`;
      }
      case "report": {
        const job = item.job;
        return `<article class="report"><div class="eyebrow">${escape(act(job.activityId).name)}</div><h2>Workspace review</h2><span class="reportStatus">Review complete</span><p>Ran in <b>${escape(ws(job.executionWorkspaceId).name)}</b>. Read-only context from ${escape(workspaceNames(job.workspaceIds))}.</p><p>Checked the resources submitted in this activity:</p><ul>${job.resources.map((source) => `<li><b>${escape(ws(source.workspaceId).name)}</b> / ${escape(source.path)}</li>`).join("")}</ul><div class="note">${job.workspaceIds.length > 1 ? "This activity brings resources from several projects together. Each file keeps its own workspace as the save target." : "The workspace is usable with Chat closed. Mobile keeps one primary resource; switching returns to the correct activity."}</div><p>Next check: confirm the resource owners before updating the release notes.</p><p>This is a read-only sample review. Your documents were left untouched.</p></article>`;
      }
      default: return "";
    }
  }
  function renderSurface(id, activityId) {
    const item = resource(id);
    if (!allowedResource(activityId, item)) return "";
    const draft = item.type === "doc" && readDoc(item).draft !== readDoc(item).saved;
    return `<section class="surface" data-surface="${id}" data-activity="${activityId}" data-resource-workspace="${item.workspaceId || ""}"><header class="surfaceHeader"><span class="surfaceIcon">${icon({ doc: "FileText", diff: "GitBranch", chat: "MessageCircle", report: "CircleCheck" }[item.type] || "PanelsTopLeft")}</span>${item.workspaceId ? `<span class="resourceOwner">${escape(ws(item.workspaceId).name)}</span>` : ""}<span class="surfaceTitle" title="${escape(item.path)}">${escape(item.path)}</span>${item.type === "doc" ? `<span class="draftState" data-draft="${id}">${draft ? "Draft kept" : "Saved"}</span>` : ""}<button class="iconButton" data-focus-resource="${id}" data-activity="${activityId}" aria-label="Focus ${escape(item.title)}">${icon("Maximize2")}</button><button class="iconButton" data-close-resource="${id}" data-activity="${activityId}" aria-label="Close ${escape(item.path)}">${icon("X")}</button></header><div class="surfaceBody">${renderBody(item, activityId)}</div></section>`;
  }
  function sourceChips(activityId, compactView) {
    const view = scene(activityId), job = jobFor(activityId);
    const multiple = workspaceIdsFor(activityId).length > 1;
    return `<nav class="sourceTabs" aria-label="Resources in ${escape(act(activityId).name)}">${available(activityId).map((id) => {
      const item = resource(id);
      return `<button class="sourceChip ${view.open.includes(id) && (!compactView || view.active === id) ? "selected" : ""} ${item.type === "report" && job?.status === "ready" ? "ready" : ""}" data-show-resource="${id}" data-activity="${activityId}">${multiple && item.workspaceId ? `<small>${escape(ws(item.workspaceId).name)}</small>` : ""}${escape(item.title)}</button>`;
    }).join("")}</nav>`;
  }
  function renderContext(activityId, beside) {
    const activity = act(activityId), view = scene(activityId), job = jobFor(activityId);
    const small = Boolean(companion) || mobile();
    const visible = small ? (view.active ? [view.active] : []) : view.open;
    return `<section class="context ${beside ? "companionContext" : ""} ${focused === activityId ? "focused" : ""}" data-context="${activityId}" data-workspaces="${workspaceIdsFor(activityId).join(" ")}"><header class="contextHeader"><div class="contextName"><small>${workspaceBadges(workspaceIdsFor(activityId))}${beside ? " · Kept beside" : ""}</small><strong>${escape(activity.name)}</strong></div><div class="contextActions"><button class="button" data-resource-picker="${activityId}">${icon("Plus")}Resources</button><button class="button quiet" data-open-chat="${activityId}">${icon("MessageCircle")}Ask agent</button><button class="iconButton" data-card="${activityId}" aria-label="Dock ${escape(activity.name)} card">${icon("PanelRight")}</button>${beside ? `<button class="iconButton" data-expand="${activityId}" aria-label="Focus ${escape(activity.name)}">${icon("Maximize2")}</button><button class="iconButton" data-close-companion aria-label="Close side-by-side activity">${icon("X")}</button>` : ""}</div></header>${sourceChips(activityId, small)}<div class="surfaceGrid" style="--surfaces:${Math.max(visible.length, 1)}">${visible.map((id) => renderSurface(id, activityId)).join("") || '<div class="emptySurface">This activity is still here.<br>Choose a resource above to resume.</div>'}</div><footer class="activityFoot"><i class="statusDot ${status(activityId).kind}"></i><span>${job?.status === "running" ? "Agent is working · Chat can stay closed" : "Resources keep their workspace. Your activity keeps the context."}</span>${job?.status === "ready" ? `<button class="readyButton" data-review="${activityId}">Review ready · Open report</button>` : ""}</footer></section>`;
  }
  function renderResourceStage(activityId) {
    const view = scene(activityId);
    return `<section class="resourceStage" data-context="${activityId}"><header class="resourceFocusHead"><button class="activityBreadcrumb" data-card="${activityId}">${icon("Layers")}<span>${escape(act(activityId).name)}</span>${icon("ChevronDown")}</button><button class="button quiet" data-expanded-activity="${activityId}">${icon("PanelsTopLeft")}Related resources</button><button class="button quiet" data-resource-picker="${activityId}">${icon("Plus")}Add resource</button></header>${sourceChips(activityId, true)}${view.active ? renderSurface(view.active, activityId) : '<div class="emptySurface">Choose a resource to resume.</div>'}</section>`;
  }
  function renderShelf() {
    const ids = [...new Set([...compact, ...(docked ? [docked] : []), ...(primary && viewMode === "resource" ? [primary] : []), ...jobs().filter((job) => job.status !== "reviewed").map((job) => job.activityId)])];
    return `<div class="activityShelf" aria-label="Compact activities"><span>${icon("Layers")}Activities</span>${ids.filter((id) => act(id)).map((id) => `<button class="activeWorkerPill" data-card="${id}" title="${escape(activityScope(id))}"><i class="statusDot ${status(id).kind}"></i><span>${escape(act(id).name)}</span>${workspaceIdsFor(id).length > 1 ? icon("Link") : ""}${jobFor(id)?.status === "ready" ? '<small>Ready</small>' : ""}</button>`).join("")}<button class="shelfBrowse" data-switcher>All ${activities.length}</button></div>`;
  }
  function renderLauncher() {
    const owner = focused || primary;
    return `<div class="actionLauncher ${launcherOpen ? "open" : ""}"><div class="actionLauncherMenu">${owner ? `<button class="actionLauncherItem" style="--fan-y:-164px" data-resource-picker="${owner}">${icon("Folder")}Resources</button><button class="actionLauncherItem" style="--fan-y:-112px" data-open-chat="${owner}">${icon("MessageCircle")}Ask agent</button>` : ""}<button class="actionLauncherItem" style="--fan-y:-60px" data-switcher>${icon("Layers")}Activities</button><button class="actionLauncherItem" style="--fan-y:-8px" data-inbox>${icon("Bell")}Updates</button></div><button class="actionLauncherToggle" data-launcher aria-label="Open workspace actions" aria-expanded="${launcherOpen}"><img src="mascot.png" width="56" height="56" alt=""></button></div>`;
  }
  function render(preserveFocus = true) {
    if (composing) return;
    captureEditors();
    const active = document.activeElement;
    const focusState = preserveFocus && active?.matches("textarea") ? {
      activity: active.dataset.activity || active.closest("[data-agent-form]")?.dataset.agentForm,
      resource: active.dataset.resource, agent: Boolean(active.closest("[data-agent-form]")),
      from: active.selectionStart, to: active.selectionEnd, scroll: active.scrollTop,
    } : null;
    const nextJobs = jobs();
    const ready = nextJobs.filter((job) => job.status === "ready").length;
    const running = nextJobs.filter((job) => job.status === "running").length;
    const sidebar = workspaceLens ? ws(workspaceLens).name : "Your activities";
    const title = primary ? act(primary).name : "Your work";
    $("app").innerHTML = `<div class="shell"><nav class="rail" aria-label="Workspaces"><button class="railButton brand" data-home aria-label="All workspaces">π</button><span class="railLabel">pi web</span><button class="railButton ${workspaceLens ? "" : "selected"}" data-all-activities aria-label="All activities">${icon("Layers")}</button>${workspaces.map((item) => {
      const updates = nextJobs.filter((job) => (job.workspaceIds.includes(item.id) || job.executionWorkspaceId === item.id) && ["running", "ready"].includes(job.status));
      const hasReady = updates.some((job) => job.status === "ready");
      return `<button class="railButton ${workspaceLens === item.id ? "selected" : ""}" data-workspace="${item.id}" aria-label="Open ${escape(item.name)} workspace">${item.icon}${updates.length ? `<small class="${hasReady ? "ready" : ""}">${updates.length}</small>` : ""}</button><span class="railLabel">${escape(item.name)}</span>`;
    }).join("")}<span class="railSpacer"></span><button class="railButton" data-inbox aria-label="Updates across workspaces">${icon("Bell")}${ready ? `<small class="ready">${ready}</small>` : ""}</button><button class="railButton" data-switcher aria-label="Switch work">${icon("ArrowLeftRight")}</button></nav><aside class="activities"><div class="workspaceTitle"><h2>${escape(sidebar)}</h2><p>${workspaceLens ? "Including activities across projects" : "Work to resume, wherever it lives"}</p></div><button class="sidebarSearch" data-switcher>${icon("Search")}Find work<span class="key">Ctrl K</span></button><div class="listLabel">Activities</div>${activities.filter((item) => !workspaceLens || workspaceIdsFor(item.id).includes(workspaceLens)).map((item) => `<div class="activityItem ${primary === item.id ? "active" : ""} ${companion === item.id ? "companion" : ""}"><button class="activityMain" data-open-activity="${item.id}"><strong>${escape(item.name)}</strong><small>${escape(activityScope(item.id))}</small>${activityStatus(item.id)}</button><button class="inspectActivity iconButton" data-card="${item.id}" aria-label="Inspect ${escape(item.name)}">${icon("PanelRight")}</button><button class="beside iconButton" data-beside="${item.id}" aria-label="Keep ${escape(item.name)} beside current activity" title="Keep beside">${icon("PanelsTopLeft")}</button></div>`).join("")}<div class="sideBottom">Activities group the work.<br>Workspaces own the resources.</div></aside><header class="topbar"><div class="contextBreadcrumb"><b>${escape(title)}</b><small>${primary ? escape(activityScope(primary)) : "2 workspaces · 5 activities"}</small></div><button class="mobileContext" data-switcher>${icon("Layers")}<span><strong>${escape(title)}</strong><small>${primary ? escape(activityScope(primary)) : "2 workspaces · 5 activities"}</small></span>${icon("ChevronDown")}</button><div class="topActions"><button class="button quiet switchButton" data-switcher>${icon("ArrowLeftRight")}Switch</button>${primary ? `<button class="iconButton" data-card="${primary}" aria-label="Activity details">${icon("PanelRight")}</button>` : ""}<button class="button quiet" data-inbox>${icon("Bell")}<span>Updates${ready ? " · " + ready + " ready" : running ? " · " + running + " running" : ""}</span></button>${primary ? `<button class="iconButton" data-home aria-label="Workspace overview">${icon("Grid2X2")}</button>` : ""}</div></header><main class="stage ${docked ? "withDock" : ""}"><div class="stageMain">${primary ? (viewMode === "resource" ? renderResourceStage(primary) : `<div class="sceneGrid ${companion ? "parallel" : ""}">${renderContext(primary, false)}${companion ? renderContext(companion, true) : ""}</div>`) : renderOverview()}</div>${docked ? `<aside class="activityDock" aria-label="Docked activity">${renderActivityCard(docked)}</aside>` : ""}</main>${renderShelf()}<footer class="prototypeFoot"><span>Interactive concept · sample workspaces and simulated agent review</span><button data-reset>Reset demo</button></footer>${renderLauncher()}</div>`;
    bind();
    restoring = true;
    document.querySelectorAll("textarea[data-resource]").forEach((editor) => {
      const pos = scene(editor.dataset.activity).positions[editor.dataset.resource];
      if (pos) { editor.setSelectionRange(pos.from, pos.to); editor.scrollTop = pos.scroll; }
    });
    if (focusState) {
      const selector = focusState.agent ? `[data-agent-form="${focusState.activity}"] textarea` : `textarea[data-resource="${focusState.resource}"][data-activity="${focusState.activity}"]`;
      const editor = document.querySelector(selector);
      if (editor) { editor.focus({ preventScroll: true }); editor.setSelectionRange(focusState.from, focusState.to); editor.scrollTop = focusState.scroll; }
    }
    restoring = false;
  }
  function bind() {
    const all = (selector, callback) => $("app").querySelectorAll(selector).forEach((node) => node.addEventListener("click", () => { closeLauncher(); callback(node); }));
    all("[data-home]", () => { captureEditors(); primary = companion = focused = workspaceLens = docked = null; viewMode = "expanded"; routeProblem = ""; writeRoute(); closeOverlay(); render(false); });
    all("[data-all-activities]", () => { workspaceLens = null; writeRoute(true); render(true); });
    all("[data-open-activity]", (node) => navigate(node.dataset.openActivity));
    all("button[data-workspace]", (node) => {
      const rootId = node.dataset.workspace;
      if (primary && workspaceIdsFor(primary).includes(rootId)) {
        workspaceLens = rootId; writeRoute(); render(true);
      } else {
        navigate(resumeActivity(rootId)); workspaceLens = rootId; writeRoute(true); render(false);
      }
    });
    all("[data-card]", (node) => showActivityCard(node.dataset.card));
    all("[data-focus-resource]", (node) => focusResource(node.dataset.activity, node.dataset.focusResource));
    all("[data-beside]", (node) => navigate(node.dataset.beside, true));
    all("[data-switcher]", () => showSwitcher());
    all("[data-inbox]", () => showInbox());
    all("[data-open-chat]", (node) => openChat(node.dataset.openChat));
    all("[data-resource-picker]", (node) => showResourcePicker(node.dataset.resourcePicker));
    all("[data-show-resource]", (node) => openResource(node.dataset.activity, node.dataset.showResource));
    all("[data-close-resource]", (node) => closeResource(node.dataset.activity, node.dataset.closeResource));
    all("[data-close-companion]", () => { captureEditors(); companion = null; focused = primary; writeRoute(); render(false); });
    all("[data-expand]", (node) => { captureEditors(); companion = null; navigate(node.dataset.expand); });
    all("[data-review]", (node) => reviewReport(node.dataset.review));
    all("[data-save]", (node) => saveDocument(node.dataset.save, document.querySelector(`textarea[data-resource="${node.dataset.save}"][data-activity="${node.dataset.activity}"]`)));
    all("[data-resolve]", (node) => resolveConflict(node.dataset.resolve, node.dataset.keep === "true"));
    all("[data-range]", (node) => { captureEditors(); const value = scene(node.dataset.activity); value.filters[node.dataset.resource] = node.dataset.range; saveScene(node.dataset.activity, value); render(true); });
    all("[data-sample-tab]", (node) => { captureEditors(); const value = scene(node.dataset.activity); value.appTab = node.dataset.sampleTab; saveScene(node.dataset.activity, value); render(true); });
    all("[data-board]", (node) => { captureEditors(); const value = scene(node.dataset.activity); value.filters["board" + node.dataset.board] = !value.filters["board" + node.dataset.board]; saveScene(node.dataset.activity, value); render(true); });
    all("[data-reset]", () => reset());
    bindActivityCards($("app"));
    $("app").querySelector("[data-launcher]").onclick = () => {
      launcherOpen = !launcherOpen;
      $("app").querySelector(".actionLauncher").classList.toggle("open", launcherOpen);
      $("app").querySelector("[data-launcher]").setAttribute("aria-expanded", String(launcherOpen));
    };
    document.querySelectorAll("[data-context]").forEach((context) => context.addEventListener("pointerdown", () => {
      focused = context.dataset.context;
      document.querySelectorAll("[data-context]").forEach((other) => other.classList.toggle("focused", other === context));
    }));
    document.querySelectorAll("textarea[data-resource]").forEach((editor) => {
      editor.addEventListener("input", () => documentInput(editor));
      editor.addEventListener("blur", () => { if (!restoring) captureEditors(); });
      editor.addEventListener("compositionstart", () => { composing = true; });
      editor.addEventListener("compositionend", () => { composing = false; documentInput(editor); render(true); });
    });
    document.querySelectorAll("[data-agent-form]").forEach((form) => {
      const contextIds = () => [...form.querySelectorAll('[name="contextWorkspace"]:checked')].map((input) => input.value);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const request = form.elements.request.value.trim();
        if (request) startReview(form.dataset.agentForm, request, form.elements.executionWorkspace.value, contextIds());
      });
      form.addEventListener("change", () => {
        const value = get("session/" + form.dataset.agentForm, {});
        put("session/" + form.dataset.agentForm, { ...value, executionWorkspaceId: form.elements.executionWorkspace.value, contextWorkspaceIds: contextIds() });
        form.querySelector('button').disabled = jobFor(form.dataset.agentForm)?.status === "running" || !contextIds().length;
      });
      form.elements.request.addEventListener("input", () => { const value = get("session/" + form.dataset.agentForm, {}); put("session/" + form.dataset.agentForm, { ...value, prompt: form.elements.request.value }); });
      form.elements.request.addEventListener("compositionstart", () => { composing = true; });
      form.elements.request.addEventListener("compositionend", () => { composing = false; render(true); });
    });
  }
  function closeLauncher() {
    launcherOpen = false;
    $("app").querySelector(".actionLauncher")?.classList.remove("open");
    $("app").querySelector("[data-launcher]")?.setAttribute("aria-expanded", "false");
  }
  let overlayReturnFocus = null;
  function closeOverlay() {
    overlay = null;
    $("overlay").innerHTML = "";
    if (overlayReturnFocus?.isConnected) overlayReturnFocus.focus({ preventScroll: true });
    overlayReturnFocus = null;
  }
  function overlayRows() {
    $("overlay").querySelectorAll("[data-open-activity]").forEach((node) => node.onclick = () => navigate(node.dataset.openActivity));
    $("overlay").querySelectorAll("[data-beside]").forEach((node) => node.onclick = () => navigate(node.dataset.beside, true));
    $("overlay").querySelectorAll("[data-card]").forEach((node) => node.onclick = () => { closeOverlay(); showActivityCard(node.dataset.card); });
    $("overlay").querySelectorAll("[data-picker-resource]").forEach((node) => node.onclick = () => { const owner = overlay.activityId; closeOverlay(); openResource(owner, node.dataset.pickerResource); });
    $("overlay").querySelectorAll("[data-inbox-open]").forEach((node) => node.onclick = () => { const owner = node.dataset.inboxOpen; navigate(owner); reviewReport(owner); });
  }
  function showSwitcher() {
    closeLauncher();
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "switcher" };
    $("overlay").innerHTML = `<div class="overlayShade"><section class="switcher" role="dialog" aria-modal="true" aria-label="Switch work"><header class="switcherHeader"><input id="workSearch" aria-label="Find a workspace or activity" placeholder="Find a workspace or activity…"><button class="iconButton" data-close-overlay aria-label="Close switcher">${icon("X")}</button></header><div id="switchRows"></div><footer class="switchFooter">Resume an activity, inspect its card, or keep it beside your current work.</footer><div class="mobileNotice">One primary resource at a time. Background activities keep running.</div></section></div>`;
    fillSwitcher("");
    $("workSearch").addEventListener("input", (event) => fillSwitcher(event.target.value));
    $("workSearch").focus();
    bindOverlayClose();
  }
  function fillSwitcher(query) {
    const term = query.toLowerCase();
    const matches = activities.filter((item) => `${activityScope(item.id)} ${item.name} ${item.summary}`.toLowerCase().includes(term));
    const groups = [
      { label: "Across workspaces", list: matches.filter((item) => workspaceIdsFor(item.id).length > 1) },
      ...workspaces.map((workspace) => ({ label: workspace.name, list: matches.filter((item) => workspaceIdsFor(item.id).length === 1 && workspaceIdsFor(item.id).includes(workspace.id)) })),
    ];
    $("switchRows").innerHTML = groups.filter((group) => group.list.length).map((group) => `<div class="switchGroup">${escape(group.label)}</div>${group.list.map((item) => `<div class="switchRow"><button class="switchMain" data-open-activity="${item.id}"><strong>${escape(item.name)}</strong><small>${escape(activityScope(item.id))} · ${escape(status(item.id).label)}</small></button><button class="iconButton" data-card="${item.id}" aria-label="Inspect ${escape(item.name)}">${icon("PanelRight")}</button>${primary && primary !== item.id && !mobile() ? `<button class="button" data-beside="${item.id}">Keep beside</button>` : ""}</div>`).join("")}`).join("") || '<div class="switchFooter">No matching activities.</div>';
    overlayRows();
  }
  function showResourcePicker(activityId) {
    closeLauncher();
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "resources", activityId };
    const activity = act(activityId), members = workspaceIdsFor(activityId);
    $("overlay").innerHTML = `<div class="overlayShade"><section class="switcher" role="dialog" aria-modal="true" aria-label="Workspace resources"><header class="switcherHeader"><h2>Add to ${escape(activity.name)}</h2><button class="iconButton" data-close-overlay aria-label="Close resources">${icon("X")}</button></header>${workspaces.map((workspace) => `<div class="switchGroup">${escape(workspace.name)}${members.includes(workspace.id) ? "" : " · Add another workspace"}</div>${Object.keys(resources).filter((id) => resources[id].workspaceId === workspace.id).map((id) => `<div class="switchRow"><button class="switchMain" data-picker-resource="${id}"><strong>${escape(resource(id).title)}</strong><small>${escape(workspace.name)} / ${escape(resource(id).path)}${members.includes(workspace.id) ? "" : " · Attach from this workspace"}</small></button></div>`).join("")}`).join("")}<footer class="switchFooter">The resource keeps its workspace as the save target. Adding a resource brings its workspace into this activity.</footer></section></div>`;
    overlayRows();
    bindOverlayClose();
    $("overlay").querySelector("button").focus();
  }
  function showInbox() {
    closeLauncher();
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "inbox" };
    const list = jobs().filter((job) => job.status !== "reviewed");
    $("overlay").innerHTML = `<div class="overlayShade"><section class="inbox" role="dialog" aria-modal="true" aria-label="Updates across workspaces"><header class="switcherHeader"><h2>Updates across your work</h2><button class="iconButton" data-close-overlay aria-label="Close updates">×</button></header>${list.map((job) => `<article class="inboxItem"><div class="label">${escape(workspaceNames(job.workspaceIds))} / ${escape(act(job.activityId).name)}</div><h3>${job.status === "running" ? "Review is running" : "Review ready"}</h3><p>${job.status === "running" ? "The agent is working in this activity. Keep using your current resources." : "The report is waiting in its original activity. Your current work stays here."}</p>${job.status === "ready" ? `<button class="button accent" data-inbox-open="${job.activityId}">Go to activity and review</button>` : ""}</article>`).join("") || '<div class="inboxItem"><p>No updates waiting. You can work without starting an agent.</p></div>'}</section></div>`;
    overlayRows();
    bindOverlayClose();
    $("overlay").querySelector("button").focus();
  }
  function bindOverlayClose() {
    $("overlay").querySelector("[data-close-overlay]").onclick = closeOverlay;
    $("overlay").querySelector(".overlayShade").addEventListener("pointerdown", (event) => { if (event.target.classList.contains("overlayShade")) closeOverlay(); });
  }
  function refreshActivitySheet() {
    if (overlay?.type !== "activity") return;
    const sheet = $("overlay").querySelector(".activitySheet");
    const active = document.activeElement;
    const action = sheet.contains(active) ? ["data-close-overlay", "data-card-resource", "data-expanded-activity", "data-compact", "data-card-chat"].find((key) => active.hasAttribute(key)) : null;
    const value = action ? active.getAttribute(action) : null;
    const scroll = sheet.querySelector(".cardBody").scrollTop;
    sheet.innerHTML = renderActivityCard(overlay.activityId, true);
    bindActivityCards($("overlay"));
    bindOverlayClose();
    sheet.querySelector(".cardBody").scrollTop = scroll;
    if (action) sheet.querySelector(`[${action}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
  }
  function reset() {
    try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key); } catch { /* No persistent storage. */ }
    memory.clear(); conflicts.clear(); knownVersions.clear(); sceneCache.clear(); lastCache.clear();
    primary = companion = focused = workspaceLens = docked = null; compact = []; launcherOpen = false; viewMode = "expanded"; routeProblem = "";
    closeOverlay();
    // Do not capture old DOM after deliberately resetting the demonstration.
    $("app").innerHTML = "";
    writeRoute(true); render(false);
  }
  window.addEventListener("popstate", () => { captureEditors(); readRoute(); closeOverlay(); render(false); });
  window.addEventListener("beforeunload", captureEditors);
  window.addEventListener("resize", () => render(true));
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(PREFIX)) return;
    const key = event.key.slice(PREFIX.length);
    if (key.startsWith("document/")) {
      const editor = document.activeElement;
      if (editor?.matches("textarea[data-resource]") && docKey(resource(editor.dataset.resource)) === key && event.newValue) {
        const incoming = JSON.parse(event.newValue), previous = event.oldValue ? JSON.parse(event.oldValue) : { saved: resource(editor.dataset.resource).text };
        if (editor.value !== incoming.draft && editor.value !== previous.saved) {
          const local = { saved: previous.saved, draft: editor.value, version: knownVersions.get(key) || 0 };
          conflicts.set(key, { local, remote: incoming });
          put("recovery/" + tabId + "/" + key, local);
        }
      }
      render(true);
    } else if (key === "jobs" || key.startsWith("references/")) {
      render(true);
      refreshActivitySheet();
      if (overlay?.type === "switcher") fillSwitcher($("workSearch").value);
      if (overlay?.type === "inbox") showInbox();
    }
    // Other windows may save preferences; they never change this window's context.
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); overlay ? closeOverlay() : showSwitcher(); }
    if (event.key === "Escape") {
      if (overlay) closeOverlay();
      else if (launcherOpen) closeLauncher();
      else if (docked && !mobile()) keepCompact(docked);
    }
    if (event.key === "Tab" && overlay) {
      const list = [...$("overlay").querySelectorAll("button:not(:disabled),input,textarea")];
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && overlay?.type === "switcher") {
      const list = [$("workSearch"), ...$("overlay").querySelectorAll(".switchMain")];
      const index = list.indexOf(document.activeElement);
      if (index >= 0) { event.preventDefault(); list[(index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus(); }
    }
    if (event.key === "Enter" && document.activeElement === $("workSearch")) { event.preventDefault(); $("overlay").querySelector(".switchMain")?.click(); }
  });
  setInterval(() => { for (const job of jobs()) if (job.status === "running" && Date.now() >= job.due) finishJob(job.id); }, 500);
  // Deliberately limited driver for deterministic recordings of a mock runtime.
  window.piWebDemo = Object.freeze({ snapshot: () => ({ primary, companion, focused, workspaceLens, viewMode, docked, compact: [...compact], activities: activities.map((item) => ({ ...item, workspaceIds: workspaceIdsFor(item.id) })), jobs: jobs(), scenes: activities.map((item) => ({ id: item.id, view: scene(item.id) })) }), finishJob, reset });
  readRoute(); render(false);
})();
