import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { clearToken, saveToken, writeActiveSessionIdToUrl } from "../app/types.js";
import type { AppState, ComposerContextAttachment, FileAttachment, SlashCommand } from "../app/types.js";
import { activeSessionState, harnessName, isNativeSession, sessionRuntime, type SessionStateController } from "../app/sessionState.js";
import { iconElement, setIcon } from "../app/icons.js";
import { focusIfKeyboardFriendly } from "../app/focus.js";
import { recordDebugEvent } from "../app/debugDiagnostics.js";
import { openImageOverlay } from "../components/imageActions.js";
import { extractTokenFromScannedText } from "../token/tokenShare.js";
import { bindCompactInactiveAction } from "./compactInteractions.js";
import type { QuoteRepliesController, QuoteReplySubmission } from "../quotes/quoteReplies.js";
import type { SessionDraftStore } from "../drafts/sessionDraftStore.js";
import { capturedTextInsertion, createComposerCapture, type ComposerCaptureDescriptor } from "./composerCapture.js";

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const restoreFocusStorageKey = "pi-web-composer-restore-focus";

export type ComposerController = {
  init: () => void;
  addContextAttachment: (context: ComposerContextAttachment) => void;
  renderAttachments: () => void;
  switchSession: (sessionId: string) => void;
  setPromptText: (text: string) => void;
  setCaptureContributions: (contributions: ComposerCaptureDescriptor[]) => void;
  syncCompactState: () => void;
  stopStreaming: () => Promise<void>;
  updatePrimaryAction: () => void;
  updateQueueToggle: () => void;
  updatePendingQueue: (steering: unknown, followUp: unknown) => void;
  trackOptimisticUserMessage: (clientMessageId: string) => void;
  discardOptimisticUserMessage: (clientMessageId: string) => void;
  handleUserMessage: (text: string, clientMessageId?: string, sourceClientId?: string, images?: any[]) => boolean;
};

