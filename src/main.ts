import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "./files/files.css";
import "./files/artifacts.css";
import "./styles/appLayout.css";
import "./styles/debugDiagnostics.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { initSwAutoReload } from "./app/sw-update.js";
import { initDebugDiagnostics } from "./app/debugDiagnostics.js";
import { iconElement, setIcon } from "./app/icons.js";
import { createShortcutHelp, type ShortcutHelpController } from "./app/shortcutHelp.js";
import { initKeyboardShortcuts, type Shortcut } from "./app/shortcuts.js";
import { createRightPanelManager } from "./layout/rightPanel.js";
import {
  absoluteSessionCitationHref,
  createAppState,
  readActiveSessionIdFromHistoryState,
  readActiveSessionIdFromUrl,
  readSessionCitationFromUrl,
  sessionCitationHref,
  syncActiveSessionIdHistoryState,
  writeSessionCitationToUrl,
  type SessionCitation,
} from "./app/types.js";
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
import type { ComposerCaptureDescriptor } from "./composer/composerCapture.js";
import { initActionLauncher, type ActionLauncherController } from "./app/actionLauncher.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { createActiveWorkerDock, type ActiveWorkerDockController } from "./composer/activeWorkerDock.js";
import { createWebHeaderActions } from "./extensions/webHeaderActions.js";
import { renderWebFooters } from "./extensions/webFooter.js";
import { createWebPanels, type WebPanelsController } from "./extensions/webPanels.js";
import { configureArtifactPreviews, setArtifactPreviews } from "./extensions/artifactPreviews.js";
import { initGitPanel, type GitPanelController } from "./git/panel.js";
import { initFilesPanel, type FilesPanelController } from "./files/panel.js";
import { configureArtifactPanelOpener, configureArtifactPreviewActions, createMarkdownRenderer, setArtifactPreviewActions } from "./markdown/render.js";
import { createMessageList, type MessageActionContext, type MessageList } from "./messages/messageList.js";
import { createQuoteReplies } from "./quotes/quoteReplies.js";
import { createSessionDraftStore } from "./drafts/sessionDraftStore.js";
import { createModelSettings, modelKey, modelLabel, type ModelSettings } from "./models/modelSettings.js";
import { createRealtime, type RealtimeController } from "./realtime/realtime.js";
import { createSessions, type SessionsController } from "./sessions/sessionDrawer.js";
import { createSettlementDependencyStore } from "./sessions/settlementDependencies.js";
import { createSettings, type SettingsController } from "./settings/settings.js";
import { createSystemInfo, type SystemInfoController } from "./systemInfo/systemInfo.js";
import { createStatusBar, type StatusBar } from "./status/statusBar.js";
import { createSessionInfo, type SessionInfoController } from "./sessionInfo/sessionInfo.js";
import { createToolCards } from "./tools/toolCards.js";
import { createConversationTree, type ConversationTreeController } from "./tree/conversationTree.js";

initAppHeightSync();
initSwAutoReload();

const elements = getAppElements();
const state = createAppState();
const settlementDependencies = createSettlementDependencyStore(state.settlementDependencies);
const sessionDrafts = createSessionDraftStore();
initDebugDiagnostics(state);
const rightPanels = createRightPanelManager();
const api = createApiClient(state);
configureArtifactPreviewActions({ headers: api.headers, getSessionId: () => state.currentSessionId });
configureArtifactPreviews({ headers: api.headers, getSessionId: () => state.currentSessionId });

let messages: MessageList;
let composer: ComposerController;
let contextMeter: ContextMeterController;
let activeWorkerDock: ActiveWorkerDockController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let systemInfo: SystemInfoController;
let sessionInfo: SessionInfoController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;
let gitPanel: GitPanelController;
let filesPanel: FilesPanelController;
const webPanels: WebPanelsController = createWebPanels({ rightPanels, apiHeaders: api.headers, getSessionId: () => state.currentSessionId });
let actionLauncher: ActionLauncherController;
let realtime: RealtimeController;
type PendingCitation = { reference: SessionCitation & { entryId: string }; serial: number };
let citationSerial = 0;
let pendingCitation: PendingCitation | undefined;

