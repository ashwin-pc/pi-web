/* A browser-only interface probe. Workspaces, resources and jobs are sample data. */
(() => {
  "use strict";
  const PREFIX = "pi-web.multitasking-probe.v1/";
  const tabId = crypto.randomUUID();
  const workspaces = [
    { id: "pi-web", name: "Pi Web", label: "Responsive agent workspace", color: "gold", icon: "P" },
    { id: "trail-notes", name: "Trail Notes", label: "A second project: routes, data and plans", color: "blue", icon: "T" },
  ];
  const activities = [
    { id: "pi-navigation", workspaceId: "pi-web", name: "Workspace navigation", summary: "Design document + running shell", initial: ["pi-nav", "pi-preview"] },
    { id: "pi-release", workspaceId: "pi-web", name: "Prepare the release", summary: "Checklist + working changes", initial: ["pi-release-doc", "pi-diff"] },
    { id: "trail-usage", workspaceId: "trail-notes", name: "Explore usage", summary: "Dashboard + analysis notes", initial: ["trail-dashboard", "trail-analysis"] },
    { id: "trail-roadmap", workspaceId: "trail-notes", name: "Plan the next release", summary: "Roadmap + planning board", initial: ["trail-roadmap-doc", "trail-board"] },
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
  const memory = new Map();
  const conflicts = new Map();
  const knownVersions = new Map();
  const sceneCache = new Map();
  const lastCache = new Map();
  let primary = null;
  let companion = null;
  let focused = null;
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
  const docKey = (resource) => "document/" + JSON.stringify([resource.workspaceId, resource.path]);
  function readDoc(resource) {
    const key = docKey(resource);
    if (conflicts.has(key)) return conflicts.get(key).local;
    const value = get(key, { saved: resource.text, draft: resource.text, version: 0 });
    return typeof value.draft === "string" && typeof value.saved === "string" && Number.isSafeInteger(value.version)
      ? value : { saved: resource.text, draft: resource.text, version: 0 };
  }
  function jobs() {
    return get("jobs", []).filter((job) => act(job.activityId)?.workspaceId === job.workspaceId
      && ["running", "ready", "reviewed"].includes(job.status));
  }
  const jobFor = (activityId) => jobs().findLast((job) => job.activityId === activityId);
  function resource(id) {
    if (resources[id]) return { id, ...resources[id] };
    if (id?.startsWith("chat:")) {
      const owner = act(id.slice(5));
      if (owner) return { id, workspaceId: owner.workspaceId, type: "chat", path: "Agent session", activityId: owner.id, title: "Optional agent session" };
    }
    if (id?.startsWith("report:")) {
      const job = jobs().find((item) => item.id === id.slice(7));
      if (job && job.status !== "running") return { id, workspaceId: job.workspaceId, type: "report", path: ".pi/reports/" + job.activityId + ".md", title: "Review report", job };
    }
    return null;
  }
  function available(activityId) {
    const activity = act(activityId);
    const ids = [...activity.initial, ...get("references/" + activityId, [])];
    if (get("session/" + activityId, null)) ids.push("chat:" + activityId);
    const job = jobFor(activityId);
    if (job && job.status !== "running") ids.push("report:" + job.id);
    return [...new Set(ids)].filter((id) => resource(id)?.workspaceId === activity.workspaceId);
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
    return act(candidate)?.workspaceId === workspaceId ? candidate : activities.find((item) => item.workspaceId === workspaceId).id;
  }
  function status(activityId) {
    const job = jobFor(activityId);
    if (job?.status === "running") return { label: "Agent reviewing in background", kind: "running" };
    if (job?.status === "ready") return { label: "Review ready", kind: "ready" };
    if (act(activityId).initial.some((id) => resource(id)?.type === "doc" && readDoc(resource(id)).draft !== readDoc(resource(id)).saved)) return { label: "Draft kept", kind: "draft" };
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
    for (const key of ["workspace", "activity", "beside"]) url.searchParams.delete(key);
    if (primary) {
      url.searchParams.set("workspace", act(primary).workspaceId);
      url.searchParams.set("activity", primary);
      if (companion) url.searchParams.set("beside", companion);
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
    if (workspaceId) {
      if (!ws(workspaceId)) routeProblem = "This workspace is unavailable in the prototype.";
      else if (activityId && act(activityId)?.workspaceId !== workspaceId) routeProblem = "This activity does not belong to the selected workspace.";
      else primary = activityId || resumeActivity(workspaceId);
    }
    const beside = params.get("beside");
    if (primary && act(beside) && beside !== primary) companion = beside;
    focused = primary;
  }
  function navigate(activityId, asCompanion = false) {
    if (!act(activityId)) return;
    captureEditors();
    if (asCompanion && primary && activityId !== primary && !mobile()) companion = activityId;
    else {
      primary = activityId;
      if (companion === primary) companion = null;
      focused = primary;
      lastCache.set(act(primary).workspaceId, primary);
      put("last/" + act(primary).workspaceId, primary);
    }
    routeProblem = "";
    writeRoute();
    closeOverlay();
    render(false);
  }
  function openResource(activityId, id) {
    const item = resource(id);
    if (!item || item.workspaceId !== act(activityId)?.workspaceId) throw new Error("Resource and activity belong to different workspaces");
    captureEditors();
    const refs = get("references/" + activityId, []);
    if (!refs.includes(id)) put("references/" + activityId, [...refs, id]);
    const value = scene(activityId);
    if (!value.open.includes(id)) value.open = [...value.open, id].slice(-3);
    value.active = id;
    saveScene(activityId, value);
    render(false);
  }
  function closeResource(activityId, id) {
    captureEditors();
    const value = scene(activityId);
    value.open = value.open.filter((other) => other !== id);
    if (value.active === id) value.active = value.open[0];
    saveScene(activityId, value);
    render(false);
  }
  function openChat(activityId) {
    if (!get("session/" + activityId, null)) put("session/" + activityId, { prompt: "", created: Date.now() });
    openResource(activityId, "chat:" + activityId);
  }
  function startReview(activityId, request) {
    const current = jobFor(activityId);
    if (current?.status === "running") return;
    const activity = act(activityId);
    const job = { id: crypto.randomUUID(), workspaceId: activity.workspaceId, activityId, request,
      // Capture ownership and submitted content when the request is made.
      resources: available(activityId).map(resource).filter((item) => item.type !== "chat" && item.type !== "report").map((item) => ({ workspaceId: item.workspaceId, path: item.path, type: item.type, ...(item.type === "doc" ? { snapshot: readDoc(item).draft } : {}) })),
      status: "running", started: Date.now(), due: Date.now() + 45_000 };
    put("jobs", [...jobs(), job]);
    const session = get("session/" + activityId, {});
    put("session/" + activityId, { ...session, prompt: request, request });
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
    $("announcer").textContent = `${ws(item.workspaceId).name}, ${act(item.activityId).name}: review ready.`;
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
  function renderOverview() {
    return `<section class="overview"><div class="label">Your work</div><h1>Several things, one place to return.</h1><p>Two workspaces. Four activities. Open the resources you need; bring an agent in when useful.</p>
      ${routeProblem ? `<div class="overviewTip">${escape(routeProblem)}</div>` : ""}
      <div class="workspaceCards">${workspaces.map((workspace) => `<section class="workspaceCard ${workspace.id === "trail-notes" ? "trail" : ""}"><h2>${workspace.name}<small>${jobs().filter((job) => job.workspaceId === workspace.id && job.status === "running").length} running</small></h2><p>${workspace.label}</p>${activities.filter((item) => item.workspaceId === workspace.id).map((activity) => `<div class="workRow">${mini()}<div class="workDescription"><strong>${activity.name}</strong><small>${activity.summary}</small>${activityStatus(activity.id)}</div><button class="button" data-open-activity="${activity.id}">Resume</button></div>`).join("")}</section>`).join("")}</div>
      <div class="overviewTip"><b>Your context stays with the activity.</b><span>Keep drafts, filters and resource views when you switch. Updates name the workspace and activity they belong to. Chat can stay closed.</span></div></section>`;
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
        return `<div class="chatBody"><div class="chatContext">${ws(owner.workspaceId).name} / ${owner.name}<br>Context: ${available(activityId).map(resource).filter((source) => !["chat", "report"].includes(source.type)).map((source) => escape(source.path)).join(" · ")}</div><div class="chatMessages">${session.request ? `<p class="chatRequest">${escape(session.request)}</p>` : "<p>Bring an agent into this activity when you need one.</p>"}${job ? `<p>${job.status === "running" ? "Reviewing the submitted resources. You can close this surface and keep working elsewhere." : "The review is available as a report in this activity."}</p>` : "<p>Your resource views remain available while the agent works.</p>"}</div><form class="chatForm" data-agent-form="${activityId}"><textarea aria-label="Request for ${owner.name}" name="request" placeholder="Ask about the resources in this activity…">${escape(session.prompt || "")}</textarea><button class="button accent" ${job?.status === "running" ? "disabled" : ""}>${job?.status === "running" ? "Review running" : "Start a review"}</button></form></div>`;
      }
      case "report": {
        const job = item.job;
        return `<article class="report"><div class="eyebrow">${ws(job.workspaceId).name} / ${act(job.activityId).name}</div><h2>Workspace review</h2><span class="reportStatus">Review complete</span><p>Checked the resources submitted in this activity:</p><ul>${job.resources.map((source) => `<li>${escape(source.path)}</li>`).join("")}</ul><div class="note">The workspace is usable with Chat closed. Mobile keeps one primary resource; switching returns to the correct activity.</div><p>Next check: confirm 44px tap targets in the mobile switcher.</p><p>This is a read-only sample review. Your documents were left untouched.</p></article>`;
      }
      default: return "";
    }
  }
  function renderSurface(id, activityId) {
    const item = resource(id);
    if (!item || item.workspaceId !== act(activityId).workspaceId) return "";
    const draft = item.type === "doc" && readDoc(item).draft !== readDoc(item).saved;
    return `<section class="surface" data-surface="${id}" data-activity="${activityId}"><header class="surfaceHeader"><span class="surfaceIcon">${{ doc: "▤", diff: "⑂", chat: "◎", report: "✓" }[item.type] || "◈"}</span><span class="surfaceTitle" title="${escape(item.path)}">${escape(item.path)}</span>${item.type === "doc" ? `<span class="draftState" data-draft="${id}">${draft ? "Draft kept" : "Saved"}</span>` : ""}<button class="iconButton" data-close-resource="${id}" data-activity="${activityId}" aria-label="Close ${escape(item.path)}">×</button></header><div class="surfaceBody">${renderBody(item, activityId)}</div></section>`;
  }
  function renderContext(activityId, beside) {
    const activity = act(activityId), workspace = ws(activity.workspaceId), view = scene(activityId), job = jobFor(activityId);
    const isCompact = Boolean(companion) || mobile();
    const visible = isCompact ? (view.active ? [view.active] : []) : view.open;
    return `<section class="context ${beside ? "companionContext" : ""} ${focused === activityId ? "focused" : ""}" data-context="${activityId}" data-workspace="${workspace.id}"><header class="contextHeader"><div class="contextName"><small>${workspace.name}${beside ? " · Kept beside" : ""}</small><strong>${activity.name}</strong></div><div class="contextActions"><button class="button" data-resource-picker="${activityId}">Resources</button><button class="button" data-open-chat="${activityId}">Ask agent</button>${beside ? `<button class="iconButton" data-expand="${activityId}" aria-label="Focus ${activity.name}">↗</button><button class="iconButton" data-close-companion aria-label="Close side-by-side activity">×</button>` : ""}</div></header><nav class="sourceTabs" aria-label="Resources in ${activity.name}">${available(activityId).map((id) => `<button class="sourceChip ${view.open.includes(id) && (!isCompact || view.active === id) ? "selected" : ""} ${resource(id).type === "report" && job?.status === "ready" ? "ready" : ""}" data-show-resource="${id}" data-activity="${activityId}">${escape(resource(id).title)}</button>`).join("")}</nav><div class="surfaceGrid" style="--surfaces:${Math.max(visible.length, 1)}">${visible.map((id) => renderSurface(id, activityId)).join("") || '<div class="emptySurface">This activity is still here.<br>Choose a resource above to resume.</div>'}</div><footer class="activityFoot"><i class="statusDot ${status(activityId).kind}"></i><span>${job?.status === "running" ? "Agent is working · Chat can stay closed" : "Resource state stays with this workspace and activity"}</span>${job?.status === "ready" ? `<button class="readyButton" data-review="${activityId}">Review ready · Open report</button>` : ""}</footer></section>`;
  }
  function render(preserveFocus = true) {
    if (composing) return;
    captureEditors();
    const active = document.activeElement;
    const focusState = preserveFocus && active?.matches("textarea[data-resource]") ? { activity: active.dataset.activity, resource: active.dataset.resource } : null;
    const workspace = primary ? ws(act(primary).workspaceId) : null;
    const nextJobs = jobs();
    const ready = nextJobs.filter((job) => job.status === "ready").length;
    const running = nextJobs.filter((job) => job.status === "running").length;
    $("app").innerHTML = `<div class="shell"><nav class="rail" aria-label="Workspaces"><button class="railButton ${primary ? "" : "selected"}" data-home aria-label="All workspaces">▦</button><span class="railLabel">Your work</span>${workspaces.map((item) => {
      const updates = nextJobs.filter((job) => job.workspaceId === item.id && ["running", "ready"].includes(job.status));
      const hasReady = updates.some((job) => job.status === "ready");
      return `<button class="railButton ${item.id === "trail-notes" ? "trail" : ""} ${workspace?.id === item.id ? "selected" : ""}" data-workspace="${item.id}" aria-label="Open ${item.name} workspace">${item.icon}${updates.length ? `<small class="${hasReady ? "ready" : ""}">${updates.length}</small>` : ""}</button><span class="railLabel">${item.name}</span>`;
    }).join("")}<span class="railSpacer"></span><button class="railButton updates" data-inbox aria-label="Updates across workspaces">◷${ready ? `<small class="ready">${ready}</small>` : ""}</button><span class="railLabel">Updates</span><button class="railButton" data-switcher aria-label="Switch work">⇄</button></nav><aside class="activities"><div class="workspaceTitle"><h2>${workspace?.name || "All workspaces"}</h2><p>${workspace ? workspace.label : "Return to any activity"}</p></div><div class="listLabel">${workspace ? "Activities" : "Activity shortcuts"}</div>${activities.filter((item) => !workspace || item.workspaceId === workspace.id).map((item) => `<div class="activityItem ${primary === item.id ? "active" : ""} ${companion === item.id ? "companion" : ""}"><button class="activityMain" data-open-activity="${item.id}">${mini()}<strong>${item.name}</strong><small>${!workspace ? ws(item.workspaceId).name + " · " : ""}${item.summary}</small>${activityStatus(item.id)}</button><button class="beside" data-beside="${item.id}" aria-label="Keep ${item.name} beside current activity" title="Keep beside">◫</button></div>`).join("")}<div class="sideBottom">Switching keeps the work.<br>Closing a view keeps its activity.<br>Agents are optional.</div></aside><header class="topbar"><div class="contextBreadcrumb">${primary ? `<b>${workspace.name}</b><span>/</span>${act(primary).name}` : '<b>Your work</b><span>/</span>Two workspaces'}</div><button class="mobileContext" data-switcher><span>▦</span><span><strong>${primary ? workspace.name : "Your work"}</strong><small>${primary ? act(primary).name : "2 workspaces · 4 activities"} ▾</small></span></button><div class="topActions"><button class="button quiet switchButton" data-switcher>Switch work<span class="key">Ctrl K</span></button><button class="button quiet" data-inbox>Updates${ready ? " · " + ready + " ready" : running ? " · " + running + " running" : ""}</button>${primary ? '<button class="button quiet" data-home aria-label="Workspace overview">▦</button>' : ""}</div></header><main class="stage">${primary ? `<div class="sceneGrid ${companion ? "parallel" : ""}">${renderContext(primary, false)}${companion ? renderContext(companion, true) : ""}</div>` : renderOverview()}</main><footer class="prototypeFoot"><span>Interactive concept · sample workspaces and simulated agent review</span><button data-reset>Reset demo</button></footer></div>`;
    bind();
    restoring = true;
    document.querySelectorAll("textarea[data-resource]").forEach((editor) => {
      const pos = scene(editor.dataset.activity).positions[editor.dataset.resource];
      if (pos) { editor.setSelectionRange(pos.from, pos.to); editor.scrollTop = pos.scroll; }
    });
    if (focusState) document.querySelector(`textarea[data-resource="${focusState.resource}"][data-activity="${focusState.activity}"]`)?.focus({ preventScroll: true });
    restoring = false;
  }
  function bind() {
    const all = (selector, callback) => document.querySelectorAll(selector).forEach((node) => node.addEventListener("click", () => callback(node)));
    all("[data-home]", () => { captureEditors(); primary = companion = focused = null; routeProblem = ""; writeRoute(); closeOverlay(); render(false); });
    all("[data-open-activity]", (node) => navigate(node.dataset.openActivity));
    all("button[data-workspace]", (node) => navigate(resumeActivity(node.dataset.workspace)));
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
      form.addEventListener("submit", (event) => { event.preventDefault(); const request = form.elements.request.value.trim(); if (request) startReview(form.dataset.agentForm, request); });
      form.elements.request.addEventListener("input", () => { const value = get("session/" + form.dataset.agentForm, {}); put("session/" + form.dataset.agentForm, { ...value, prompt: form.elements.request.value }); });
    });
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
    $("overlay").querySelectorAll("[data-picker-resource]").forEach((node) => node.onclick = () => { const owner = overlay.activityId; closeOverlay(); openResource(owner, node.dataset.pickerResource); });
    $("overlay").querySelectorAll("[data-inbox-open]").forEach((node) => node.onclick = () => { const owner = node.dataset.inboxOpen; navigate(owner); reviewReport(owner); });
  }
  function showSwitcher() {
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "switcher" };
    $("overlay").innerHTML = `<div class="overlayShade"><section class="switcher" role="dialog" aria-modal="true" aria-label="Switch work"><header class="switcherHeader"><input id="workSearch" aria-label="Find a workspace or activity" placeholder="Find a workspace or activity…"><button class="iconButton" data-close-overlay aria-label="Close switcher">×</button></header><div id="switchRows"></div><footer class="switchFooter">Open resumes that activity. Keep beside shows a second context on desktop.</footer><div class="mobileNotice">One primary resource at a time. Background activities keep running.</div></section></div>`;
    fillSwitcher("");
    $("workSearch").addEventListener("input", (event) => fillSwitcher(event.target.value));
    $("workSearch").focus();
    bindOverlayClose();
  }
  function fillSwitcher(query) {
    const term = query.toLowerCase();
    $("switchRows").innerHTML = workspaces.map((workspace) => {
      const list = activities.filter((item) => item.workspaceId === workspace.id && `${workspace.name} ${item.name} ${item.summary}`.toLowerCase().includes(term));
      if (!list.length) return "";
      return `<div class="switchGroup">${workspace.name}</div>${list.map((item) => `<div class="switchRow"><button class="switchMain" data-open-activity="${item.id}"><strong>${item.name}</strong><small>${item.summary} · ${status(item.id).label}</small></button>${primary && primary !== item.id && !mobile() ? `<button class="button" data-beside="${item.id}">Keep beside</button>` : ""}</div>`).join("")}`;
    }).join("") || '<div class="switchFooter">No matching activities.</div>';
    overlayRows();
  }
  function showResourcePicker(activityId) {
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "resources", activityId };
    const activity = act(activityId);
    const ids = [...new Set([...Object.keys(resources).filter((id) => resources[id].workspaceId === activity.workspaceId), ...available(activityId)])];
    $("overlay").innerHTML = `<div class="overlayShade"><section class="switcher" role="dialog" aria-modal="true" aria-label="Workspace resources"><header class="switcherHeader"><h2>${ws(activity.workspaceId).name} · Resources</h2><button class="iconButton" data-close-overlay aria-label="Close resources">×</button></header>${ids.map((id) => `<div class="switchRow"><button class="switchMain" data-picker-resource="${id}"><strong>${resource(id).title}</strong><small>${escape(resource(id).path)}</small></button></div>`).join("")}<footer class="switchFooter">Open a resource in ${activity.name}. Its content belongs to ${ws(activity.workspaceId).name}.</footer></section></div>`;
    overlayRows();
    bindOverlayClose();
    $("overlay").querySelector("button").focus();
  }
  function showInbox() {
    captureEditors();
    overlayReturnFocus = document.activeElement;
    overlay = { type: "inbox" };
    const list = jobs().filter((job) => job.status !== "reviewed");
    $("overlay").innerHTML = `<div class="overlayShade"><section class="inbox" role="dialog" aria-modal="true" aria-label="Updates across workspaces"><header class="switcherHeader"><h2>Updates across your work</h2><button class="iconButton" data-close-overlay aria-label="Close updates">×</button></header>${list.map((job) => `<article class="inboxItem"><div class="label">${ws(job.workspaceId).name} / ${act(job.activityId).name}</div><h3>${job.status === "running" ? "Review is running" : "Review ready"}</h3><p>${job.status === "running" ? "The agent is working in this activity. Keep using your current resources." : "The report is waiting in its original activity. Your current work stays here."}</p>${job.status === "ready" ? `<button class="button accent" data-inbox-open="${job.activityId}">Go to activity and review</button>` : ""}</article>`).join("") || '<div class="inboxItem"><p>No updates waiting. You can work without starting an agent.</p></div>'}</section></div>`;
    overlayRows();
    bindOverlayClose();
    $("overlay").querySelector("button").focus();
  }
  function bindOverlayClose() {
    $("overlay").querySelector("[data-close-overlay]").onclick = closeOverlay;
    $("overlay").querySelector(".overlayShade").addEventListener("pointerdown", (event) => { if (event.target.classList.contains("overlayShade")) closeOverlay(); });
  }
  function reset() {
    try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key); } catch { /* No persistent storage. */ }
    memory.clear(); conflicts.clear(); knownVersions.clear(); sceneCache.clear(); lastCache.clear();
    primary = companion = focused = null; routeProblem = "";
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
    } else if (key === "jobs") {
      render(true);
      if (overlay?.type === "switcher") fillSwitcher($("workSearch").value);
      if (overlay?.type === "inbox") showInbox();
    }
    // Other windows may save preferences; they never change this window's context.
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); overlay ? closeOverlay() : showSwitcher(); }
    if (event.key === "Escape" && overlay) closeOverlay();
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
  window.piWebDemo = Object.freeze({ snapshot: () => ({ primary, companion, focused, jobs: jobs(), scenes: activities.map((item) => ({ id: item.id, view: scene(item.id) })) }), finishJob, reset });
  readRoute(); render(false);
})();