export function createComposer(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  addMessage: (role: "user" | "system", text: string, extraClass?: string, images?: any[]) => void;
  addToolHistoryCard?: (toolName: string, isError: boolean, result: unknown, args?: Record<string, unknown>) => void;
  sessionState: SessionStateController;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  beginTranscriptLoading?: () => void;
  beginStreamFollow?: () => void;
  endStreamFollow?: () => void;
  prepareLandingSession?: () => Promise<string | undefined>;
  quoteReplies: QuoteRepliesController;
  drafts: SessionDraftStore;
}): ComposerController {
  const { state, elements, api, addMessage, addToolHistoryCard, sessionState, updateThinkingOptions, refreshModels, refreshMessages, refreshState, beginTranscriptLoading, beginStreamFollow, endStreamFollow, prepareLandingSession, quoteReplies, drafts } = options;

  const webSlashCommandNames = new Set(["help", "?", "commands", "reload", "model", "models", "thinking", "new", "clear", "compact", "abort", "stop", "logout"]);
  const slashCommandCacheMs = 5_000;
  const expandedStorageKey = "pi-web-composer-expanded";
  let slashCommands: SlashCommand[] = [];
  let slashCommandsLoadedAt = 0;
  let slashCommandsSessionId = "";
  let preparingInput = false;
  let nativeSubmitting = false;
  let slashCommandSelectedIndex = 0;
  let tokenScanStream: MediaStream | undefined;
  let tokenScanFrame = 0;
  let tokenScanActive = false;
  let contextAttachments: ComposerContextAttachment[] = [];
  const sessionContextAttachments = new Map<string, ComposerContextAttachment[]>();
  let pendingSteering: string[] = [];
  let pendingFollowUp: string[] = [];
  const optimisticUserMessages = new Set<string>();
  let ownedSessionId = "";
  let promptRevision = 0;
  const composerCapture = createComposerCapture({
    container: elements.composerExtensionInputs,
    prompt: elements.promptEl,
    api,
    getSessionId: () => ownedSessionId,
    getRevision: () => promptRevision,
    insertText(text, placement, snapshot) {
      const insertion = capturedTextInsertion({ text, placement, snapshot, current: {
        sessionId: ownedSessionId, revision: promptRevision, value: elements.promptEl.value,
        selectionStart: elements.promptEl.selectionStart, selectionEnd: elements.promptEl.selectionEnd,
      } });
      if (!insertion) return false;
      elements.promptEl.value = insertion.value;
      elements.promptEl.setSelectionRange(insertion.cursor, insertion.cursor);
      promptRevision += 1;
      persistDraft();
      updatePrimaryAction();
      updateCompactInactive();
      return true;
    },
    onError: (message) => addMessage("system", message, "error"),
  });

  function renderPendingQueue() {
    const entries = [
      ...pendingSteering.map((text) => ({ text, mode: "steer" as const })),
      ...pendingFollowUp.map((text) => ({ text, mode: "followUp" as const })),
    ];
    elements.pendingMessagesEl.replaceChildren();
    elements.pendingMessagesEl.hidden = entries.length === 0;
    let previousMode: typeof entries[number]["mode"] | undefined;
    for (const entry of entries) {
      if (previousMode && previousMode !== entry.mode) {
        const separator = document.createElement("div");
        separator.className = "pendingMessageSeparator";
        separator.setAttribute("role", "separator");
        elements.pendingMessagesEl.append(separator);
      }
      const item = document.createElement("article");
      item.className = `pendingMessage ${entry.mode}`;
      item.dataset.mode = entry.mode;
      item.setAttribute("aria-label", `${entry.mode === "steer" ? "Steering" : "Follow up"}: ${entry.text}`);
      const icon = iconElement(entry.mode === "steer" ? "route" : "corner-down-right");
      const text = document.createElement("span");
      text.className = "pendingMessageText";
      text.textContent = entry.text;
      item.append(icon, text);
      elements.pendingMessagesEl.append(item);
      previousMode = entry.mode;
    }
  }

  function updatePendingQueue(steering: unknown, followUp: unknown) {
    pendingSteering = Array.isArray(steering) ? steering.filter((item): item is string => typeof item === "string") : [];
    pendingFollowUp = Array.isArray(followUp) ? followUp.filter((item): item is string => typeof item === "string") : [];
    renderPendingQueue();
  }

  function trackOptimisticUserMessage(clientMessageId: string) {
    optimisticUserMessages.add(clientMessageId);
  }

  function discardOptimisticUserMessage(clientMessageId: string) {
    optimisticUserMessages.delete(clientMessageId);
  }

  function handleUserMessage(text: string, clientMessageId?: string, sourceClientId?: string, images: any[] = []) {
    if (clientMessageId && sourceClientId === api.clientId && optimisticUserMessages.delete(clientMessageId)) return true;
    addMessage("user", text, "", images);
    return true;
  }

  function updatePrimaryAction() {
    const hasInput = !!elements.promptEl.value.trim() || state.attachedImages.length > 0 || contextAttachments.length > 0 || quoteReplies.hasDrafts();
    const initialRealtimeReady = state.initialSyncComplete && state.wsHasOpened;
    const runtime = sessionRuntime(state);
    const view = activeSessionState(state);
    const native = isNativeSession(view);
    const canSendWhileRunning = native ? view?.capabilities?.steering === true && Boolean(view.activeExecution) : view?.capabilities?.queue !== false;
    const unavailable = native && (view?.phase === "unavailable" || view?.nativeSession?.status === "unavailable" || state.wsDisconnected);
    elements.primaryButton.disabled = !hasInput || !initialRealtimeReady || preparingInput || nativeSubmitting || unavailable || runtime.isRunning && !canSendWhileRunning;
    elements.primaryButton.title = "Send";
    if (!initialRealtimeReady) elements.primaryButton.title = "Connecting live updates…";
    else if (unavailable) elements.primaryButton.title = "Reconnect or reopen this native session before sending.";
    else if (native && runtime.isRunning) elements.primaryButton.title = canSendWhileRunning ? "Steer the active execution" : "This harness cannot accept input while running.";
    elements.stopButton.style.display = (native ? runtime.isRunning : runtime.isStreaming || runtime.isRetrying) ? "" : "none";
    elements.attachButton.hidden = native ? view?.capabilities?.attachments !== true : view?.capabilities?.attachments === false;
    elements.imageInput.disabled = elements.attachButton.hidden;
    elements.promptEl.placeholder = native ? `Ask ${harnessName(view)}…` : "Ask pi…";
  }

  function updateQueueToggle() {
    const capabilities = activeSessionState(state)?.capabilities;
    elements.queueToggle.hidden = isNativeSession(activeSessionState(state)) ? capabilities?.queue !== true : capabilities?.queue === false;
    const isSteer = state.queueMode === "steer";
    elements.queueToggle.setAttribute("aria-pressed", String(isSteer));
    elements.queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
    elements.queueToggle.setAttribute("aria-label", elements.queueToggle.title);
    setIcon(elements.queueToggle, isSteer ? "route" : "corner-down-right");
  }

  function applyCompactInactive(compact: boolean) {
    elements.formEl.classList.toggle("compactInactive", compact);
  }

  function updateCompactInactive() {
    const active = document.activeElement;
    const unfocused = !active || !elements.formEl.contains(active);
    applyCompactInactive(unfocused && !elements.promptEl.value.trim());
  }

  async function stopStreaming() {
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const view = activeSessionState(state);
    const expectedExecutionId = view?.activeExecution?.id;
    if (isNativeSession(view) && !expectedExecutionId) throw new Error("Native execution identity is not available yet.");
    const response = await fetch("/api/abort", { method: "POST", headers: api.headers(), body: JSON.stringify({ sessionId, ...(expectedExecutionId ? { expectedExecutionId } : {}) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || "Could not interrupt the execution.");
    // An acknowledgement is not idle; only the authoritative activity snapshot settles the UI.
  }

  function persistDraft(immediate = false) {
    drafts.update(ownedSessionId, { text: elements.promptEl.value }, immediate);
  }

  async function persistComposerSettings(patch: { queueMode?: AppState["queueMode"] }) {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify({ composer: patch }),
      });
    } catch { /* best effort; server settings refresh will reconcile */ }
  }

  function clearDraft() {
    drafts.discard(ownedSessionId, ["text"]);
  }

  function settlePromptFocusAfterSubmit() {
    if (!focusIfKeyboardFriendly(elements.promptEl)) {
      // Let the pointer-generated click finish before compact mode hides and
      // reflows the submit control, especially on touch-sized viewports.
      window.setTimeout(() => {
        // A new queued prompt may have been entered while the request settled.
        if (!elements.promptEl.value) elements.promptEl.blur();
      }, 0);
    }
  }

  function setPromptText(text: string) {
    composerCapture.cancel();
    elements.promptEl.value = text;
    promptRevision += 1;
    persistDraft();
    updatePrimaryAction();
    renderSlashCommands();
    elements.promptEl.focus();
  }

  function slashCommandName(text: string) {
    return text.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase() || "";
  }

  function slashCommandQuery() {
    const value = elements.promptEl.value;
    if (!value.startsWith("/") || state.attachedImages.length > 0 || contextAttachments.length > 0) return undefined;
    const withoutSlash = value.slice(1);
    if (/\s/.test(withoutSlash) || withoutSlash.includes("\n")) return undefined;
    return withoutSlash.toLowerCase();
  }

  function hideSlashCommands() {
    elements.slashCommandsEl.hidden = true;
    elements.promptEl.setAttribute("aria-expanded", "false");
  }

  async function refreshSlashCommands(force = false) {
    const now = Date.now();
    const sessionId = state.currentSessionId;
    if (!force && slashCommandsSessionId === sessionId && slashCommands.length > 0 && now - slashCommandsLoadedAt < slashCommandCacheMs) return slashCommands;
    const res = await fetch(`/api/commands?sessionId=${encodeURIComponent(sessionId)}`, { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (sessionId !== state.currentSessionId) return [];
    slashCommands = Array.isArray(data.commands) ? data.commands : [];
    slashCommandsSessionId = sessionId;
    slashCommandsLoadedAt = now;
    return slashCommands;
  }

  function filteredSlashCommands() {
    const query = slashCommandQuery();
    if (query === undefined) return [];
    const sourceOrder = new Map<string, number>([["web", 0], ["extension", 1], ["prompt", 2], ["skill", 3]]);
    return slashCommands
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() || "";
        if (!supportsCommand(name, command.source)) return false;
        return !query || name.includes(query) || description.includes(query);
      })
      .sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aStarts = aName.startsWith(query) ? 0 : 1;
        const bStarts = bName.startsWith(query) ? 0 : 1;
        return aStarts - bStarts
          || (sourceOrder.get(a.source) ?? 99) - (sourceOrder.get(b.source) ?? 99)
          || a.name.localeCompare(b.name);
      })
      .slice(0, 12);
  }

  function applySlashCommand(command: SlashCommand) {
    const leadingWhitespace = elements.promptEl.value.match(/^\s*/)?.[0] || "";
    elements.promptEl.value = `${leadingWhitespace}/${command.name} `;
    promptRevision += 1;
    elements.promptEl.setSelectionRange(elements.promptEl.value.length, elements.promptEl.value.length);
    updatePrimaryAction();
    hideSlashCommands();
    elements.promptEl.focus();
  }

  function renderSlashCommands() {
    const query = slashCommandQuery();
    if (query === undefined) {
      hideSlashCommands();
      return;
    }

    const commands = filteredSlashCommands();
    slashCommandSelectedIndex = Math.min(slashCommandSelectedIndex, Math.max(commands.length - 1, 0));
    elements.slashCommandsEl.textContent = "";

    if (commands.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slashCommandsEmpty";
      empty.textContent = isNativeSession(activeSessionState(state)) && slashCommandsSessionId === state.currentSessionId && slashCommandsLoadedAt
        ? "This harness has no supported web slash commands."
        : slashCommands.length === 0 ? "Loading slash commands…" : "No matching slash commands";
      elements.slashCommandsEl.append(empty);
    } else {
      commands.forEach((command, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `slashCommandItem${index === slashCommandSelectedIndex ? " active" : ""}`;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === slashCommandSelectedIndex));
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("mouseenter", () => {
          if (slashCommandSelectedIndex === index) return;
          slashCommandSelectedIndex = index;
          renderSlashCommands();
        });
        button.addEventListener("click", () => applySlashCommand(command));

        const name = document.createElement("span");
        name.className = "slashCommandName";
        name.textContent = `/${command.name}`;

        button.append(name);
        if (command.source !== "web") {
          const source = document.createElement("span");
          source.className = "slashCommandSource";
          source.textContent = command.source;
          button.append(source);
        }
        if (command.description) {
          const description = document.createElement("span");
          description.className = "slashCommandDescription";
          description.textContent = command.description;
          button.append(description);
        }
        elements.slashCommandsEl.append(button);
      });
    }

    elements.slashCommandsEl.hidden = false;
    elements.promptEl.setAttribute("aria-expanded", "true");
  }

  async function maybeRefreshSlashCommands(force = false) {
    if (slashCommandQuery() === undefined) {
      hideSlashCommands();
      return;
    }
    try {
      await refreshSlashCommands(force);
      renderSlashCommands();
    } catch {
      hideSlashCommands();
    }
  }

  async function commandInfoForMessage(message: string) {
    await refreshSlashCommands();
    const name = slashCommandName(message);
    return slashCommands.find((command) => command.name.toLowerCase() === name);
  }

  async function attachFiles(files: File[]) {
    if (!files.length) return;
    const uploadSessionId = ownedSessionId;
    recordDebugEvent("attachment-upload-start", { files: files.map(({ name, size, type }) => ({ name, size, type })) });
    try {
      if (activeSessionState(state)?.capabilities?.attachments === false) throw new Error("Attachments are not supported by this harness.");
      const attachments = await Promise.all(files.map(async (file): Promise<FileAttachment> => {
        const params = new URLSearchParams({
          sessionId: uploadSessionId,
          name: file.name,
          mediaType: file.type || "application/octet-stream",
        });
        const { "content-type": _contentType, ...uploadHeaders } = api.headers();
        const response = await fetch(`/api/attachments?${params}`, {
          method: "POST",
          headers: uploadHeaders,
          body: file,
        });
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as { attachment?: FileAttachment };
        if (!result.attachment) throw new Error(`Could not attach ${file.name}`);
        return result.attachment;
      }));
      const sessionAttachments = [...drafts.get(uploadSessionId).attachments, ...attachments];
      drafts.update(uploadSessionId, { attachments: sessionAttachments }, true);
      recordDebugEvent("attachment-upload-complete", { sessionId: uploadSessionId, attachments: attachments.map(({ id, name, bytes, mediaType }) => ({ id, name, bytes, mediaType })) });
      if (ownedSessionId === uploadSessionId) {
        state.attachedImages = sessionAttachments;
        renderAttachments();
        updatePrimaryAction();
        hideSlashCommands();
      }
    } catch (error) {
      recordDebugEvent("attachment-upload-error", { message: error instanceof Error ? error.message : String(error) });
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types || []).some((type) => type.toLowerCase() === "files");
  }

  function setDragOver(active: boolean) {
    elements.formEl.classList.toggle("dragOver", active);
  }

  function rememberContextAttachments(sessionId = ownedSessionId) {
    if (!sessionId) return;
    if (contextAttachments.length) sessionContextAttachments.set(sessionId, [...contextAttachments]);
    else sessionContextAttachments.delete(sessionId);
  }

  function addContextAttachment(context: ComposerContextAttachment) {
    if (activeSessionState(state)?.capabilities?.attachments === false) { addMessage("system", "Attachments are not supported by this harness.", "error"); return; }
    const existingIndex = context.id
      ? contextAttachments.findIndex((attachment) => attachment.id === context.id)
      : -1;
    if (existingIndex >= 0) contextAttachments[existingIndex] = context;
    else contextAttachments.push(context);
    rememberContextAttachments();
    renderAttachments();
    updatePrimaryAction();
    hideSlashCommands();
    focusIfKeyboardFriendly(elements.promptEl);
  }

  function persistAttachmentDraft() {
    drafts.update(ownedSessionId, { attachments: state.attachedImages });
  }

  function switchSession(sessionId: string) {
    if (!sessionId || sessionId === ownedSessionId) return;
    composerCapture.cancel();
    promptRevision += 1;
    if (ownedSessionId) {
      drafts.update(ownedSessionId, { text: elements.promptEl.value, attachments: state.attachedImages }, true);
      rememberContextAttachments();
    }
    drafts.attachInitialSession(sessionId);
    if (!ownedSessionId && elements.promptEl.value) {
      drafts.update(sessionId, { text: elements.promptEl.value, attachments: state.attachedImages }, true);
    }
    ownedSessionId = sessionId;
    const draft = drafts.get(sessionId);
    elements.promptEl.value = draft.text;
    state.attachedImages = draft.attachments;
    contextAttachments = [...(sessionContextAttachments.get(sessionId) || [])];
    recordDebugEvent("composer-draft-restored", { sessionId, attachmentCount: draft.attachments.length });
    if (draft.attachments.length) recordDebugEvent("attachment-draft-restored", { sessionId, count: draft.attachments.length });
    renderAttachments();
    updatePrimaryAction();
    updateCompactInactive();
  }

  function renderAttachments() {
    persistAttachmentDraft();
    elements.attachmentsEl.textContent = "";
    elements.attachmentsEl.hidden = state.attachedImages.length === 0 && contextAttachments.length === 0;
    contextAttachments.forEach((context, index) => {
      const chip = document.createElement("div");
      chip.className = "attachmentChip contextAttachmentChip";
      chip.title = context.title ? `${context.label}: ${context.title}` : context.label;

      const sourceIcon = document.createElement("span");
      sourceIcon.className = "contextAttachmentIcon";
      sourceIcon.append(iconElement("git-branch"));

      const text = document.createElement("span");
      text.className = "contextAttachmentText";
      const label = document.createElement("strong");
      label.textContent = context.label;
      text.append(label);
      if (context.title) {
        const title = document.createElement("small");
        title.textContent = context.title;
        text.append(title);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "removeAttachment";
      remove.title = `Remove ${context.label}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        contextAttachments.splice(index, 1);
        rememberContextAttachments();
        renderAttachments();
        updatePrimaryAction();
      });
      setIcon(remove, "x");

      chip.append(sourceIcon, text, remove);
      elements.attachmentsEl.append(chip);
    });
    state.attachedImages.forEach((image, index) => {
      const chip = document.createElement("div");
      chip.className = "attachmentChip";

      const preview = document.createElement("img");
      if (image.mediaType.startsWith("image/")) {
        void fetch(image.contentUrl, { headers: api.headers() })
          .then((response) => {
            if (!response.ok) throw new Error("Attachment preview unavailable");
            return response.blob();
          })
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            preview.src = objectUrl;
          })
          .catch(() => { preview.hidden = true; });
      } else preview.hidden = true;
      preview.alt = image.name;
      if (image.mediaType.startsWith("image/")) {
        preview.tabIndex = 0;
        preview.setAttribute("role", "button");
        preview.setAttribute("aria-label", `Preview ${image.name}`);
        preview.addEventListener("click", () => openImageOverlay(preview));
        preview.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImageOverlay(preview);
          }
        });
      }

      const name = document.createElement("span");
      name.textContent = image.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "removeAttachment";
      remove.title = `Remove ${image.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        state.attachedImages.splice(index, 1);
        renderAttachments();
        updatePrimaryAction();
      });
      setIcon(remove, "x");

      chip.append(preview, name, remove);
      elements.attachmentsEl.append(chip);
    });
  }

  function isShellError(data: { exitCode?: unknown; cancelled?: unknown }) {
    return Boolean(data.cancelled || (typeof data.exitCode === "number" && data.exitCode !== 0));
  }

  function barcodeDetectorConstructor(): BarcodeDetectorConstructor | undefined {
    return (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  }

  function setTokenScanStatus(message: string) {
    elements.tokenScanStatus.textContent = message;
  }

  function stopTokenScanner(hidePanel = true) {
    tokenScanActive = false;
    if (tokenScanFrame) cancelAnimationFrame(tokenScanFrame);
    tokenScanFrame = 0;
    if (tokenScanStream) {
      for (const track of tokenScanStream.getTracks()) track.stop();
      tokenScanStream = undefined;
    }
    elements.tokenScanVideo.pause();
    elements.tokenScanVideo.srcObject = null;
    if (hidePanel) {
      elements.tokenScanPanel.hidden = true;
      setTokenScanStatus("");
    }
  }

  function connectWithToken(token: string) {
    const val = token.trim();
    if (!val) return;
    stopTokenScanner();
    state.token = val;
    saveToken(state.token);
    elements.tokenInput.value = val;
    elements.tokenOverlay.hidden = true;
    refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  function useScannedToken(text: string) {
    const scanned = extractTokenFromScannedText(text);
    if (!scanned?.token.trim()) return false;

    if (scanned.url && (scanned.url.origin !== location.origin || scanned.url.pathname !== location.pathname)) {
      stopTokenScanner(false);
      setTokenScanStatus("Opening token link…");
      location.href = scanned.url.toString();
      return true;
    }

    const sessionId = scanned.url?.searchParams.get("sessionId")?.trim();
    if (sessionId) {
      sessionState.activate(sessionId);
      writeActiveSessionIdToUrl(sessionId, "replace");
    }
    connectWithToken(scanned.token);
    return true;
  }

  async function scanTokenQrLoop(detector: BarcodeDetectorLike) {
    if (!tokenScanActive) return;
    try {
      if (elements.tokenScanVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const barcodes = await detector.detect(elements.tokenScanVideo);
        const rawValue = barcodes.map((barcode) => barcode.rawValue?.trim()).find(Boolean);
        if (rawValue) {
          if (useScannedToken(rawValue)) return;
          setTokenScanStatus("QR code found, but it did not contain a token.");
        }
      }
    } catch (error) {
      stopTokenScanner(false);
      setTokenScanStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    if (tokenScanActive) tokenScanFrame = requestAnimationFrame(() => { void scanTokenQrLoop(detector); });
  }

  async function startTokenScanner() {
    elements.tokenScanPanel.hidden = false;
    setTokenScanStatus("Starting camera…");

    if (!window.isSecureContext) {
      setTokenScanStatus("Camera access requires HTTPS or localhost.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setTokenScanStatus("Camera access is not available in this browser.");
      return;
    }
    const Detector = barcodeDetectorConstructor();
    if (!Detector) {
      setTokenScanStatus("QR scanning is not available in this browser yet.");
      return;
    }

    stopTokenScanner(false);
    elements.tokenScanPanel.hidden = false;
    setTokenScanStatus("Starting camera…");
    try {
      const detector = new Detector({ formats: ["qr_code"] });
      tokenScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      elements.tokenScanVideo.srcObject = tokenScanStream;
      await elements.tokenScanVideo.play();
      tokenScanActive = true;
      setTokenScanStatus("Point the camera at a pi-web token QR code.");
      await scanTokenQrLoop(detector);
    } catch (error) {
      stopTokenScanner(false);
      setTokenScanStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function runShellEscape(input: string) {
    if (activeSessionState(state)?.capabilities?.bash === false) throw new Error("Shell commands are not supported by this harness.");
    const trimmed = input.trim();
    const excludeFromContext = trimmed.startsWith("!!");
    const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
    if (!command) throw new Error("Shell command is required");
    const res = await fetch("/api/shell", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: state.currentSessionId, command, excludeFromContext }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new Error(data.error || text);
    if (addToolHistoryCard) addToolHistoryCard("bash", isShellError(data), data, { command });
    else addMessage("system", typeof data.output === "string" && data.output ? data.output : "(no output)", isShellError(data) ? "error" : "");
  }

  function supportsCommand(name: string, source = "web") {
    const capabilities = activeSessionState(state)?.capabilities;
    if (source !== "web" && capabilities?.extensions === false) return false;
    if (["reload"].includes(name) && capabilities?.extensions === false) return false;
    if (["model", "models"].includes(name) && capabilities?.models === false) return false;
    if (name === "thinking" && capabilities?.thinkingLevel === false) return false;
    if (name === "compact" && capabilities?.compaction === false) return false;
    return true;
  }

  async function runSlashCommand(command: string) {
    const name = command.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase();
    if (!supportsCommand(name)) throw new Error(`/${name} is not supported by this harness.`);
    if (name === "logout") {
      try {
        const response = await fetch("/api/auth/logout", { method: "POST", headers: api.headers(), credentials: "same-origin" });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
      } catch (error) {
        throw new Error(`Logout failed; your server session may still be active. Retry when connected. ${error instanceof Error ? error.message : ""}`);
      }
      const challenge = await fetch("/api/auth/challenge").then(r => r.json()).catch(() => ({})) as { mode?: string; url?: string };
      stopTokenScanner();
      state.token = "";
      clearToken();
      if (challenge.mode === "redirect" && challenge.url) { location.assign(challenge.url); return; }
      elements.tokenInput.value = "";
      elements.tokenOverlay.hidden = false;
      elements.tokenInput.focus();
      return;
    }
    const res = await fetch("/api/command", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: state.currentSessionId, command }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new Error(data.error || text);
    const resetsSession = name === "new" || name === "clear";
    if (resetsSession) beginTranscriptLoading?.();
    if (data.state) {
      sessionState.applySnapshot(data.state, { activate: resetsSession });
      if (resetsSession && data.state.sessionId) writeActiveSessionIdToUrl(data.state.sessionId);
      if (data.state.thinkingLevels) updateThinkingOptions(data.state.thinkingLevels);
    }
    await refreshModels();
    if (name === "reload" || name === "commands") await refreshSlashCommands(true).catch(() => undefined);
    if (resetsSession) await refreshMessages();
    if (data.message && !resetsSession) addMessage("system", data.message);
  }

  function init() {
    // Keep textarea focus through pointer submission so compact mode cannot
    // hide the Send button between pointerdown and click on touch browsers.
    elements.primaryButton.addEventListener("pointerdown", (event) => event.preventDefault());

    elements.formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (preparingInput || nativeSubmitting) return;
      let activeRuntime = sessionRuntime(state);
      if ((activeRuntime.isStreaming || activeRuntime.isRetrying) && !elements.promptEl.value.trim() && state.attachedImages.length === 0 && contextAttachments.length === 0 && !quoteReplies.hasDrafts()) return;

      const rawMessage = elements.promptEl.value;
      const sourceSessionId = ownedSessionId;
      let sessionId = sourceSessionId;
      const promptMessage = rawMessage.trim();
      const contexts = [...contextAttachments];
      let quoteSubmission: QuoteReplySubmission | undefined;
      try {
        quoteSubmission = quoteReplies.prepareSubmission(promptMessage);
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const message = quoteSubmission?.message ?? promptMessage;
      const submittedAttachments = [...state.attachedImages];
      const attachments = [
        ...submittedAttachments.map(({ type, id, name, mediaType, bytes, path, contentUrl }) => ({ type, id, name, mediaType, bytes, path, contentUrl })),
        ...contexts,
        ...(quoteSubmission?.attachments || []),
      ];
      if (!message && attachments.length === 0) return;

      if (rawMessage.startsWith("!") && attachments.length === 0 && contexts.length === 0 && !quoteSubmission) {
        composerCapture.cancel();
        elements.promptEl.value = "";
        promptRevision += 1;
        clearDraft();
        hideSlashCommands();
        updatePrimaryAction();
        try {
          await runShellEscape(message);
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        } finally {
          settlePromptFocusAfterSubmit();
        }
        return;
      }

      if (rawMessage.startsWith("/") && attachments.length === 0 && contexts.length === 0 && !quoteSubmission) {
        let commandInfo: SlashCommand | undefined;
        try {
          commandInfo = await commandInfoForMessage(promptMessage);
        } catch {
          commandInfo = webSlashCommandNames.has(slashCommandName(promptMessage))
            ? { name: slashCommandName(promptMessage), source: "web" }
            : undefined;
        }

        if (!commandInfo || commandInfo.source === "web") {
          composerCapture.cancel();
          elements.promptEl.value = "";
          promptRevision += 1;
          clearDraft();
          hideSlashCommands();
          updatePrimaryAction();
          addMessage("system", `› ${promptMessage}`);
          try {
            await runSlashCommand(promptMessage);
          } catch (error) {
            addMessage("system", error instanceof Error ? error.message : String(error), "error");
          } finally {
            settlePromptFocusAfterSubmit();
          }
          return;
        }
      }

      try {
        preparingInput = true; updatePrimaryAction();
        const preparedSessionId = await prepareLandingSession?.();
        sessionId = preparedSessionId || sourceSessionId;
        // Only an intentional landing creation may transfer this submission.
        // A user switching tabs during preparation keeps the original draft.
        if (state.currentSessionId !== sessionId) return;
        activeRuntime = sessionRuntime(state);
        const view = activeSessionState(state);
        if (attachments.length && view?.capabilities?.attachments === false) throw new Error("Attachments are not supported by this harness. Remove them before sending.");
        if (isNativeSession(view) && activeRuntime.isRunning && (!view?.capabilities?.steering || !view.activeExecution)) throw new Error("Wait for the current native execution to finish before sending another prompt.");
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
        return;
      } finally { preparingInput = false; updatePrimaryAction(); }

      composerCapture.cancel();
      elements.promptEl.value = "";
      promptRevision += 1;
      clearDraft();
      hideSlashCommands();
      state.attachedImages = [];
      contextAttachments = [];
      rememberContextAttachments(sessionId);
      renderAttachments();
      const view = activeSessionState(state);
      const native = isNativeSession(view);
      const submittedWhileRunning = native ? activeRuntime.isRunning : activeRuntime.isStreaming || activeRuntime.isRetrying;
      const runtimeTransition = sessionState.patchRuntime(sessionId, {
        loaded: true,
        isStreaming: true,
        isRetrying: false,
      }, { kind: "start", label: "starting" });
      beginStreamFollow?.();
      const clientMessageId = crypto.randomUUID?.() || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      if (!submittedWhileRunning && !native) {
        optimisticUserMessages.add(clientMessageId);
        addMessage("user", message || "", "", attachments);
      }

      try {
        nativeSubmitting = native; updatePrimaryAction();
        const mode = native ? submittedWhileRunning ? "steer" : "prompt" : state.queueMode;
        const expectedExecutionId = native && submittedWhileRunning ? view?.activeExecution?.id : undefined;
        const res = await fetch("/api/prompt", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId, clientMessageId, message, mode, attachments, ...(expectedExecutionId ? { expectedExecutionId } : {}) }),
        });
        if (!res.ok) throw new Error(await res.text());
        if (quoteSubmission) quoteReplies.commitSubmission(quoteSubmission);
        if (sessionId !== sourceSessionId && drafts.get(sourceSessionId).text === rawMessage) drafts.update(sourceSessionId, { text: "" }, true);
        updatePrimaryAction();
      } catch (error) {
        optimisticUserMessages.delete(clientMessageId);
        sessionState.replaceRuntime(sessionId, runtimeTransition.previous);
        const failedDraft = drafts.get(sessionId);
        const restoredAttachments = [...submittedAttachments, ...failedDraft.attachments.filter((attachment) => !submittedAttachments.some(({ id }) => id === attachment.id))];
        drafts.update(sessionId, {
          text: failedDraft.text || rawMessage,
          attachments: restoredAttachments,
        }, true);
        if (ownedSessionId === sessionId) {
          state.attachedImages = restoredAttachments;
          if (!elements.promptEl.value) {
            // A capture may have started against the empty post-submit editor.
            // Invalidate its snapshot before restoring the failed submission so
            // a late transcript cannot splice itself into that restored text.
            composerCapture.cancel();
            elements.promptEl.value = rawMessage;
            promptRevision += 1;
          }
          if (contextAttachments.length === 0) contextAttachments = contexts;
          rememberContextAttachments(sessionId);
          renderAttachments();
          updatePrimaryAction();
        } else {
          sessionContextAttachments.set(sessionId, contexts);
        }
        endStreamFollow?.();
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      } finally {
        nativeSubmitting = false; updatePrimaryAction();
        settlePromptFocusAfterSubmit();
      }
    });

    elements.promptEl.addEventListener("keydown", (event) => {
      if (!elements.slashCommandsEl.hidden) {
        const commands = filteredSlashCommands();
        if (event.key === "ArrowDown" && commands.length > 0) {
          event.preventDefault();
          slashCommandSelectedIndex = (slashCommandSelectedIndex + 1) % commands.length;
          renderSlashCommands();
          return;
        }
        if (event.key === "ArrowUp" && commands.length > 0) {
          event.preventDefault();
          slashCommandSelectedIndex = (slashCommandSelectedIndex - 1 + commands.length) % commands.length;
          renderSlashCommands();
          return;
        }
        if (((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") && commands[slashCommandSelectedIndex]) {
          event.preventDefault();
          applySlashCommand(commands[slashCommandSelectedIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          hideSlashCommands();
          return;
        }
      }

    });

    // focusin fires before every focused child is guaranteed to be reflected by
    // document.activeElement on mobile WebKit. The event itself is authoritative.
    let pageIsUnloading = false;
    window.addEventListener("beforeunload", () => { pageIsUnloading = true; });
    elements.formEl.addEventListener("focusin", () => {
      applyCompactInactive(false);
      try { sessionStorage.setItem(restoreFocusStorageKey, "true"); } catch { /* ignore */ }
    });
    elements.formEl.addEventListener("focusout", () => window.setTimeout(() => {
      updateCompactInactive();
      if (!pageIsUnloading && !elements.formEl.contains(document.activeElement)) {
        try { sessionStorage.removeItem(restoreFocusStorageKey); } catch { /* ignore */ }
      }
    }, 0));
    elements.promptEl.addEventListener("focus", () => { void maybeRefreshSlashCommands(); });
    elements.promptEl.addEventListener("blur", () => window.setTimeout(hideSlashCommands, 100));
    elements.promptEl.addEventListener("input", () => {
      promptRevision += 1;
      persistDraft();
      updatePrimaryAction();
      updateCompactInactive();
      slashCommandSelectedIndex = 0;
      renderSlashCommands();
      void maybeRefreshSlashCommands();
    });

    const consumeCompactAttachClick = bindCompactInactiveAction(elements.attachButton, elements.formEl, () => {
      elements.imageInput.click();
    });
    elements.attachButton.addEventListener("click", (event) => {
      recordDebugEvent("attachment-picker-open", { compact: elements.formEl.classList.contains("compactInactive") });
      if (consumeCompactAttachClick(event)) return;
      elements.imageInput.click();
    });

    elements.imageInput.addEventListener("change", () => {
      const files = Array.from(elements.imageInput.files || []);
      recordDebugEvent("attachment-picker-change", { files: files.map(({ name, size, type }) => ({ name, size, type })) });
      elements.imageInput.value = "";
      void attachFiles(files);
    });

    let dragDepth = 0;
    elements.formEl.addEventListener("dragenter", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragOver(true);
    });
    elements.formEl.addEventListener("dragover", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    });
    elements.formEl.addEventListener("dragleave", (event) => {
      if (!hasDraggedFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragOver(false);
    });
    elements.formEl.addEventListener("drop", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragOver(false);
      void attachFiles(Array.from(event.dataTransfer?.files || []));
    });

    const consumeCompactStopClick = bindCompactInactiveAction(elements.stopButton, elements.formEl, () => {
      void stopStreaming();
    });
    elements.stopButton.addEventListener("click", (event) => {
      if (consumeCompactStopClick(event)) return;
      void stopStreaming();
    });

    elements.queueToggle.addEventListener("click", () => {
      state.queueMode = state.queueMode === "steer" ? "followUp" : "steer";
      updateQueueToggle();
      void persistComposerSettings({ queueMode: state.queueMode });
    });

    elements.tokenForm.addEventListener("submit", (e) => {
      e.preventDefault();
      connectWithToken(elements.tokenInput.value);
    });

    elements.tokenScanButton.addEventListener("click", () => {
      void startTokenScanner();
    });

    elements.tokenScanStopButton.addEventListener("click", () => {
      stopTokenScanner();
      elements.tokenScanButton.focus();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopTokenScanner();
    });

    elements.expandButton.addEventListener("click", () => {
      state.editorExpanded = !state.editorExpanded;
      elements.formEl.classList.toggle("expanded", state.editorExpanded);
      setIcon(elements.expandButton, state.editorExpanded ? "minimize-2" : "maximize-2");
      elements.expandButton.title = state.editorExpanded ? "Collapse editor" : "Expand editor";
      elements.expandButton.setAttribute("aria-label", elements.expandButton.title);
      try { sessionStorage.setItem(expandedStorageKey, JSON.stringify(state.editorExpanded)); } catch { /* ignore */ }
      focusIfKeyboardFriendly(elements.promptEl);
    });

    if (state.currentSessionId) switchSession(state.currentSessionId);

    let restoreFocus = false;
    try {
      restoreFocus = sessionStorage.getItem(restoreFocusStorageKey) === "true";
      sessionStorage.removeItem(restoreFocusStorageKey);
    } catch { /* ignore */ }

    if (restoreFocus) applyCompactInactive(false);
    else updateCompactInactive();
    // Defer until the browser has completed load-time focus and form-value
    // restoration before deriving compact state from the active draft.
    window.requestAnimationFrame(() => {
      if (restoreFocus) elements.promptEl.focus({ preventScroll: true });
      updateCompactInactive();
    });
  }

  return {
    init,
    addContextAttachment,
    setCaptureContributions: (contributions) => composerCapture.setContributions(contributions, ownedSessionId),
    syncCompactState: updateCompactInactive,
    renderAttachments,
    switchSession,
    setPromptText,
    stopStreaming,
    updatePrimaryAction,
    updateQueueToggle,
    updatePendingQueue,
    trackOptimisticUserMessage,
    discardOptimisticUserMessage,
    handleUserMessage,
  };
}