function queueCitation(reference: SessionCitation | undefined) {
  pendingCitation = reference?.entryId ? { reference: { sessionId: reference.sessionId, entryId: reference.entryId }, serial: citationSerial } : undefined;
}

let citationDialog: HTMLDialogElement | undefined;
let citationDialogBody: HTMLElement | undefined;
let citationDialogRestoreFocus: HTMLElement | null = null;

function closeCitationDialog() {
  if (citationDialog?.open) citationDialog.close();
}

function dismissCitationDialog() {
  citationSerial++;
  pendingCitation = undefined;
  closeCitationDialog();
}

function ensureCitationDialog() {
  if (citationDialog) return citationDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "citationQuoteDialog";
  dialog.setAttribute("aria-labelledby", "citationQuoteTitle");
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.id = "citationQuoteTitle";
  title.textContent = "Referenced message";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "citationQuoteClose";
  close.title = "Close referenced message";
  close.setAttribute("aria-label", close.title);
  close.append(iconElement("x"));
  const body = document.createElement("div");
  body.className = "citationQuoteBody";
  header.append(title, close);
  dialog.append(header, body);
  document.body.append(dialog);
  close.addEventListener("click", dismissCitationDialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dismissCitationDialog(); });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismissCitationDialog();
  });
  dialog.addEventListener("close", () => {
    const target = citationDialogRestoreFocus;
    citationDialogRestoreFocus = null;
    requestAnimationFrame(() => target?.focus());
  });
  citationDialog = dialog;
  citationDialogBody = body;
  return dialog;
}

function citationLink(label: string, reference: SessionCitation) {
  const link = document.createElement("a");
  link.href = sessionCitationHref(reference);
  link.dataset.sessionCitation = "true";
  link.className = "sessionCitation citationQuoteLink";
  link.title = reference.entryId ? "Open exact saved message" : "Open session";
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    closeCitationDialog();
    void openCitation(reference);
  });
  const icon = iconElement("message-circle");
  icon.classList.add("sessionCitationChatIcon");
  link.append(icon, label);
  return link;
}

function citationStillCurrent(pending: PendingCitation) {
  const locationReference = readSessionCitationFromUrl();
  return pending.serial === citationSerial && state.currentSessionId === pending.reference.sessionId
    && locationReference?.sessionId === pending.reference.sessionId && locationReference.entryId === pending.reference.entryId;
}

function renderCitationDialog(pending: PendingCitation, headingText: string, text: string, truncated = false) {
  const dialog = ensureCitationDialog();
  const body = citationDialogBody!;
  body.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = headingText;
  const quote = document.createElement("blockquote");
  quote.textContent = text;
  if (truncated) quote.append(document.createTextNode("\n… Saved text was truncated."));
  const actions = document.createElement("nav");
  actions.setAttribute("aria-label", "Citation links");
  actions.append(citationLink("Message", pending.reference), citationLink("Session", { sessionId: pending.reference.sessionId }));
  body.append(heading, quote, actions);
  if (!dialog.open) {
    citationDialogRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".citationQuoteClose")?.focus();
  }
}

async function showCitationFallback(pending: PendingCitation) {
  renderCitationDialog(pending, "Loading saved message…", "Reading saved history…");
  try {
    const query = new URLSearchParams(pending.reference);
    const response = await fetch(`/api/session/reference?${query}`, { headers: api.headers() });
    const data = await response.json().catch(() => ({})) as { entries?: Array<{ text?: string; truncated?: boolean }>; truncated?: boolean; error?: string };
    if (!citationStillCurrent(pending)) return closeCitationDialog();
    const entry = data.entries?.[0];
    renderCitationDialog(pending, response.ok && entry?.text ? "Quoted saved message" : "Referenced message unavailable",
      response.ok && entry?.text ? entry.text : (data.error || "Referenced message is not available in saved history."),
      Boolean(response.ok && (entry?.truncated || data.truncated)));
  } catch {
    if (!citationStillCurrent(pending)) return closeCitationDialog();
    renderCitationDialog(pending, "Referenced message unavailable", "Referenced message could not be loaded.");
  }
}

