import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "./styles/appLayout.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { initSwAutoReload } from "./app/sw-update.js";
import { setIcon } from "./app/icons.js";
import { initKeyboardShortcuts } from "./app/shortcuts.js";
import { createRightPanelManager } from "./layout/rightPanel.js";
import { createAppState, readActiveSessionIdFromUrl } from "./app/types.js";
import { createComposer, type ComposerController } from "./composer/composer.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { createWebHeaderActions } from "./extensions/webHeaderActions.js";
import { renderWebFooters } from "./extensions/webFooter.js";
import { initGitPanel } from "./git/panel.js";
import { createMarkdownRenderer } from "./markdown/render.js";
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
const markdown = createMarkdownRenderer(elements.messagesEl);

let messages: MessageList;
let composer: ComposerController;
let contextMeter: ContextMeterController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;
let realtime: RealtimeController;
async function submitPromptFromMessageAction(message: string) {
  const promptText = message.trim();
  if (!promptText) throw new Error("Message is empty.");

  state.isStreaming = true;
  state.isRetrying = false;
  composer.updatePrimaryAction();
  messages.beginStreamFollow();
  messages.addMessage("user", promptText);

  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: state.currentSessionId, message: promptText, mode: state.queueMode, images: [] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
  } catch (error) {
    state.isStreaming = false;
    state.isRetrying = false;
    composer.updatePrimaryAction();
    messages.endStreamFollow();
    throw error;
  }
}

async function navigateMessageActionTarget(context: MessageActionContext) {
  if (state.isStreaming || state.isRetrying) throw new Error("Wait for the current response to finish first.");
  if (state.isCompacting) throw new Error("Wait for compaction to finish first.");

  const res = await fetch("/api/session/tree/navigate", {
    method: "POST",
    headers: api.headers(),
    body: JSON.stringify({ sessionId: state.currentSessionId, targetId: context.entryId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
  if (data.cancelled) return data;

  if (data.state) {
    updateMeta(data.state);
    state.isStreaming = Boolean(data.state.isStreaming);
    state.isRetrying = Boolean(data.state.isRetrying || data.state.runtime?.isRetrying);
    state.isCompacting = Boolean(data.state.isCompacting);
    composer.updatePrimaryAction();
  }
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

function showSystemError(error: unknown) {
  messages.addMessage("system", error instanceof Error ? error.message : String(error), "error");
}

function updateMeta(data: any) {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : state.currentSessionId;
  if (sessionId) {
    const sessionName = typeof data.sessionName === "string" ? data.sessionName : typeof data.sessionTitle === "string" ? data.sessionTitle : undefined;
    state.sessionsById[sessionId] = {
      ...state.sessionsById[sessionId],
      id: sessionId,
      ...(sessionName !== undefined ? { name: sessionName } : {}),
      ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}),
      isCurrent: sessionId === (data.sessionId || state.currentSessionId),
    };
  }
  state.currentModelKey = modelKey(data.model);
  state.currentModelDisplay = data.model ? modelLabel(data.model) : "";
  state.currentThinkingLevel = data.thinkingLevel || "off";
  state.currentSessionId = data.sessionId || state.currentSessionId;
  state.currentCwd = data.cwd || state.currentCwd;
  if ("stats" in data) contextMeter.update(data.stats);
  if ("webFooters" in data) renderWebFooters(elements.extensionFooterEl, data.webFooters);
  if ("webHeaderActions" in data) webHeaderActions.render(data.webHeaderActions);
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
    isStreaming: state.isStreaming || state.isRetrying,
    updateEmptyCwdChooser: () => sessions.updateEmptyCwdChooser(),
    onTranscriptRuntimeState: (transcriptState) => realtime?.applyTranscriptRuntimeState(transcriptState),
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
  state.isRetrying = Boolean(data.isRetrying || data.runtime?.isRetrying);
  state.isCompacting = Boolean(data.isCompacting);
  if (state.isStreaming || state.isRetrying || state.isCompacting) statusBar.markActivityStart(
    state.isCompacting ? "compacting" : state.isRetrying ? "retrying" : "active",
    data.runtimeStartedAt || data.runtime?.startedAt,
    data.runtimeLastActivityAt || data.runtime?.lastActivityAt,
  );
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
  rightPanels,
  addMessage: messages.addMessage,
});

contextMeter = createContextMeter({ state, elements });

sessions = createSessions({
  state,
  elements,
  api,
  rightPanels,
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
  addToolHistoryCard: tools.addToolHistoryCard,
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
  rightPanels,
  composer,
  updateMeta,
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
      && (state.isStreaming || state.isRetrying),
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
initGitPanel({ button: elements.gitButton, panel: elements.gitPanel, rightPanels, apiHeaders: api.headers, getSessionId: () => state.currentSessionId });
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
