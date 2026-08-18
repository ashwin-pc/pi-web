import { activeSessionState, sessionRuntime } from "../app/sessionState.js";
import { iconElement, setIcon } from "../app/icons.js";
import type { AppState } from "../app/types.js";
import type { GitStatusResponse } from "../git/types.js";
import type { RightPanelHandle, RightPanelManager } from "../layout/rightPanel.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactNumber(value: unknown) {
  const number = finiteNumber(value);
  if (number === undefined) return "—";
  if (Math.abs(number) < 1_000) return Math.round(number).toLocaleString();
  if (Math.abs(number) < 1_000_000) {
    const amount = number / 1_000;
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)}k`;
  }
  const amount = number / 1_000_000;
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)}m`;
}

function formatCost(value: unknown) {
  const number = finiteNumber(value);
  return number === undefined ? "—" : `$${number.toFixed(number < 1 ? 3 : 2)}`;
}

function formatDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function elapsedTime(value: unknown) {
  if (typeof value !== "string") return "—";
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function baseName(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").pop() || path;
}

function extensionName(path: string) {
  const name = baseName(path);
  if (/^index\.[cm]?[jt]s$/i.test(name)) {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts.at(-2) || name;
  }
  return name.replace(/\.[cm]?[jt]s$/i, "");
}

function isBuiltInSource(value?: SourceInfoDto) {
  return value?.source === "builtin" || value?.source === "built-in" || value?.path?.startsWith("<builtin") || value?.path?.startsWith("<built-in");
}

function sourceScope(value?: SourceInfoDto) {
  if (isBuiltInSource(value)) return "Built-in";
  if (value?.scope === "project") return "Project";
  if (value?.scope === "user") return "User";
  if (value?.scope === "temporary") return "Temporary";
  return "Other";
}

function toolSourceLabel(tool: ToolContextDto) {
  const path = tool.sourceInfo?.path || "";
  if (isBuiltInSource(tool.sourceInfo)) return "Built-in";
  if (path.startsWith("<")) return tool.sourceInfo?.source || "SDK";
  return path ? extensionName(path) : tool.sourceInfo?.source || "Other";
}

function contributionCount(extension: ExtensionContextDto) {
  if (typeof extension.contributionCount === "number") return extension.contributionCount;
  const contributions = extension.contributions;
  if (!contributions) return 0;
  return Object.values(contributions).reduce((sum, value) => sum + (finiteNumber(value) || 0), 0);
}

async function copyText(value: string) {
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = el("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

type SourceInfoDto = {
  path?: string;
  source?: string;
  scope?: "user" | "project" | "temporary" | string;
  origin?: string;
};

type ToolContextDto = {
  name: string;
  description?: string;
  sourceInfo?: SourceInfoDto;
  active?: boolean;
  callCount?: number;
};

type SkillContextDto = {
  name: string;
  description?: string;
  filePath?: string;
  sourceInfo?: SourceInfoDto;
};

type ExtensionContextDto = {
  path: string;
  resolvedPath?: string;
  sourceInfo?: SourceInfoDto;
  contributionCount?: number;
  contributions?: Record<string, number>;
};

type PromptProvenanceSource = {
  kind: "system-prompt" | "context-file" | "skill" | "tool" | "append-prompt" | "pi-web" | "unknown";
  label: string;
  path?: string;
};

type PromptProvenanceSpan = {
  start: number;
  end: number;
  source: PromptProvenanceSource;
  confidence: "exact" | "derived" | "unknown";
};

type SessionContextDto = {
  sessionId: string;
  systemPrompt: string;
  provenance?: {
    encoding: "utf-16";
    spans: PromptProvenanceSpan[];
    coverage: { exact: number; derived: number; unknown: number; total: number };
  };
  capturedAt?: string;
  tools?: {
    activeNames?: string[];
    configured?: ToolContextDto[];
    callsByName?: Record<string, number>;
  };
  resources?: {
    skills?: SkillContextDto[];
    extensions?: ExtensionContextDto[];
    contextFiles?: Array<string | { path: string }>;
    systemPromptSource?: string | { path: string };
    appendSystemPromptSources?: Array<string | { path: string }>;
    diagnostics?: unknown[];
    extensionErrors?: unknown[];
  };
};

export type SessionInfoController = {
  init: () => void;
  open: () => void;
  update: () => void;
  isOpen: () => boolean;
};

export function createSessionInfo(options: {
  state: AppState;
  rightPanels: RightPanelManager;
  apiHeaders: () => Record<string, string>;
  refreshSessions?: () => Promise<void>;
  openGit: () => void;
}): SessionInfoController {
  const { state, rightPanels, apiHeaders, refreshSessions, openGit } = options;

  const backdrop = el("div", "sessionInfoBackdrop appPanelBackdrop");
  backdrop.id = "sessionInfoBackdrop";
  backdrop.hidden = true;

  const panel = el("aside", "sessionInfoPanel webPanel");
  panel.id = "sessionInfoPanel";
  panel.setAttribute("aria-label", "Session information");
  panel.hidden = true;

  const header = el("header", "sessionInfoHeader webPanelHeader");
  const backButton = el("button", "iconButton sessionInfoBackButton");
  backButton.type = "button";
  backButton.title = "Back to session details";
  backButton.setAttribute("aria-label", backButton.title);
  backButton.hidden = true;
  setIcon(backButton, "arrow-left");
  const headerCopy = el("div", "sessionInfoHeaderCopy");
  const eyebrow = el("span", "sessionInfoEyebrow", "Session");
  const heading = el("h2", undefined, "Session details");
  heading.id = "sessionInfoHeading";
  heading.tabIndex = -1;
  const headerSubtitle = el("p", undefined, "Usage, workspace, tools, and context");
  headerCopy.append(eyebrow, heading, headerSubtitle);
  const closeButton = el("button", "iconButton webPanelClose");
  closeButton.id = "sessionInfoCloseButton";
  closeButton.type = "button";
  closeButton.title = "Close session details";
  closeButton.setAttribute("aria-label", closeButton.title);
  setIcon(closeButton, "x");
  header.append(backButton, headerCopy, closeButton);

  const content = el("div", "sessionInfoContent webPanelBody");
  const mainView = el("div", "sessionInfoMainView");
  const promptView = el("div", "sessionInfoPromptView");
  promptView.hidden = true;

  const sessionRow = el("section", "sessionInfoSessionRow");
  const sessionDot = el("span", "sessionInfoSessionDot");
  const sessionTitle = el("strong", "sessionInfoSessionTitle", "New session");
  sessionTitle.id = "sessionInfoTitle";
  const runtimeBadge = el("span", "sessionInfoRuntimeBadge", "Idle");
  runtimeBadge.id = "sessionInfoRuntimeBadge";
  sessionRow.append(sessionDot, sessionTitle, runtimeBadge);

  const statsLine = el("section", "sessionInfoStatsLine");
  statsLine.id = "sessionInfoStatsLine";
  const statValues = new Map<string, HTMLElement>();
  for (const [key, label] of [["cost", "cost"], ["tokens", "tokens"], ["tools", "tools"], ["elapsed", "elapsed"]] as const) {
    const item = el("span", "sessionInfoStat");
    const value = el("strong", undefined, "—");
    value.id = `sessionInfo${key[0].toUpperCase()}${key.slice(1)}Value`;
    statValues.set(key, value);
    item.append(value, el("small", undefined, label));
    statsLine.append(item);
  }

  function sectionHeader(title: string, subtitle: string, action?: HTMLButtonElement) {
    const header = el("header", "sessionInfoSectionHeader");
    const copy = el("div");
    copy.append(el("h3", undefined, title), el("p", undefined, subtitle));
    header.append(copy);
    if (action) header.append(action);
    return header;
  }

  const workspaceSection = el("section", "sessionInfoSection");
  const openGitButton = el("button", "sessionInfoSectionAction", "Open Git");
  openGitButton.type = "button";
  workspaceSection.append(sectionHeader("Workspace", "Repository health without a file-by-file diff", openGitButton));
  const workspaceCard = el("article", "sessionInfoWorkspaceCard");
  workspaceCard.id = "sessionInfoGit";
  workspaceCard.tabIndex = 0;
  workspaceCard.setAttribute("role", "button");
  workspaceCard.setAttribute("aria-label", "Open source control");
  const repoHead = el("div", "sessionInfoRepoHead");
  const repoMark = el("span", "sessionInfoRepoMark");
  repoMark.append(iconElement("git-branch"));
  const repoCopy = el("span", "sessionInfoRepoCopy");
  const repoBranch = el("strong", undefined, "Loading…");
  const repoState = el("small", undefined, "Reading working tree");
  repoCopy.append(repoBranch, repoState);
  const repoHealth = el("span", "sessionInfoHealthBadge", "Loading");
  repoHead.append(repoMark, repoCopy, repoHealth);
  const repoGrid = el("div", "sessionInfoRepoGrid");
  const repoValues = new Map<string, HTMLElement>();
  for (const [key, label] of [["staged", "Staged"], ["unstaged", "Unstaged"], ["untracked", "Untracked"], ["diff", "Diff"], ["upstream", "Upstream"], ["conflicts", "Conflicts"]] as const) {
    const cell = el("span", "sessionInfoRepoCell");
    const value = el("strong", undefined, "—");
    value.id = `sessionInfoGit${key[0].toUpperCase()}${key.slice(1)}`;
    repoValues.set(key, value);
    cell.append(el("small", undefined, label), value);
    repoGrid.append(cell);
  }
  const gitSummary = el("span", "sessionInfoRepoFoot", "Loading repository summary…");
  gitSummary.id = "sessionInfoGitCount";
  workspaceCard.append(repoHead, repoGrid, gitSummary);
  workspaceSection.append(workspaceCard);

  const toolsSection = el("section", "sessionInfoSection");
  const refreshContextButton = el("button", "sessionInfoSectionAction", "Refresh");
  refreshContextButton.type = "button";
  toolsSection.append(sectionHeader("Tool surface", "Active capabilities and where they came from", refreshContextButton));
  const toolTable = el("table", "sessionInfoToolTable");
  toolTable.innerHTML = "<thead><tr><th>Tool</th><th>Status</th><th>Calls</th><th>Scope</th></tr></thead>";
  const toolTableBody = el("tbody");
  toolTableBody.id = "sessionInfoToolTableBody";
  toolTable.append(toolTableBody);
  const toolNote = el("p", "sessionInfoCardNote", "Loading tool registry…");
  toolNote.id = "sessionInfoToolNote";
  toolsSection.append(toolTable, toolNote);

  const contextSection = el("section", "sessionInfoSection");
  const inspectPromptButton = el("button", "sessionInfoSectionAction", "Inspect prompt");
  inspectPromptButton.id = "sessionInfoInspectPrompt";
  inspectPromptButton.type = "button";
  inspectPromptButton.disabled = true;
  contextSection.append(sectionHeader("Context assembly", "What Pi puts in the system prompt and where it came from", inspectPromptButton));
  const contextStatus = el("div", "sessionInfoContextStatus");
  const promptSummary = el("div", "sessionInfoContextSummary");
  const promptSummaryCopy = el("span");
  promptSummaryCopy.append(el("strong", undefined, "Effective system prompt"));
  const promptSummaryDetail = el("small", undefined, "Loading current Pi prompt…");
  promptSummaryDetail.id = "sessionInfoPromptSummary";
  promptSummaryCopy.append(promptSummaryDetail);
  const promptBadge = el("span", "sessionInfoHealthBadge", "Loading");
  promptBadge.id = "sessionInfoPromptBadge";
  promptSummary.append(promptSummaryCopy, promptBadge);
  const resourceSummary = el("div", "sessionInfoContextSummary");
  const resourceSummaryCopy = el("span");
  resourceSummaryCopy.append(el("strong", undefined, "Skills and extensions"));
  const resourceSummaryDetail = el("small", undefined, "Loading resources…");
  resourceSummaryDetail.id = "sessionInfoResourceSummary";
  resourceSummaryCopy.append(resourceSummaryDetail);
  const resourceBadge = el("span", "sessionInfoHealthBadge", "Loading");
  resourceBadge.id = "sessionInfoResourceBadge";
  resourceSummary.append(resourceSummaryCopy, resourceBadge);
  contextStatus.append(promptSummary, resourceSummary);
  const resourceGroups = el("div", "sessionInfoResourceGroups");
  const skillsGroup = el("div", "sessionInfoResourceGroup");
  skillsGroup.append(el("h4", undefined, "Skills"));
  const skillsList = el("div", "sessionInfoResourceList");
  skillsList.id = "sessionInfoSkillsList";
  skillsGroup.append(skillsList);
  const extensionsGroup = el("div", "sessionInfoResourceGroup");
  extensionsGroup.append(el("h4", undefined, "Extensions"));
  const extensionsList = el("div", "sessionInfoResourceList");
  extensionsList.id = "sessionInfoExtensionsList";
  extensionsGroup.append(extensionsList);
  resourceGroups.append(skillsGroup, extensionsGroup);
  const contextNote = el("p", "sessionInfoCardNote", "Resolved for the current working directory.");
  contextNote.id = "sessionInfoContextNote";
  contextSection.append(contextStatus, resourceGroups, contextNote);

  const metadataSection = el("section", "sessionInfoSection");
  metadataSection.append(sectionHeader("Metadata", "Session-only facts not repeated in the header"));
  const details = el("dl", "sessionInfoDetails");
  const detailValues = new Map<string, HTMLElement>();
  for (const [key, label] of [["created", "Created"], ["modified", "Last active"], ["conversation", "Conversation"], ["queue", "Queue"]] as const) {
    const row = el("div");
    const value = el("dd", undefined, "—");
    value.id = `sessionInfo${key[0].toUpperCase()}${key.slice(1)}Detail`;
    detailValues.set(key, value);
    row.append(el("dt", undefined, label), value);
    details.append(row);
  }

  function copyAction(id: string, label: string) {
    const button = el("button", "sessionInfoMetadataAction");
    button.id = id;
    button.type = "button";
    const copy = el("span");
    const small = el("small", undefined, label);
    const value = el("strong", undefined, "—");
    copy.append(small, value);
    button.append(copy, iconElement("copy"));
    return { button, small, value };
  }

  const cwdAction = copyAction("sessionInfoCwd", "Working directory");
  const idAction = copyAction("sessionInfoId", "Session ID");
  metadataSection.append(details, cwdAction.button, idAction.button);

  mainView.append(sessionRow, statsLine, workspaceSection, toolsSection, contextSection, metadataSection);

  const promptHero = el("section", "sessionInfoPromptHero");
  const promptHeroCopy = el("div");
  promptHeroCopy.append(el("span", "sessionInfoEyebrow", "Current Pi effective prompt"));
  const promptHeroTitle = el("strong", undefined, "System prompt");
  const promptHeroMeta = el("small", undefined, "Not loaded");
  promptHeroMeta.id = "sessionInfoPromptMeta";
  promptHeroCopy.append(promptHeroTitle, promptHeroMeta);
  const copyPromptButton = el("button", "sessionInfoPrimaryAction", "Copy prompt");
  copyPromptButton.id = "sessionInfoCopyPrompt";
  copyPromptButton.type = "button";
  promptHero.append(promptHeroCopy, copyPromptButton);
  const fidelityNote = el("p", "sessionInfoFidelityNote", "This is Pi’s current effective system-prompt string. Source labels are a best-effort projection; unmatched text stays explicitly unattributed.");
  const provenanceBar = el("div", "sessionInfoProvenanceBar");
  const provenanceSummary = el("strong", undefined, "Provenance unavailable");
  provenanceSummary.id = "sessionInfoProvenanceSummary";
  const provenanceFilters = el("div", "sessionInfoProvenanceFilters");
  provenanceFilters.id = "sessionInfoProvenanceFilters";
  provenanceBar.append(provenanceSummary, provenanceFilters);
  const promptCode = el("div", "sessionInfoPromptCode");
  promptCode.id = "sessionInfoPromptCode";
  promptCode.tabIndex = 0;
  promptCode.setAttribute("aria-label", "Annotated effective system prompt");
  const sourcesSection = el("section", "sessionInfoPromptSources");
  sourcesSection.append(el("h3", undefined, "Loaded sources"));
  const sourcesList = el("div", "sessionInfoPromptSourceList");
  sourcesList.id = "sessionInfoPromptSourceList";
  sourcesSection.append(sourcesList);
  promptView.append(promptHero, fidelityNote, provenanceBar, promptCode, sourcesSection);

  content.append(mainView, promptView);
  panel.append(header, content);
  document.body.append(backdrop, panel);

  let panelHandle: RightPanelHandle | undefined;
  let renderedSessionId = "";
  let sessionContext: SessionContextDto | undefined;
  let contextRequest = 0;
  let lastRunning = false;

  function runtimePresentation() {
    const runtime = sessionRuntime(state);
    if (runtime.isCompacting) return { label: "Compacting", tone: "warning" };
    if (runtime.isRetrying) return { label: "Retrying", tone: "warning" };
    if (runtime.isRunning || runtime.isStreaming) return { label: "Active", tone: "active" };
    return { label: "Idle", tone: "neutral" };
  }

  function renderToolSurface(context?: SessionContextDto) {
    const configured = context?.tools?.configured || [];
    const activeNames = new Set(context?.tools?.activeNames || configured.filter((tool) => tool.active).map((tool) => tool.name));
    const callsByName = context?.tools?.callsByName || {};
    const ordered = [...configured].sort((a, b) => {
      const activeDifference = Number(activeNames.has(b.name)) - Number(activeNames.has(a.name));
      return activeDifference || toolSourceLabel(a).localeCompare(toolSourceLabel(b)) || a.name.localeCompare(b.name);
    });
    toolTableBody.replaceChildren();
    if (ordered.length === 0) {
      const row = el("tr");
      const cell = el("td", "sessionInfoEmptyCell", context ? "No tools configured" : "Loading tools…");
      cell.colSpan = 4;
      row.append(cell);
      toolTableBody.append(row);
    } else {
      for (const tool of ordered) {
        const enabled = activeNames.has(tool.name);
        const row = el("tr");
        row.dataset.enabled = String(enabled);
        const name = el("td", "sessionInfoToolName");
        name.append(el("strong", undefined, tool.name), el("small", undefined, toolSourceLabel(tool)));
        if (tool.description) name.title = tool.description;
        const status = el("td");
        const statusBadge = el("span", "sessionInfoToolStatus", enabled ? "Enabled" : "Disabled");
        statusBadge.dataset.enabled = String(enabled);
        status.append(statusBadge);
        const calls = el("td", undefined, String(finiteNumber(tool.callCount) || finiteNumber(callsByName[tool.name]) || 0));
        const scopeName = sourceScope(tool.sourceInfo);
        const scope = el("td");
        scope.append(el("span", `sessionInfoScope sessionInfoScope--${scopeName.toLowerCase()}`, scopeName));
        row.append(name, status, calls, scope);
        toolTableBody.append(row);
      }
    }
    const enabledCount = ordered.filter((tool) => activeNames.has(tool.name)).length;
    toolNote.textContent = context
      ? `${enabledCount} enabled · ${Math.max(0, configured.length - enabledCount)} disabled · ${configured.length} configured tool schemas.`
      : "Loading tool registry…";
  }

  function resourceItem(mark: string, title: string, description: string, scope: string) {
    const item = el("div", "sessionInfoResourceItem");
    item.append(el("span", "sessionInfoResourceMark", mark));
    const copy = el("span", "sessionInfoResourceCopy");
    copy.append(el("strong", undefined, title), el("small", undefined, description));
    item.append(copy, el("span", `sessionInfoScope sessionInfoScope--${scope.toLowerCase()}`, scope));
    return item;
  }

  function provenanceSourceKey(source: PromptProvenanceSource) {
    if (source.kind === "tool" && source.path?.startsWith("<builtin:")) return "tool:<builtin>";
    return `${source.kind}:${source.path || source.label}`;
  }

  function provenanceSourceLabel(source: PromptProvenanceSource) {
    if (source.kind === "tool" && source.path?.startsWith("<builtin:")) return "Built-in tools";
    if (source.kind === "tool" && source.path && !source.path.startsWith("<")) return extensionName(source.path);
    return source.label;
  }

  function renderPromptProvenance(context?: SessionContextDto) {
    const prompt = context?.systemPrompt || "";
    const projection = context?.provenance;
    promptCode.replaceChildren();
    provenanceFilters.replaceChildren();
    provenanceFilters.onclick = null;
    if (!prompt) {
      promptCode.append(el("div", "sessionInfoPromptEmpty", "System prompt unavailable."));
      provenanceSummary.textContent = "Provenance unavailable";
      return;
    }
    if (!projection?.spans?.length) {
      const plain = el("div", "sessionInfoPromptPlain", prompt);
      promptCode.append(plain);
      provenanceSummary.textContent = "Provenance unavailable";
      return;
    }

    const known = projection.coverage.exact + projection.coverage.derived;
    const coverage = projection.coverage.total ? Math.round(known / projection.coverage.total * 100) : 0;
    provenanceSummary.textContent = `${coverage}% attributed · ${projection.coverage.unknown.toLocaleString()} unknown characters`;
    const sources = new Map<string, PromptProvenanceSource>();
    for (const span of projection.spans) sources.set(provenanceSourceKey(span.source), span.source);

    const filterButton = (label: string, key: string) => {
      const button = el("button", "sessionInfoProvenanceFilter", label);
      button.type = "button";
      button.dataset.source = key;
      button.title = key === "all" ? "Show every prompt line" : sources.get(key)?.path || sources.get(key)?.label || label;
      return button;
    };
    const allButton = filterButton("All", "all");
    allButton.dataset.active = "true";
    provenanceFilters.append(allButton);
    for (const [key, source] of sources) provenanceFilters.append(filterButton(provenanceSourceLabel(source), key));

    const lines: Array<{ number: number; text: string; key: string; source: PromptProvenanceSource; confidence: PromptProvenanceSpan["confidence"] }> = [];
    let offset = 0;
    for (const [index, text] of prompt.split("\n").entries()) {
      const start = offset;
      const end = start + text.length;
      const relevant = projection.spans.filter((span) => span.start < end + 1 && span.end > start);
      const primary = relevant.sort((a, b) => {
        const overlap = (span: PromptProvenanceSpan) => Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
        return overlap(b) - overlap(a) || (a.confidence === "unknown" ? 1 : -1);
      })[0] || { source: { kind: "unknown", label: "Unattributed" } as PromptProvenanceSource, confidence: "unknown" as const };
      lines.push({ number: index + 1, text, key: provenanceSourceKey(primary.source), source: primary.source, confidence: primary.confidence });
      offset = end + 1;
    }
    // Blank separators belong visually to the preceding source block instead of
    // creating their own one-line provenance groups.
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].text || index === 0) continue;
      const neighbor = lines[index - 1] || lines[index + 1];
      if (neighbor) Object.assign(lines[index], { key: neighbor.key, source: neighbor.source, confidence: neighbor.confidence });
    }
    const groups: Array<{ key: string; source: PromptProvenanceSource; confidence: PromptProvenanceSpan["confidence"]; lines: typeof lines }> = [];
    for (const line of lines) {
      const current = groups.at(-1);
      if (current?.key === line.key && current.confidence === line.confidence) current.lines.push(line);
      else groups.push({ key: line.key, source: line.source, confidence: line.confidence, lines: [line] });
    }
    for (const group of groups) {
      const block = el("section", "sessionInfoPromptGroup");
      block.dataset.source = group.key;
      block.dataset.confidence = group.confidence;
      const groupHeader = el("header", "sessionInfoPromptGroupHeader");
      const label = el("strong", undefined, provenanceSourceLabel(group.source));
      label.dataset.kind = group.source.kind;
      label.title = group.source.path || group.source.label;
      const first = group.lines[0].number;
      const last = group.lines.at(-1)!.number;
      groupHeader.append(label, el("span", undefined, `${first === last ? "Line" : "Lines"} ${first === last ? first : `${first}–${last}`} · ${group.confidence}`));
      const body = el("div", "sessionInfoPromptGroupBody");
      for (const line of group.lines) {
        const row = el("div", "sessionInfoPromptLine");
        row.append(el("span", "sessionInfoPromptLineNumber", String(line.number)), el("code", line.text ? undefined : "sessionInfoPromptBlank", line.text || "↵"));
        body.append(row);
      }
      block.append(groupHeader, body);
      promptCode.append(block);
    }

    provenanceFilters.onclick = (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-source]");
      if (!button) return;
      const selected = button.dataset.source || "all";
      for (const candidate of provenanceFilters.querySelectorAll<HTMLButtonElement>("button")) candidate.dataset.active = String(candidate === button);
      for (const group of promptCode.querySelectorAll<HTMLElement>(".sessionInfoPromptGroup")) group.hidden = selected !== "all" && group.dataset.source !== selected;
    };
  }

  function renderContext(context?: SessionContextDto) {
    renderToolSurface(context);
    const prompt = context?.systemPrompt || "";
    const skills = context?.resources?.skills || [];
    const extensions = context?.resources?.extensions || [];
    const errors = (context?.resources?.diagnostics?.length || 0) + (context?.resources?.extensionErrors?.length || 0);
    const estimatedTokens = prompt ? Math.ceil(prompt.length / 4) : 0;
    promptSummaryDetail.textContent = context
      ? `${compactNumber(estimatedTokens)} estimated tokens · ${prompt.length.toLocaleString()} characters`
      : "Loading current Pi prompt…";
    promptBadge.textContent = context ? "Current" : "Loading";
    promptBadge.dataset.tone = context ? "healthy" : "neutral";
    inspectPromptButton.disabled = !prompt;
    resourceSummaryDetail.textContent = context
      ? `${skills.length} ${skills.length === 1 ? "skill" : "skills"} · ${extensions.length} ${extensions.length === 1 ? "extension" : "extensions"}`
      : "Loading resources…";
    resourceBadge.textContent = context ? errors ? `${errors} issues` : "Healthy" : "Loading";
    resourceBadge.dataset.tone = context && errors ? "warning" : context ? "healthy" : "neutral";

    skillsList.replaceChildren();
    if (!context) skillsList.append(el("span", "sessionInfoEmptyResource", "Loading…"));
    else if (skills.length === 0) skillsList.append(el("span", "sessionInfoEmptyResource", "No skills loaded"));
    else for (const skill of skills) {
      skillsList.append(resourceItem("S", skill.name, skill.description || baseName(skill.filePath || "Skill"), sourceScope(skill.sourceInfo)));
    }

    extensionsList.replaceChildren();
    if (!context) extensionsList.append(el("span", "sessionInfoEmptyResource", "Loading…"));
    else if (extensions.length === 0) extensionsList.append(el("span", "sessionInfoEmptyResource", "No extensions loaded"));
    else for (const extension of extensions) {
      const count = contributionCount(extension);
      extensionsList.append(resourceItem("E", extensionName(extension.path), count ? `${count} contributions` : "Loaded", sourceScope(extension.sourceInfo)));
    }

    const contextFiles = context?.resources?.contextFiles || [];
    contextNote.textContent = context
      ? `Resolved for ${state.currentCwd || "the current working directory"}. ${contextFiles.length} context ${contextFiles.length === 1 ? "file" : "files"} contribute to the assembled prompt.`
      : "Loading resources for the current working directory…";

    promptHeroMeta.textContent = context
      ? `${compactNumber(estimatedTokens)} estimated tokens · captured ${formatDate(context.capturedAt)}`
      : "Not loaded";
    renderPromptProvenance(context);
    sourcesList.replaceChildren();
    if (context?.provenance) {
      const grouped = new Map<string, { source: PromptProvenanceSource; exact: number; derived: number; unknown: number }>();
      for (const span of context.provenance.spans) {
        const key = provenanceSourceKey(span.source);
        const group = grouped.get(key) || { source: span.source, exact: 0, derived: 0, unknown: 0 };
        group[span.confidence] += span.end - span.start;
        grouped.set(key, group);
      }
      for (const { source, exact, derived, unknown } of grouped.values()) {
        const item = el("div", "sessionInfoPromptSource");
        const confidence = unknown ? "Unattributed" : derived && !exact ? "Derived" : "Exact";
        item.append(el("strong", undefined, `${provenanceSourceLabel(source)} · ${confidence}`), el("span", undefined, source.path || `${(exact + derived + unknown).toLocaleString()} characters`));
        sourcesList.append(item);
      }
    } else if (context) {
      sourcesList.append(el("div", "sessionInfoPromptSource", "Source projection unavailable"));
    }
  }

  function setPromptView(open: boolean) {
    mainView.hidden = open;
    promptView.hidden = !open;
    backButton.hidden = !open;
    eyebrow.textContent = open ? "Context assembly" : "Session";
    heading.textContent = open ? "System prompt" : "Session details";
    headerSubtitle.textContent = open ? "Exact current Pi effective prompt" : "Usage, workspace, tools, and context";
    if (open) promptCode.focus({ preventScroll: true });
  }

  function update() {
    const view = activeSessionState(state);
    const stats = view?.stats;
    const runtime = runtimePresentation();
    const sessionId = state.currentSessionId;
    if (sessionId !== renderedSessionId) {
      renderedSessionId = sessionId;
      sessionContext = undefined;
      setPromptView(false);
      renderContext();
      gitSummary.textContent = "Loading repository summary…";
      if (panelHandle?.isOpen()) {
        void refreshGit();
        void refreshContext();
      }
    }

    sessionTitle.textContent = view?.name?.trim() || view?.title?.trim() || "New session";
    runtimeBadge.textContent = runtime.label;
    runtimeBadge.dataset.tone = runtime.tone;
    statValues.get("cost")!.textContent = formatCost(stats?.cost);
    statValues.get("tokens")!.textContent = compactNumber(stats?.tokens?.total);
    statValues.get("tools")!.textContent = compactNumber(stats?.toolResults);
    statValues.get("elapsed")!.textContent = elapsedTime(view?.created);
    detailValues.get("created")!.textContent = formatDate(view?.created);
    detailValues.get("modified")!.textContent = formatDate(view?.modified);
    const messages = finiteNumber(stats?.totalMessages) ?? finiteNumber(view?.messageCount);
    detailValues.get("conversation")!.textContent = messages === undefined ? "—" : `${Math.round(messages)} messages`;
    const queued = (view?.queue?.steering.length || 0) + (view?.queue?.followUp.length || 0);
    detailValues.get("queue")!.textContent = queued ? `${queued} pending` : "Empty";
    cwdAction.value.textContent = state.currentCwd || "Not set";
    idAction.value.textContent = sessionId || "Not started";

    const running = sessionRuntime(state).isRunning || sessionRuntime(state).isStreaming;
    if (running !== lastRunning) {
      lastRunning = running;
      if (panelHandle?.isOpen()) window.setTimeout(() => void refreshContext(), running ? 100 : 0);
    }
  }

  async function refreshGit() {
    const sessionId = state.currentSessionId;
    repoBranch.textContent = "Loading…";
    repoState.textContent = "Reading working tree";
    repoHealth.textContent = "Loading";
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const response = await fetch(`/api/git/status${query}`, { headers: apiHeaders() });
      const data = await response.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (sessionId !== state.currentSessionId) return;
      if (!response.ok) throw new Error(data.error || "Unable to read Git status");
      if (!data.isRepo) {
        repoBranch.textContent = "No repository";
        repoState.textContent = "Current working directory is not in Git";
        repoHealth.textContent = "Unavailable";
        for (const value of repoValues.values()) value.textContent = "—";
        gitSummary.textContent = "Git status is unavailable for this working directory.";
        return;
      }
      const files = data.files || [];
      const untracked = files.filter((file) => file.label === "untracked").length;
      const conflicts = files.filter((file) => file.label === "conflicted").length;
      const changed = files.length;
      const additions = (data.diffStats?.staged?.additions || 0) + (data.diffStats?.unstaged?.additions || 0);
      const deletions = (data.diffStats?.staged?.deletions || 0) + (data.diffStats?.unstaged?.deletions || 0);
      repoBranch.textContent = data.branch || "Repository";
      repoState.textContent = `${baseName(data.root || state.currentCwd)} · ${changed ? "working tree changed" : "working tree clean"}`;
      repoHealth.textContent = conflicts ? `${conflicts} conflicts` : changed ? "Changed" : "Clean";
      repoHealth.dataset.tone = conflicts ? "warning" : changed ? "neutral" : "healthy";
      repoValues.get("staged")!.textContent = `${data.diffStats?.staged?.files || 0} files`;
      repoValues.get("unstaged")!.textContent = `${data.diffStats?.unstaged?.files || 0} files`;
      repoValues.get("untracked")!.textContent = `${untracked} files`;
      repoValues.get("diff")!.innerHTML = `<span class="sessionInfoAdditions">+${additions}</span> <span class="sessionInfoDeletions">−${deletions}</span>`;
      repoValues.get("upstream")!.textContent = data.ahead || data.behind ? `↑${data.ahead || 0} ↓${data.behind || 0}` : "Even";
      repoValues.get("conflicts")!.textContent = String(conflicts);
      gitSummary.textContent = `${changed} changed ${changed === 1 ? "file" : "files"} · aggregate workspace state; session attribution is not guaranteed.`;
    } catch {
      if (sessionId === state.currentSessionId) {
        repoBranch.textContent = "Git unavailable";
        repoState.textContent = "Could not read repository status";
        repoHealth.textContent = "Unavailable";
        gitSummary.textContent = "Repository health could not be loaded.";
      }
    }
  }

  async function refreshContext() {
    const sessionId = state.currentSessionId;
    const request = ++contextRequest;
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/session/context?sessionId=${encodeURIComponent(sessionId)}`, { headers: apiHeaders() });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; context?: SessionContextDto } & Partial<SessionContextDto>;
      if (request !== contextRequest || sessionId !== state.currentSessionId) return;
      if (!response.ok || body.ok === false) throw new Error(body.error || "Unable to load session context");
      sessionContext = body.context || body as SessionContextDto;
      renderContext(sessionContext);
    } catch {
      if (request === contextRequest && sessionId === state.currentSessionId) {
        sessionContext = undefined;
        renderContext();
        promptSummaryDetail.textContent = "Current system prompt unavailable";
        promptBadge.textContent = "Unavailable";
        resourceSummaryDetail.textContent = "Session resources unavailable";
        resourceBadge.textContent = "Unavailable";
        toolNote.textContent = "Tool registry unavailable.";
      }
    }
  }

  async function handleCopy(value: string, label: HTMLElement, fallbackLabel: string) {
    if (!value) return;
    try {
      await copyText(value);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Copy failed";
    }
    window.setTimeout(() => { label.textContent = fallbackLabel; }, 1_200);
  }

  function closeAndOpenGit() {
    panelHandle?.close(false);
    openGit();
  }

  function init() {
    panelHandle = rightPanels.register({
      id: "session-info",
      side: "right",
      panel,
      backdrop,
      closeButton,
      width: "480px",
      minWidth: 320,
      maxWidth: 900,
      onBeforeOpen: () => {
        update();
        void Promise.allSettled([refreshGit(), refreshContext(), refreshSessions?.()]).then(update);
      },
      onBeforeClose: () => setPromptView(false),
      focusOnOpen: heading,
    });
    cwdAction.button.addEventListener("click", () => void handleCopy(state.currentCwd, cwdAction.small, "Working directory"));
    idAction.button.addEventListener("click", () => void handleCopy(state.currentSessionId, idAction.small, "Session ID"));
    workspaceCard.addEventListener("click", closeAndOpenGit);
    workspaceCard.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      closeAndOpenGit();
    });
    openGitButton.addEventListener("click", closeAndOpenGit);
    refreshContextButton.addEventListener("click", () => void refreshContext());
    inspectPromptButton.addEventListener("click", () => setPromptView(true));
    backButton.addEventListener("click", () => setPromptView(false));
    copyPromptButton.addEventListener("click", () => void handleCopy(sessionContext?.systemPrompt || "", copyPromptButton, "Copy prompt"));
    update();
    renderContext();
  }

  return {
    init,
    open: () => panelHandle?.open(),
    update,
    isOpen: () => panelHandle?.isOpen() || false,
  };
}