function revealPendingCitation() {
  const pending = pendingCitation;
  pendingCitation = undefined; // A URL target is navigation intent, not a persistent watcher.
  if (!pending || !citationStillCurrent(pending)) return;
  if (messages.scrollToEntry(pending.reference.entryId)) closeCitationDialog();
  else void showCitationFallback(pending);
}

async function openCitation(reference: SessionCitation) {
  const serial = ++citationSerial;
  pendingCitation = undefined;
  closeCitationDialog();
  if (reference.sessionId !== state.currentSessionId) {
    await sessions.openSessionById(reference.sessionId);
    if (serial !== citationSerial || state.currentSessionId !== reference.sessionId) return;
    // The existing opener pushed the new session URL; replace it with this citation.
    writeSessionCitationToUrl(reference, "replace");
  } else {
    writeSessionCitationToUrl(reference);
  }
  queueCitation(reference);
  revealPendingCitation();
}

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
    body: JSON.stringify({
      sessionId: state.currentSessionId,
      targetId: context.role === "user" && context.parentEntryId ? context.parentEntryId : context.entryId,
    }),
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

const quoteReplies = createQuoteReplies({
  messagesEl: elements.messagesEl,
  composerEl: elements.formEl,
  getSessionId: () => state.currentSessionId,
  drafts: sessionDrafts,
  onChange: () => composer?.updatePrimaryAction(),
});
const markdownTestOptions = (globalThis as typeof globalThis & {
  __PI_WEB_STREAMING_MARKDOWN_TEST_OPTIONS__?: { streamingMarkdown?: boolean; streamingBatchMs?: number };
}).__PI_WEB_STREAMING_MARKDOWN_TEST_OPTIONS__;
const markdown = createMarkdownRenderer(
  elements.messagesEl,
  quoteReplies.restoreSubmittedReferences,
  markdownTestOptions,
);
messages = createMessageList({
  messagesEl: elements.messagesEl,
  markdown,
  apiHeaders: api.headers,
  quoteReplies,
  onMessageAction: handleMessageAction,
  getSessionId: () => state.currentSessionId,
  citationHref: absoluteSessionCitationHref,
  openCitation,
  openSession: (sessionId) => void sessions.openSessionById(sessionId),
  openPanel: (key, initialEvent) => webPanels.open(key, initialEvent),
});
const tools = createToolCards(elements.messagesEl, messages.scrollToBottom, api.headers, (sessionId) => void sessions.openSessionById(sessionId), messages.reconcileActivity);

const webHeaderActions = createWebHeaderActions({
  container: elements.headerActionsEl,
  headers: api.headers,
  getSessionId: () => state.currentSessionId,
  markdown,
  openPanel: (key) => webPanels?.open(key),
});

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
  composer?.updatePendingQueue(view?.capabilities?.queue === false ? [] : view?.queue?.steering, view?.capabilities?.queue === false ? [] : view?.queue?.followUp);
  composer?.updateQueueToggle();
  composer?.updatePrimaryAction();
  contextMeter?.update({ stats: view?.stats, isCompacting: runtime.isCompacting });
  sessionInfo?.update();
  renderRuntimeActivity(runtime, previous, activity);
  activeWorkerDock?.refresh();
}

