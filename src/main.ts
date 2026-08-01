import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "./files/files.css";
import "./files/artifacts.css";
import "./styles/appLayout.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { initSwAutoReload } from "./app/sw-update.js";
import { setIcon } from "./app/icons.js";
import { initKeyboardShortcuts } from "./app/shortcuts.js";
import { createRightPanelManager } from "./layout/rightPanel.js";
import { createAppState, readActiveSessionIdFromHistoryState, readActiveSessionIdFromUrl, syncActiveSessionIdHistoryState } from "./app/types.js";
import {
  activeSessionState,
  activeSessionStats,
  mergeSessionInfo,
  patchSessionRuntime,
  reduceSessionSnapshot,
  removeSessionState,
  replaceSessionRuntime,
  selectSession,
  sessionRuntime,
  setSessionStats,
  type ApplySessionSnapshotOptions,
  type RuntimeActivityUpdate,
  type SessionRuntimeTransition,
  type SessionStateController,
} from "./app/sessionState.js";
import { createComposer, type ComposerController } from "./composer/composer.js";
import { initActionLauncher } from "./app/actionLauncher.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { createWebHeaderActions } from "./extensions/webHeaderActions.js";
import { renderWebFooters } from "./extensions/webFooter.js";
import { initGitPanel, type GitPanelController } from "./git/panel.js";
import { initFilesPanel, type FilesPanelController } from "./files/panel.js";
import { configureArtifactPreviewActions, createMarkdownRenderer, setArtifactPreviewActions } from "./markdown/render.js";
import { createMessageList, type MessageActionContext, type MessageList } from "./messages/messageList.js";
import { createModelSettings, modelKey, modelLabel, type ModelSettings } from "./models/modelSettings.js";
import { createRealtime, type RealtimeController } from "./realtime/realtime.js";
import { createSessions, type SessionsController } from "./sessions/sessionDrawer.js";
import { createSettings, type SettingsController } from "./settings/settings.js";
import { createStatusBar, type StatusBar } from "./status/statusBar.js";
import { createToolCards } from "./tools/toolCards.js";
import { createConversationTree, type ConversationTreeController } from "./tree/conversationTree.js";

initAppHeightSync();
initSwAutoReload();

const elements = getAppElements();
const state = createAppState();
const rightPanels = createRightPanelManager();
const api = createApiClient(state);
configureArtifactPreviewActions({ headers: api.headers, getSessionId: () => state.currentSessionId });
const markdown = createMarkdownRenderer(elements.messagesEl);

let messages: MessageList;
let composer: ComposerController;
let contextMeter: ContextMeterController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;
let gitPanel: GitPanelController;
let filesPanel: FilesPanelController;
let realtime: RealtimeController;
async function submitPromptFromMessageAction(message: string) {
  const promptText = message.trim();
  if (!promptText) throw new Error("Message is empty.");

  const sessionId = state.currentSessionId;
  const runtimeTransition = sessionState.patchRuntime(sessionId, {
    loaded: true,
    isStreaming: true,
    isRetrying: false,
  }, { kind: "start", label: "starting" });
  messages.beginStreamFollow();
  const clientMessageId = crypto.randomUUID?.() || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  composer.trackOptimisticUserMessage(clientMessageId);
  messages.addMessage("user", promptText);

  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId, clientMessageId, message: promptText, mode: state.queueMode, images: [] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
  } catch (error) {
    composer.discardOptimisticUserMessage(clientMessageId);
    sessionState.replaceRuntime(sessionId, runtimeTransition.previous);
    messages.endStreamFollow();
    throw error;
  }
}

