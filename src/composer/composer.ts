import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { clearToken, saveToken, writeActiveSessionIdToUrl } from "../app/types.js";
import type { AppState, ComposerContextAttachment, ImageAttachment, SlashCommand } from "../app/types.js";
import { iconElement, setIcon } from "../app/icons.js";
import { focusIfKeyboardFriendly } from "../app/focus.js";
import { extractTokenFromScannedText } from "../token/tokenShare.js";
import { bindCompactInactiveAction } from "./compactInteractions.js";

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

export type ComposerController = {
  init: () => void;
  addContextAttachment: (context: ComposerContextAttachment) => void;
  renderAttachments: () => void;
  setPromptText: (text: string) => void;
  stopStreaming: () => Promise<void>;
  updatePrimaryAction: () => void;
  updateQueueToggle: () => void;
  updatePendingQueue: (steering: unknown, followUp: unknown) => void;
  handleUserMessage: (text: string, images?: any[]) => boolean;
};

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      const data = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      resolve({ type: "image", data, mimeType: file.type, name: file.name });
    });
    reader.addEventListener("error", () => reject(reader.error || new Error(`Could not read ${file.name}`)));
    reader.readAsDataURL(file);
  });
}

export function createComposer(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  addMessage: (role: "user" | "system", text: string, extraClass?: string, images?: any[]) => void;
  addToolHistoryCard?: (toolName: string, isError: boolean, result: unknown, args?: Record<string, unknown>) => void;
  updateMeta: (data: any) => void;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  beginTranscriptLoading?: () => void;
  beginStreamFollow?: () => void;
  endStreamFollow?: () => void;
}): ComposerController {
  const { state, elements, api, addMessage, addToolHistoryCard, updateMeta, updateThinkingOptions, refreshModels, refreshMessages, refreshState, beginTranscriptLoading, beginStreamFollow, endStreamFollow } = options;

  const webSlashCommandNames = new Set(["help", "?", "commands", "reload", "model", "models", "thinking", "new", "clear", "compact", "abort", "stop", "logout"]);
  const slashCommandCacheMs = 5_000;
  const draftStorageKey = "pi-web-composer-draft";
  const expandedStorageKey = "pi-web-composer-expanded";
  let slashCommands: SlashCommand[] = [];
  let slashCommandsLoadedAt = 0;
  let slashCommandSelectedIndex = 0;
  let tokenScanStream: MediaStream | undefined;
  let tokenScanFrame = 0;
  let tokenScanActive = false;
  let contextAttachments: ComposerContextAttachment[] = [];
  let pendingSteering: string[] = [];
  let pendingFollowUp: string[] = [];
  const optimisticUserMessages = new Map<string, number>();

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

  function handleUserMessage(text: string, images: any[] = []) {
    const optimisticCount = optimisticUserMessages.get(text) || 0;
    if (optimisticCount > 0) {
      if (optimisticCount === 1) optimisticUserMessages.delete(text);
      else optimisticUserMessages.set(text, optimisticCount - 1);
      return true;
    }
    addMessage("user", text, "", images);
    return true;
  }

  function updatePrimaryAction() {
    const hasInput = !!elements.promptEl.value.trim() || state.attachedImages.length > 0 || contextAttachments.length > 0;
    const initialRealtimeReady = state.initialSyncComplete && state.wsHasOpened;
    elements.primaryButton.disabled = !hasInput || !initialRealtimeReady;
    elements.primaryButton.title = initialRealtimeReady ? "Send" : "Connecting live updates…";
    elements.stopButton.style.display = state.isStreaming || state.isRetrying ? "" : "none";
  }

  function updateQueueToggle() {
    const isSteer = state.queueMode === "steer";
    elements.queueToggle.setAttribute("aria-pressed", String(isSteer));
    elements.queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
    elements.queueToggle.setAttribute("aria-label", elements.queueToggle.title);
    setIcon(elements.queueToggle, isSteer ? "route" : "corner-down-right");
  }

  function updateCompactInactive() {
    const active = document.activeElement;
    elements.formEl.classList.toggle("compactInactive", !active || !elements.formEl.contains(active));
  }

  async function stopStreaming() {
    if (!state.currentSessionId) return;
    await fetch("/api/abort", { method: "POST", headers: api.headers(), body: JSON.stringify({ sessionId: state.currentSessionId }) });
  }

  function persistDraft() {
    try {
      const value = elements.promptEl.value;
      if (value) localStorage.setItem(draftStorageKey, value);
      else localStorage.removeItem(draftStorageKey);
    } catch { /* ignore */ }
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
    try { localStorage.removeItem(draftStorageKey); } catch { /* ignore */ }
  }

  function settlePromptFocusAfterSubmit() {
    if (!focusIfKeyboardFriendly(elements.promptEl)) elements.promptEl.blur();
  }

  function setPromptText(text: string) {
    elements.promptEl.value = text;
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
    if (!force && slashCommands.length > 0 && now - slashCommandsLoadedAt < slashCommandCacheMs) return slashCommands;
    const res = await fetch(`/api/commands?sessionId=${encodeURIComponent(state.currentSessionId)}`, { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    slashCommands = Array.isArray(data.commands) ? data.commands : [];
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
      empty.textContent = slashCommands.length === 0 ? "Loading slash commands…" : "No matching slash commands";
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

  async function attachImageFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (files.length > 0 && imageFiles.length === 0) {
      addMessage("system", "Only image attachments are supported.", "error");
      return;
    }
    if (imageFiles.length !== files.length) addMessage("system", "Some dropped files were skipped because only image attachments are supported.");
    try {
      const images = await Promise.all(imageFiles.map(fileToImageAttachment));
      state.attachedImages.push(...images);
      renderAttachments();
      updatePrimaryAction();
      hideSlashCommands();
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types || []).some((type) => type.toLowerCase() === "files");
  }

  function setDragOver(active: boolean) {
    elements.formEl.classList.toggle("dragOver", active);
  }

  function addContextAttachment(context: ComposerContextAttachment) {
    const existingIndex = context.id
      ? contextAttachments.findIndex((attachment) => attachment.id === context.id)
      : -1;
    if (existingIndex >= 0) contextAttachments[existingIndex] = context;
    else contextAttachments.push(context);
    renderAttachments();
    updatePrimaryAction();
    hideSlashCommands();
    focusIfKeyboardFriendly(elements.promptEl);
  }

  function renderAttachments() {
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
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      preview.alt = "";

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

  function messageWithAttachedContext(message: string, contexts: ComposerContextAttachment[]) {
    if (contexts.length === 0) return message;
    const attachedContext = contexts.map((context) => [
      `--- Attached context: ${context.label} ---`,
      context.content,
      `--- End attached context: ${context.label} ---`,
    ].join("\n")).join("\n\n");
    return message ? `${attachedContext}\n\n${message}` : attachedContext;
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
      state.currentSessionId = sessionId;
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

  async function runSlashCommand(command: string) {
    const name = command.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase();
    if (name === "logout") {
      stopTokenScanner();
      state.token = "";
      clearToken();
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
      updateMeta(data.state);
      if (resetsSession && data.state.sessionId) writeActiveSessionIdToUrl(data.state.sessionId);
      state.isStreaming = Boolean(data.state.isStreaming);
      state.isRetrying = Boolean(data.state.isRetrying || data.state.runtime?.isRetrying);
      updatePrimaryAction();
      if (data.state.thinkingLevels) updateThinkingOptions(data.state.thinkingLevels);
    }
    await refreshModels();
    if (name === "reload" || name === "commands") await refreshSlashCommands(true).catch(() => undefined);
    if (resetsSession) await refreshMessages();
    if (data.message && !resetsSession) addMessage("system", data.message);
  }

  function init() {
    elements.formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if ((state.isStreaming || state.isRetrying) && !elements.promptEl.value.trim() && state.attachedImages.length === 0 && contextAttachments.length === 0) return;

      const rawMessage = elements.promptEl.value;
      const promptMessage = rawMessage.trim();
      const contexts = [...contextAttachments];
      const message = messageWithAttachedContext(promptMessage, contexts);
      const images = state.attachedImages.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
      if (!message && images.length === 0) return;

      if (rawMessage.startsWith("!") && images.length === 0 && contexts.length === 0) {
        elements.promptEl.value = "";
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

      if (rawMessage.startsWith("/") && images.length === 0 && contexts.length === 0) {
        let commandInfo: SlashCommand | undefined;
        try {
          commandInfo = await commandInfoForMessage(promptMessage);
        } catch {
          commandInfo = webSlashCommandNames.has(slashCommandName(promptMessage))
            ? { name: slashCommandName(promptMessage), source: "web" }
            : undefined;
        }

        if (!commandInfo || commandInfo.source === "web") {
          elements.promptEl.value = "";
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

      elements.promptEl.value = "";
      clearDraft();
      hideSlashCommands();
      state.attachedImages = [];
      contextAttachments = [];
      renderAttachments();
      const submittedWhileRunning = state.isStreaming || state.isRetrying;
      state.isStreaming = true;
      state.isRetrying = false;
      updatePrimaryAction();
      beginStreamFollow?.();
      if (!submittedWhileRunning) {
        optimisticUserMessages.set(message, (optimisticUserMessages.get(message) || 0) + 1);
        addMessage("user", message || "", "", images.map((img) => ({ data: img.data, mimeType: img.mimeType })));
      }

      try {
        const res = await fetch("/api/prompt", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: state.currentSessionId, message, mode: state.queueMode, images }),
        });
        if (!res.ok) throw new Error(await res.text());
      } catch (error) {
        state.isStreaming = false;
        state.isRetrying = false;
        updatePrimaryAction();
        endStreamFollow?.();
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      } finally {
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

      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        elements.formEl.requestSubmit();
      }
    });

    elements.formEl.addEventListener("focusin", updateCompactInactive);
    elements.formEl.addEventListener("focusout", () => window.setTimeout(updateCompactInactive, 0));
    elements.promptEl.addEventListener("focus", () => { void maybeRefreshSlashCommands(); });
    elements.promptEl.addEventListener("blur", () => window.setTimeout(hideSlashCommands, 100));
    elements.promptEl.addEventListener("input", () => {
      persistDraft();
      updatePrimaryAction();
      slashCommandSelectedIndex = 0;
      renderSlashCommands();
      void maybeRefreshSlashCommands();
    });

    const consumeCompactAttachClick = bindCompactInactiveAction(elements.attachButton, elements.formEl, () => {
      elements.imageInput.click();
    });
    elements.attachButton.addEventListener("click", (event) => {
      if (consumeCompactAttachClick(event)) return;
      elements.imageInput.click();
    });

    elements.imageInput.addEventListener("change", () => {
      const files = Array.from(elements.imageInput.files || []);
      elements.imageInput.value = "";
      void attachImageFiles(files);
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
      void attachImageFiles(Array.from(event.dataTransfer?.files || []));
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

    try {
      const draft = localStorage.getItem(draftStorageKey);
      if (draft && !elements.promptEl.value) {
        elements.promptEl.value = draft;
        updatePrimaryAction();
      }
    } catch { /* ignore */ }
    updateCompactInactive();
  }

  return {
    init,
    addContextAttachment,
    renderAttachments,
    setPromptText,
    stopStreaming,
    updatePrimaryAction,
    updateQueueToggle,
    updatePendingQueue,
    handleUserMessage,
  };
}