function renderActiveSessionMetadata() {
  const view = activeSessionState(state);
  state.currentModelKey = modelKey(view?.model);
  state.currentModelDisplay = view?.model ? modelLabel(view.model) : "";
  state.currentThinkingLevel = view?.thinkingLevel || "off";
  state.currentCwd = view?.cwd || "";
  filesPanel?.sessionChanged();

  const contributions = view?.capabilities?.extensions === false
    ? []
    : Array.isArray(view?.webContributions) ? view.webContributions as Array<Record<string, any>> : [];
  const inSlot = (slot: string) => contributions.filter((entry) => entry?.version === 1 && entry.slot === slot);
  renderWebFooters(elements.extensionFooterEl, inSlot("footer").map(({ key, view: footer }) => ({ key, footer })));
  webHeaderActions.render(inSlot("header-action"));
  setArtifactPreviewActions(inSlot("artifact-action").map((entry) => ({ ...entry, ...entry.match })));
  setArtifactPreviews(inSlot("artifact-preview"));
  gitPanel?.setExtensionTabs(inSlot("git-tab"));
  webPanels?.setPanels(inSlot("panel"), state.currentSessionId);
  actionLauncher?.setExtensionActions(inSlot("fab"));
  systemInfo?.setExtensionContributions(inSlot("system-info"), state.currentSessionId);
  const captureContributions = inSlot("composer-input").filter((entry): entry is ComposerCaptureDescriptor =>
    entry.kind === "capture" && entry.capture?.media === "audio" && typeof entry.capture.registrationId === "string" && typeof entry.key === "string",
  );
  composer?.setCaptureContributions(captureContributions);
  statusBar?.setStatusTitle(view?.name?.trim() || view?.title?.trim() || "New session");
  elements.statusPathEl.textContent = state.currentCwd;
  elements.conversationTreeButton.hidden = view?.capabilities?.tree === false;
  sessionInfo?.update();
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
  composer?.switchSession(sessionId);
  selectSession(state, sessionId);
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
    || previous.isCompacting !== next.isCompacting
    || previous.pendingMessageCount !== next.pendingMessageCount;
}

function applySessionSnapshot(value: unknown, options: ApplySessionSnapshotOptions = {}) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const requestedId = typeof data?.sessionId === "string" && data.sessionId.trim() ? data.sessionId : state.currentSessionId;
  const previous = requestedId ? sessionRuntime(state, requestedId) : undefined;
  const view = reduceSessionSnapshot(state, value);
  if (!view) return undefined;

  const activatesSession = Boolean(options.activate || !state.currentSessionId);
  if (activatesSession) {
    composer?.switchSession(view.id);
    selectSession(state, view.id);
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
    "webContributions",
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
  revealPendingCitation();
}