async function navigateMessageActionTarget(context: MessageActionContext) {
  const runtime = sessionRuntime(state);
  if (runtime.isStreaming || runtime.isRetrying) throw new Error("Wait for the current response to finish first.");
  if (runtime.isCompacting) throw new Error("Wait for compaction to finish first.");

  const res = await fetch("/api/session/tree/navigate", {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify({ sessionId: state.currentSessionId, targetId: context.entryId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
  if (data.cancelled) return data;

  if (data.state) sessionState.applySnapshot(data.state);
  await refreshMessages();
  if (conversationTree?.isOpen()) await conversationTree.refreshTree().catch(() => undefined);
  return data;
}

async function handleMessageAction(context: MessageActionContext) {
  try {
    const data = await navigateMessageActionTarget(context);
    if (data?.cancelled) return;

    if (context.action === "edit") {
      composer.setPromptText(typeof data.editorText === "string" ? data.editorText : context.text);
      messages.addMessage("system", "Loaded an earlier prompt — edit and send to create a new branch.");
      return;
    }

    if (context.action === "rerun") {
      await submitPromptFromMessageAction(typeof data.editorText === "string" ? data.editorText : context.text);
    }
  } catch (error) {
    showSystemError(error);
  }
}

messages = createMessageList({ messagesEl: elements.messagesEl, markdown, onMessageAction: handleMessageAction });
const tools = createToolCards(elements.messagesEl, messages.scrollToBottom, api.headers);

const webHeaderActions = createWebHeaderActions({
  container: elements.headerActionsEl,
  headers: api.headers,
  getSessionId: () => state.currentSessionId,
  markdown,
});

function setSessionInfoOpen(open: boolean) {
  elements.sessionInfoPopover.hidden = !open;
  elements.sessionInfoButton.setAttribute("aria-expanded", String(open));
}

async function copySessionInfo(value: string, button: HTMLButtonElement) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  const label = button.querySelector("small");
  const previous = label?.textContent;
  if (label) label.textContent = "Copied";
  window.setTimeout(() => { if (label) label.textContent = previous || ""; }, 1200);
}

elements.sessionInfoButton.addEventListener("click", () => setSessionInfoOpen(elements.sessionInfoPopover.hidden));
elements.sessionInfoId.addEventListener("click", () => void copySessionInfo(state.currentSessionId, elements.sessionInfoId));
elements.sessionInfoCwd.addEventListener("click", () => void copySessionInfo(state.currentCwd, elements.sessionInfoCwd));
elements.sessionInfoGit.addEventListener("click", () => { setSessionInfoOpen(false); elements.gitButton.click(); });
document.addEventListener("pointerdown", (event) => {
  if (!elements.sessionInfoPopover.hidden && !elements.sessionInfoPopover.contains(event.target as Node) && !elements.sessionInfoButton.contains(event.target as Node)) setSessionInfoOpen(false);
});

async function refreshSessionGitCount() {
  const sessionId = state.currentSessionId;
  try {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/git/status${query}`, { headers: api.headers() });
    const data = await res.json();
    if (sessionId !== state.currentSessionId) return;
    const stats = data.diffStats as { staged?: { files?: number; additions?: number; deletions?: number }; unstaged?: { files?: number; additions?: number; deletions?: number } } | undefined;
    elements.sessionInfoGitCount.textContent = "";
    for (const [label, values] of [["Staged", stats?.staged], ["Unstaged", stats?.unstaged]] as const) {
      const group = document.createElement("span");
      group.className = "sessionInfoDiffGroup";
      const name = document.createElement("span");
      name.className = "sessionInfoDiffLabel";
      name.textContent = `${label} ${values?.files || 0}`;
      const added = document.createElement("span");
      added.className = "sessionInfoAdditions";
      added.textContent = `+${values?.additions || 0}`;
      const deleted = document.createElement("span");
      deleted.className = "sessionInfoDeletions";
      deleted.textContent = `−${values?.deletions || 0}`;
      group.append(name, added, deleted);
      elements.sessionInfoGitCount.append(group);
    }
  } catch { if (sessionId === state.currentSessionId) elements.sessionInfoGitCount.textContent = "—"; }
}

function showSystemError(error: unknown) {
  messages.addMessage("system", error instanceof Error ? error.message : String(error), "error");
}

function runtimeLabel(runtime = sessionRuntime(state)) {
  return runtime.isCompacting ? "compacting" : runtime.isRetrying ? "retrying" : "active";
}

function renderRuntimeActivity(
  runtime = sessionRuntime(state),
  previous: SessionRuntimeTransition["previous"] | undefined,
  activity: RuntimeActivityUpdate = { kind: "sync" },
) {
  if (!statusBar || activity.kind === "preserve") return;
  if (activity.kind === "start") {
    statusBar.markActivityStart(activity.label || runtimeLabel(runtime), activity.startedAt || runtime.startedAt, activity.lastActivityAt || runtime.lastActivityAt);
    return;
  }
  if (activity.kind === "progress") {
    statusBar.markActivityProgress(activity.label, activity.lastActivityAt || runtime.lastActivityAt);
    return;
  }
  if (activity.kind === "end") {
    statusBar.markActivityEnd();
    return;
  }
  if (!runtime.isRunning) {
    statusBar.markActivityEnd();
    return;
  }
  if (previous?.isRunning) statusBar.markActivityProgress(undefined, runtime.lastActivityAt);
  else statusBar.markActivityStart(runtimeLabel(runtime), runtime.startedAt, runtime.lastActivityAt);
}

function renderActiveSessionRuntime(
  activity: RuntimeActivityUpdate = { kind: "sync" },
  previous?: SessionRuntimeTransition["previous"],
) {
  const view = activeSessionState(state);
  const runtime = sessionRuntime(state);
  composer?.updatePendingQueue(view?.queue?.steering, view?.queue?.followUp);
  composer?.updatePrimaryAction();
  contextMeter?.update({ stats: view?.stats, isCompacting: runtime.isCompacting });
  renderRuntimeActivity(runtime, previous, activity);
}

function renderActiveSessionMetadata() {
  const view = activeSessionState(state);
  state.currentModelKey = modelKey(view?.model);
  state.currentModelDisplay = view?.model ? modelLabel(view.model) : "";
  state.currentThinkingLevel = view?.thinkingLevel || "off";
  state.currentCwd = view?.cwd || "";
  filesPanel?.sessionChanged();

  renderWebFooters(elements.extensionFooterEl, view?.webFooters ?? []);
  webHeaderActions.render(view?.webHeaderActions ?? []);
  setArtifactPreviewActions(view?.webArtifactActions ?? []);
  gitPanel?.setExtensionTabs(view?.webGitTabs ?? []);
  statusBar?.setStatusTitle(view?.name?.trim() || view?.title?.trim() || "New session");
  elements.statusPathEl.textContent = state.currentCwd;
  const idValue = elements.sessionInfoId.querySelector("strong");
  const cwdValue = elements.sessionInfoCwd.querySelector("strong");
  if (idValue) idValue.textContent = state.currentSessionId || "Not started";
  if (cwdValue) cwdValue.textContent = state.currentCwd || "Not set";
  void refreshSessionGitCount();
  modelSettings?.updateSummary();
  sessions?.renderSessionBar();
  sessions?.renderCurrentSessionBucketButton();
}

function renderActiveSession(
  activity: RuntimeActivityUpdate = { kind: "sync" },
  previous?: SessionRuntimeTransition["previous"],
) {
  renderActiveSessionMetadata();
  renderActiveSessionRuntime(activity, previous);
}

function activateSession(sessionId: string) {
  selectSession(state, sessionId);
  syncActiveSessionIdHistoryState(sessionId);
  renderActiveSession();
}

function runtimePresentationChanged(
  previous: SessionRuntimeTransition["previous"],
  next: SessionRuntimeTransition["next"],
) {
  return previous.loaded !== next.loaded
    || previous.isRunning !== next.isRunning
    || previous.isStreaming !== next.isStreaming
    || previous.isRetrying !== next.isRetrying
    || previous.isCompacting !== next.isCompacting;
}

function applySessionSnapshot(value: unknown, options: ApplySessionSnapshotOptions = {}) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const requestedId = typeof data?.sessionId === "string" && data.sessionId.trim() ? data.sessionId : state.currentSessionId;
  const previous = requestedId ? sessionRuntime(state, requestedId) : undefined;
  const view = reduceSessionSnapshot(state, value);
  if (!view) return undefined;

  const activatesSession = Boolean(options.activate || !state.currentSessionId);
  if (activatesSession) {
    selectSession(state, view.id);
    syncActiveSessionIdHistoryState(view.id);
  }
  if (data && "sessionUiState" in data) sessions?.applySessionUiState(data.sessionUiState);

  const includesRuntime = Boolean(data && ["runtime", "isStreaming", "isRetrying", "isCompacting"].some((key) => key in data));
  if (includesRuntime && previous && view.runtime && runtimePresentationChanged(previous, view.runtime)) {
    sessions?.updateSessionRuntime(view.id, view.runtime);
  }
  if (view.id !== state.currentSessionId) return view;

  const includesRuntimeView = Boolean(data && ["runtime", "isStreaming", "isRetrying", "isCompacting", "stats", "queue"].some((key) => key in data));
  const includesMetadataView = Boolean(data && [
    "cwd", "model", "thinkingLevel", "sessionName", "sessionTitle",
    "webFooters", "webHeaderActions", "webArtifactActions", "webGitTabs",
  ].some((key) => key in data));
  if (activatesSession || includesMetadataView) renderActiveSessionMetadata();
  if (activatesSession || includesRuntimeView) {
    renderActiveSessionRuntime(options.activity || (includesRuntime ? { kind: "sync" } : { kind: "preserve" }), previous);
  }
  return view;
}

function emptyRuntimeTransition(sessionId: string): SessionRuntimeTransition {
  const previous = sessionRuntime(state, sessionId);
  return { sessionId, previous, next: previous, isActive: false };
}

function applyRuntimeTransition(transition: SessionRuntimeTransition, activity: RuntimeActivityUpdate = { kind: "sync" }) {
  if (!transition.sessionId) return transition;
  if (runtimePresentationChanged(transition.previous, transition.next)) {
    sessions?.updateSessionRuntime(transition.sessionId, transition.next);
  }
  if (transition.isActive) renderActiveSessionRuntime(activity, transition.previous);
  return transition;
}

const sessionState: SessionStateController = {
  activate: activateSession,
  applySnapshot: applySessionSnapshot,
  mergeSessionInfo: (session) => mergeSessionInfo(state, session),
  patchRuntime: (sessionId, patch, activity = { kind: "sync" }) => {
    const id = sessionId || state.currentSessionId;
    return id ? applyRuntimeTransition(patchSessionRuntime(state, id, patch), activity) : emptyRuntimeTransition("");
  },
  replaceRuntime: (sessionId, runtime, activity = { kind: "sync" }) => {
    const id = sessionId || state.currentSessionId;
    return id ? applyRuntimeTransition(replaceSessionRuntime(state, id, runtime), activity) : emptyRuntimeTransition("");
  },
  updateStats: (sessionId, stats) => {
    const id = sessionId || state.currentSessionId;
    if (!id) return;
    setSessionStats(state, id, stats);
    if (id === state.currentSessionId) contextMeter?.update({ stats: activeSessionStats(state), isCompacting: sessionRuntime(state).isCompacting });
  },
  remove: (sessionId) => removeSessionState(state, sessionId),
};

async function refreshMessages() {
  const runtime = sessionRuntime(state);
  await messages.refreshMessages({
    sessionId: state.currentSessionId,
    headers: api.headers,
    addToolHistoryCard: tools.addToolHistoryCard,
    addPendingToolCard: tools.startTool,
    addRuntimeErrorCard: tools.addRuntimeErrorCard,
    clearActiveToolCards: tools.clearActiveToolCards,
    isStreaming: runtime.isStreaming || runtime.isRetrying,
    updateEmptyCwdChooser: () => sessions.finishTranscriptLoading(),
    onTranscriptRuntimeState: (transcriptState) => realtime?.applyTranscriptRuntimeState(transcriptState),
  });
}

async function refreshState() {
  const requestedSessionId = state.currentSessionId;
  const query = requestedSessionId ? `?sessionId=${encodeURIComponent(requestedSessionId)}` : "";
  const res = await fetch(`/api/state${query}`, { headers: api.headers() });
  if (res.status === 401) {
    elements.tokenOverlay.hidden = false;
    elements.tokenInput.focus();
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  if (requestedSessionId && requestedSessionId !== state.currentSessionId) {
    sessionState.applySnapshot(data);
    return;
  }
  sessionState.applySnapshot(data, { activate: true });
  const [settingsResult, modelsResult, messagesResult] = await Promise.allSettled([
    settings.refreshSettings(),
    modelSettings.refreshModels(),
    refreshMessages(),
  ]);
  for (const result of [settingsResult, modelsResult, messagesResult]) {
    if (result.status === "rejected") messages.addMessage("system", result.reason instanceof Error ? result.reason.message : String(result.reason), "error");
  }
  state.initialSyncComplete = messagesResult.status === "fulfilled";
  if (messagesResult.status === "fulfilled") sessions.markSessionRead().catch((error) => messages.addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  composer.updatePrimaryAction();
}

function initStaticIcons() {
  setIcon(elements.sessionButton, "menu");
  setIcon(elements.newSessionHeaderButton, "square-pen");
  setIcon(elements.conversationTreeButton, "git-fork");
  setIcon(elements.filesButton, "folder-tree");
  setIcon(elements.attachButton, "paperclip");
  setIcon(elements.primaryButton, "send-horizontal");
  setIcon(elements.expandButton, "maximize-2");
  setIcon(elements.gitButton, "git-branch");
  setIcon(elements.sessionInfoButton, "info");
  setIcon(elements.currentSessionBucketButton, "flag");
  setIcon(elements.settingsButton, "settings");
  setIcon(elements.stopButton, "square");
}

modelSettings = createModelSettings({
  state,
  elements,
  api,
  sessionState,
  addMessage: messages.addMessage,
});

statusBar = createStatusBar({
  state,
  elements,
  api,
  sessionState,
  addMessage: messages.addMessage,
  refreshSessions: () => sessions.refreshSessions(),
  refreshState,
});

settings = createSettings({
  state,
  elements,
  api,
  rightPanels,
  addMessage: messages.addMessage,
});

contextMeter = createContextMeter({ elements });

sessions = createSessions({
  state,
  elements,
  api,
  rightPanels,
  sessionState,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  refreshSessionTitle: () => statusBar.refreshSessionTitle(),
  clearMessages: () => {
    tools.clearActiveToolCards();
    messages.clear();
  },
  addMessage: messages.addMessage,
});

composer = createComposer({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
  addToolHistoryCard: tools.addToolHistoryCard,
  sessionState,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  beginTranscriptLoading: () => sessions.beginTranscriptLoading(),
  beginStreamFollow: messages.beginStreamFollow,
  endStreamFollow: messages.endStreamFollow,
});

conversationTree = createConversationTree({
  state,
  elements,
  api,
  rightPanels,
  composer,
  sessionState,
  refreshMessages,
  addMessage: messages.addMessage,
});

realtime = createRealtime({
  state,
  elements,
  api,
  composer,
  messages,
  models: modelSettings,
  sessions,
  status: statusBar,
  tools,
  settings,
  conversationTree,
  sessionState,
  refreshMessages,
  refreshState,
  addMessage: messages.addMessage,
});

initStaticIcons();
initActionLauncher(elements);
statusBar.init();
sessions.init();
contextMeter.init();
composer.init();
conversationTree.init();
modelSettings.init();
settings.init();
initKeyboardShortcuts([
  {
    id: "sessions.toggleDrawer",
    key: "b",
    scope: "global",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => sessions.setSessionDrawerOpen(elements.sessionDrawer.hidden),
  },
  {
    id: "session.stopFromPrompt",
    key: "Escape",
    scope: "composer",
    allowInEditable: true,
    when: () => {
      const runtime = sessionRuntime(state);
      return elements.tokenOverlay.hidden
        && elements.slashCommandsEl.hidden
        && (runtime.isStreaming || runtime.isRetrying);
    },
    run: () => composer.stopStreaming(),
  },
], {
  getScopes: () => {
    const scopes: string[] = [];
    if (!elements.tokenOverlay.hidden) scopes.push("token");
    if (!elements.settingsPanel.hidden) scopes.push("settings");
    if (!elements.modelSettingsPopover.hidden) scopes.push("modelSettings");
    if (conversationTree.isOpen()) scopes.push("conversationTree");
    if (document.activeElement === elements.promptEl) scopes.push("composer");
    if (!elements.sessionDrawer.hidden) scopes.push("sessions");
    if (!elements.gitPanel.hidden) scopes.push("git");
    if (!elements.filesPanel.hidden) scopes.push("files");
    return scopes;
  },
  onError: showSystemError,
});
composer.updateQueueToggle();
filesPanel = initFilesPanel({
  button: elements.filesButton,
  panel: elements.filesPanel,
  rightPanels,
  apiHeaders: api.headers,
  getSessionId: () => state.currentSessionId,
  onError: showSystemError,
});
gitPanel = initGitPanel({
  button: elements.gitButton,
  panel: elements.gitPanel,
  rightPanels,
  apiHeaders: api.headers,
  getSessionId: () => state.currentSessionId,
  onComposerContext: (context) => composer.addContextAttachment(context),
});
window.addEventListener("popstate", (event) => {
  const nextSessionId = readActiveSessionIdFromHistoryState(event.state) ?? readActiveSessionIdFromUrl();
  if (nextSessionId === state.currentSessionId) return;
  sessionState.activate(nextSessionId);
  tools.clearActiveToolCards();
  sessions.beginTranscriptLoading();
  messages.clear();
  sessions.renderSessionBar();
  sessions.refreshSessions().catch(() => undefined);
  refreshState().catch(showSystemError);
});
composer.updatePrimaryAction();
refreshState().catch(showSystemError);
realtime.connect();
