import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { initSwAutoReload } from "./app/sw-update.js";
import { setIcon } from "./app/icons.js";
import { initKeyboardShortcuts } from "./app/shortcuts.js";
import { createAppState, readActiveSessionIdFromUrl } from "./app/types.js";
import { createComposer, type ComposerController } from "./composer/composer.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { renderWebFooters } from "./extensions/webFooter.js";
import { initGitPanel } from "./git/panel.js";
import { createMarkdownRenderer } from "./markdown/render.js";
import { createMessageList } from "./messages/messageList.js";
import { createModelSettings, modelKey, modelLabel, type ModelSettings } from "./models/modelSettings.js";
import { createRealtime } from "./realtime/realtime.js";
import { createSessions, type SessionsController } from "./sessions/sessionDrawer.js";
import { createSettings, type SettingsController } from "./settings/settings.js";
import { createStatusBar, type StatusBar } from "./status/statusBar.js";
import { createToolCards } from "./tools/toolCards.js";
import { createConversationTree, type ConversationTreeController } from "./tree/conversationTree.js";

initAppHeightSync();
initSwAutoReload();

const elements = getAppElements();
const state = createAppState();
const api = createApiClient(state);
const markdown = createMarkdownRenderer(elements.messagesEl);
const messages = createMessageList({ messagesEl: elements.messagesEl, markdown });
const tools = createToolCards(elements.messagesEl, messages.scrollToBottom);

let composer: ComposerController;
let contextMeter: ContextMeterController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;

function showSystemError(error: unknown) {
  messages.addMessage("system", error instanceof Error ? error.message : String(error), "error");
}

function updateMeta(data: any) {
  state.currentModelKey = modelKey(data.model);
  state.currentModelDisplay = data.model ? modelLabel(data.model) : "No model";
  state.currentThinkingLevel = data.thinkingLevel || "off";
  state.currentSessionId = data.sessionId || state.currentSessionId;
  state.currentCwd = data.cwd || state.currentCwd;
  if ("stats" in data) contextMeter.update(data.stats);
  if ("webFooters" in data) renderWebFooters(elements.extensionFooterEl, data.webFooters);
  if ("sessionTitle" in data) statusBar.setStatusTitle(data.sessionTitle?.trim() || "New session");
  else if ("sessionName" in data) statusBar.setStatusTitle(data.sessionName?.trim() || "New session");
  elements.statusPathEl.textContent = state.currentCwd;
  modelSettings.updateSummary();
  if (sessions) {
    if (data.sessionUiState) sessions.applySessionUiState(data.sessionUiState);
    else {
      sessions.renderSessionBar();
      sessions.renderCurrentSessionBucketButton();
    }
  }
}

function updateSessionStats(stats: any) {
  contextMeter.update(stats);
}

async function refreshMessages() {
  await messages.refreshMessages({
    sessionId: state.currentSessionId,
    headers: api.headers,
    addToolHistoryCard: tools.addToolHistoryCard,
    addPendingToolCard: tools.startTool,
    addRuntimeErrorCard: tools.addRuntimeErrorCard,
    clearActiveToolCards: tools.clearActiveToolCards,
    isStreaming: state.isStreaming,
    updateEmptyCwdChooser: () => sessions.updateEmptyCwdChooser(),
  });
}

async function refreshState() {
  const query = state.currentSessionId ? `?sessionId=${encodeURIComponent(state.currentSessionId)}` : "";
  const res = await fetch(`/api/state${query}`, { headers: api.headers() });
  if (res.status === 401) {
    elements.tokenOverlay.hidden = false;
    elements.tokenInput.focus();
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta(data);
  state.isStreaming = Boolean(data.isStreaming);
  state.isCompacting = Boolean(data.isCompacting);
  if (state.isStreaming || state.isCompacting) statusBar.markActivityStart(state.isCompacting ? "compacting" : "active", data.runtimeStartedAt || data.runtime?.startedAt);
  else statusBar.markActivityEnd();
  contextMeter.update(state.stats);
  composer.updatePrimaryAction();
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
  setIcon(elements.attachButton, "paperclip");
  setIcon(elements.primaryButton, "send-horizontal");
  setIcon(elements.expandButton, "maximize-2");
  setIcon(elements.gitButton, "git-branch");
  setIcon(elements.currentSessionBucketButton, "flag");
  setIcon(elements.settingsButton, "settings");
  setIcon(elements.stopButton, "square");
}

modelSettings = createModelSettings({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
});

statusBar = createStatusBar({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
  refreshSessions: () => sessions.refreshSessions(),
  refreshState,
});

settings = createSettings({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
});

contextMeter = createContextMeter({ state, elements });

sessions = createSessions({
  state,
  elements,
  api,
  updateMeta,
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
  updateMeta,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  beginStreamFollow: messages.beginStreamFollow,
  endStreamFollow: messages.endStreamFollow,
});

conversationTree = createConversationTree({
  state,
  elements,
  api,
  composer,
  updateMeta,
  refreshMessages,
  addMessage: messages.addMessage,
});

const realtime = createRealtime({
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
  updateMeta,
  updateSessionStats,
  refreshMessages,
  refreshState,
  addMessage: messages.addMessage,
});

initStaticIcons();
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
    when: () => elements.tokenOverlay.hidden
      && elements.slashCommandsEl.hidden
      && state.isStreaming,
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
    return scopes;
  },
  onError: showSystemError,
});
composer.updateQueueToggle();
initGitPanel({ button: elements.gitButton, panel: elements.gitPanel, apiHeaders: api.headers, getSessionId: () => state.currentSessionId });
window.addEventListener("popstate", () => {
  const nextSessionId = readActiveSessionIdFromUrl();
  if (nextSessionId === state.currentSessionId) return;
  state.currentSessionId = nextSessionId;
  tools.clearActiveToolCards();
  messages.clear();
  sessions.renderSessionBar();
  sessions.refreshSessions().catch(() => undefined);
  refreshState().catch(showSystemError);
});
composer.updatePrimaryAction();
refreshState().catch(showSystemError);
realtime.connect();