function refreshSettlementDependencies(sessionId: string) {
  if (!sessionId) return;
  void settlementDependencies.hydrate(sessionId, async () => {
    const statusResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/status`, { headers: api.headers() });
    if (!statusResponse.ok) return [];
    const status = await statusResponse.json();
    return Array.isArray(status.trackedWorkers)
      ? status.trackedWorkers.map((worker: { id?: unknown }) => worker?.id)
      : [];
  }).then((applied) => {
    if (applied) activeWorkerDock?.refresh();
  }).catch(() => { /* live dependency reports will reconcile this best-effort snapshot */ });
}

async function refreshState() {
  const requestedSessionId = state.currentSessionId;
  const query = requestedSessionId ? `?sessionId=${encodeURIComponent(requestedSessionId)}` : "";
  const res = await fetch(`/api/state${query}`, { headers: api.headers() });
  if (res.status === 401) {
    try {
      const challenge = await fetch("/api/auth/challenge");
      if (challenge.ok) {
        const value = await challenge.json() as { mode?: string; url?: string };
        if (value.mode === "redirect" && value.url) { location.assign(value.url); return; }
      }
    } catch { /* legacy servers have no challenge endpoint */ }
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
  syncActiveSessionIdHistoryState(state.currentSessionId);
  const dependencySessionId = requestedSessionId || (typeof data.sessionId === "string" ? data.sessionId : "");
  refreshSettlementDependencies(dependencySessionId);
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
  setIcon(elements.copySessionLinkButton, "copy");
  setIcon(elements.newSessionHeaderButton, "square-pen");
  setIcon(elements.conversationTreeButton, "git-fork");
  setIcon(elements.filesButton, "folder-tree");
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
  copySessionLink: () => messages.copyCitation({ sessionId: state.currentSessionId }).then(() => true, () => false),
});

settings = createSettings({
  state,
  elements,
  api,
  rightPanels,
  addMessage: messages.addMessage,
  onAppearanceChange: () => {
    activeWorkerDock?.refresh();
    messages.reconcileActivity();
    if (state.initialSyncComplete) void refreshMessages().catch(showSystemError);
  },
});

const systemInfoInline = document.querySelector<HTMLElement>("#systemInfoInline");
if (!systemInfoInline) throw new Error("Missing inline system information container");
systemInfo = createSystemInfo({
  api,
  trigger: elements.sessionDrawerInfoButton,
  focusOnClose: elements.sessionDrawerInfoButton,
  apiHeaders: api.headers,
  getSessionId: () => state.currentSessionId,
  onError: (message) => messages.addMessage("system", message, "error"),
  inlineContainer: systemInfoInline,
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
  onDerivedSessionStateChanged: () => {
    // Rehydrate inactive pinned parents too. Realtime dependency declarations
    // are not replayed after a browser reconnect, while pinned indicators must
    // remain correct without opening each parent first.
    for (const sessionId of new Set([state.currentSessionId, ...state.pinnedSessions.map((item) => item.id)])) {
      refreshSettlementDependencies(sessionId);
    }
    activeWorkerDock?.refresh();
  },
  clearMessages: () => {
    tools.clearActiveToolCards();
    messages.clear();
  },
  addMessage: messages.addMessage,
});

activeWorkerDock = createActiveWorkerDock({
  container: elements.waitingSessionsEl,
  getWorkers: () => sessions.activeWorkersFor(state.currentSessionId),
  openSession: (sessionId) => void sessions.openSessionById(sessionId),
});
activeWorkerDock.refresh();

sessionInfo = createSessionInfo({
  state,
  rightPanels,
  apiHeaders: api.headers,
  refreshSessions: () => sessions.refreshSessions(),
  openGit: () => elements.gitButton.click(),
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
  quoteReplies,
  drafts: sessionDrafts,
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
  applySettlementDependencies: settlementDependencies.applyReport,
  onSettlementDependenciesChanged: () => activeWorkerDock?.refresh(),
  updateWebContribution: (key) => {
    webPanels?.update(key);
    gitPanel?.updateExtensionTab(key);
  },
  addMessage: messages.addMessage,
});

initStaticIcons();
actionLauncher = initActionLauncher(elements, {
  onSessionDetails: () => sessionInfo.open(),
  onExtensionAction: (opensPanelKey) => webPanels.open(opensPanelKey),
  onComposerBlurred: () => composer.syncCompactState(),
});
statusBar.init();
sessions.init();
sessionInfo.init();
contextMeter.init();
composer.init();
conversationTree.init();
modelSettings.init();
settings.init();
systemInfo.init();
const hasBlockingShortcutOverlay = () => Boolean(document.fullscreenElement
  || document.querySelector('dialog[open], [aria-modal="true"]:not([hidden]), .folderPickerBackdrop, .imageOverlay'));
const canCyclePinnedSessions = () => sessions.focusedLaneSessionCount() > 1
  && elements.tokenOverlay.hidden
  && !elements.formEl.classList.contains("expanded")
  && !hasBlockingShortcutOverlay();
let shortcutHelp: ShortcutHelpController;
const keyboardShortcuts: Shortcut[] = [
  {
    id: "sessions.toggleDrawer",
    key: "b",
    description: "Toggle sessions drawer",
    scope: "global",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => sessions.setSessionDrawerOpen(elements.sessionDrawer.hidden),
  },
  {
    id: "sessions.toggleCurrentPin",
    key: "p",
    description: "Pin or unpin current session",
    scope: "global",
    mod: true,
    shift: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden && Boolean(state.currentSessionId),
    run: () => sessions.toggleCurrentSessionPin(),
  },
  {
    id: "sessions.parkCurrent",
    key: "k",
    description: "Park current session",
    scope: "global",
    mod: true,
    shift: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden && Boolean(state.currentSessionId),
    run: () => sessions.moveCurrentSessionToLane("parked"),
  },
  {
    id: "sessions.bookmarkCurrent",
    key: "b",
    description: "Bookmark current session",
    scope: "global",
    mod: true,
    shift: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden && Boolean(state.currentSessionId),
    run: () => sessions.moveCurrentSessionToLane("bookmarks"),
  },
  {
    id: "sessions.previousPinned",
    key: "ArrowLeft",
    description: "Previous session in current lane",
    scope: "global",
    mod: true,
    shift: true,
    when: canCyclePinnedSessions,
    run: () => sessions.openAdjacentPinnedSession(-1),
  },
  {
    id: "sessions.nextPinned",
    key: "ArrowRight",
    description: "Next session in current lane",
    scope: "global",
    mod: true,
    shift: true,
    when: canCyclePinnedSessions,
    run: () => sessions.openAdjacentPinnedSession(1),
  },
  {
    id: "sessions.new",
    key: "o",
    description: "Open a new session",
    scope: "global",
    mod: true,
    shift: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => sessions.startNewSession(),
  },
  {
    id: "app.showKeyboardShortcuts",
    key: "/",
    description: "Show keyboard shortcuts",
    scope: "global",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => shortcutHelp.toggle(),
  },
  {
    id: "composer.focus",
    key: ".",
    description: "Focus composer",
    scope: "global",
    when: () => elements.tokenOverlay.hidden
      && document.activeElement !== elements.promptEl
      && !hasBlockingShortcutOverlay(),
    run: () => elements.promptEl.focus(),
  },
  {
    id: "composer.submit",
    key: "Enter",
    description: "Send prompt",
    scope: "composer",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => elements.formEl.requestSubmit(),
  },
  {
    id: "session.stopFromPrompt",
    key: "Escape",
    description: "Stop current response",
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
];
shortcutHelp = createShortcutHelp(keyboardShortcuts);
initKeyboardShortcuts(keyboardShortcuts, {
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
configureArtifactPanelOpener((url) => filesPanel.openArtifact(url));
gitPanel = initGitPanel({
  button: elements.gitButton,
  panel: elements.gitPanel,
  rightPanels,
  apiHeaders: api.headers,
  getSessionId: () => state.currentSessionId,
  onComposerContext: (context) => composer.addContextAttachment(context),
});
window.addEventListener("popstate", (event) => {
  citationSerial++;
  const reference = readSessionCitationFromUrl();
  queueCitation(reference);
  const nextSessionId = readActiveSessionIdFromHistoryState(event.state) ?? reference?.sessionId ?? readActiveSessionIdFromUrl();
  if (nextSessionId === state.currentSessionId) {
    syncActiveSessionIdHistoryState(nextSessionId);
    revealPendingCitation();
    return;
  }
  syncActiveSessionIdHistoryState(nextSessionId);
  sessionState.activate(nextSessionId);
  tools.clearActiveToolCards();
  sessions.beginTranscriptLoading();
  messages.clear();
  sessions.renderSessionBar();
  sessions.refreshSessions().catch(() => undefined);
  refreshState().catch(showSystemError);
});
composer.updatePrimaryAction();
queueCitation(readSessionCitationFromUrl());
refreshState().catch(showSystemError);
realtime.connect();
