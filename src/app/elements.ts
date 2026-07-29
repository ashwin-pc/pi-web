export type AppElements = {
  messagesEl: HTMLDivElement;
  statusTitleEl: HTMLSpanElement;
  statusPathEl: HTMLSpanElement;
  activityStatusEl: HTMLSpanElement;
  connectionStatusEl: HTMLSpanElement;
  formEl: HTMLFormElement;
  pendingMessagesEl: HTMLElement;
  extensionFooterEl: HTMLDivElement;
  contextMeterEl: HTMLButtonElement;
  contextMeterFillEl: HTMLSpanElement;
  runtimeStatusEl: HTMLSpanElement;
  contextMeterLabelEl: HTMLSpanElement;
  contextMeterPopoverEl: HTMLDivElement;
  promptEl: HTMLTextAreaElement;
  slashCommandsEl: HTMLDivElement;
  primaryButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  tokenOverlay: HTMLDivElement;
  tokenForm: HTMLFormElement;
  tokenInput: HTMLInputElement;
  tokenScanButton: HTMLButtonElement;
  tokenScanPanel: HTMLDivElement;
  tokenScanVideo: HTMLVideoElement;
  tokenScanStatus: HTMLSpanElement;
  tokenScanStopButton: HTMLButtonElement;
  sessionButton: HTMLButtonElement;
  expandButton: HTMLButtonElement;
  sessionDrawer: HTMLElement;
  sessionBackdrop: HTMLDivElement;
  sessionCloseButton: HTMLButtonElement;
  sessionNewButton: HTMLButtonElement;
  sessionListEl: HTMLDivElement;
  sessionBarEl: HTMLDivElement;
  queueToggle: HTMLButtonElement;
  attachButton: HTMLButtonElement;
  imageInput: HTMLInputElement;
  attachmentsEl: HTMLDivElement;
  modelControl: HTMLDivElement;
  modelSettingsButton: HTMLButtonElement;
  modelSettingsLabel: HTMLSpanElement;
  modelSettingsThinking: HTMLSpanElement;
  modelSettingsPopover: HTMLDivElement;
  modelSelectEl: HTMLSelectElement;
  thinkingSelectEl: HTMLSelectElement;
  headerActionsEl: HTMLSpanElement;
  sessionInfoButton: HTMLButtonElement;
  sessionInfoPopover: HTMLDivElement;
  sessionInfoId: HTMLButtonElement;
  sessionInfoCwd: HTMLButtonElement;
  sessionInfoGit: HTMLButtonElement;
  sessionInfoGitCount: HTMLSpanElement;
  newSessionHeaderButton: HTMLButtonElement;
  conversationTreeButton: HTMLButtonElement;
  filesButton: HTMLButtonElement;
  filesPanel: HTMLElement;
  gitButton: HTMLButtonElement;
  currentSessionBucketButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  settingsPanel: HTMLElement;
  settingsBackdrop: HTMLDivElement;
  settingsCloseButton: HTMLButtonElement;
  settingDensitySelect: HTMLSelectElement;
  settingLoadingAnimationSelect: HTMLSelectElement;
  settingAccentMenuButton: HTMLButtonElement;
  settingAccentMenuName: HTMLSpanElement;
  settingAccentMenuValue: HTMLSpanElement;
  settingAccentPopover: HTMLDivElement;
  settingAccentColorInput: HTMLInputElement;
  settingAccentPreviewButton: HTMLButtonElement;
  settingAccentCancelButton: HTMLButtonElement;
  settingAccentApplyButton: HTMLButtonElement;
  settingQueueModeSelect: HTMLSelectElement;
  settingComposerExpandedCheckbox: HTMLInputElement;
  settingDefaultBucketColorSelect: HTMLSelectElement;
  settingModelDefaultsValue: HTMLSpanElement;
  settingSaveModelDefaultsButton: HTMLButtonElement;
  settingClearModelDefaultsButton: HTMLButtonElement;
  extensionStatusBadge: HTMLSpanElement;
  extensionStatusMessage: HTMLParagraphElement;
  extensionStatusDetails: HTMLDivElement;
  extensionReloadButton: HTMLButtonElement;
  settingsStatusEl: HTMLSpanElement;
  tokenShareSection: HTMLElement;
  tokenShareQr: HTMLDivElement;
  tokenShareUrl: HTMLInputElement;
  tokenShareFullscreenButton: HTMLButtonElement;
  tokenShareCopyButton: HTMLButtonElement;
  tokenShareFullscreen: HTMLDivElement;
  tokenShareFullscreenQr: HTMLDivElement;
  tokenShareFullscreenCloseButton: HTMLButtonElement;
  gitPanel: HTMLElement;
  emptyCwdChooserEl: HTMLDivElement;
  emptyCwdPathEl: HTMLSpanElement;
  emptyCwdButton: HTMLButtonElement;
};

export function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required DOM node: ${selector}`);
  return element;
}

export function getAppElements(): AppElements {
  return {
    messagesEl: requiredElement<HTMLDivElement>("#messages"),
    statusTitleEl: requiredElement<HTMLSpanElement>("#statusTitle"),
    statusPathEl: requiredElement<HTMLSpanElement>("#statusPath"),
    activityStatusEl: requiredElement<HTMLSpanElement>("#activityStatus"),
    connectionStatusEl: requiredElement<HTMLSpanElement>("#connectionStatus"),
    formEl: requiredElement<HTMLFormElement>("#promptForm"),
    pendingMessagesEl: requiredElement<HTMLElement>("#pendingMessages"),
    extensionFooterEl: requiredElement<HTMLDivElement>("#extensionFooter"),
    contextMeterEl: requiredElement<HTMLButtonElement>("#contextMeter"),
    contextMeterFillEl: requiredElement<HTMLSpanElement>("#contextMeterFill"),
    runtimeStatusEl: requiredElement<HTMLSpanElement>("#runtimeStatus"),
    contextMeterLabelEl: requiredElement<HTMLSpanElement>("#contextMeterLabel"),
    contextMeterPopoverEl: requiredElement<HTMLDivElement>("#contextMeterPopover"),
    promptEl: requiredElement<HTMLTextAreaElement>("#prompt"),
    slashCommandsEl: requiredElement<HTMLDivElement>("#slashCommands"),
    primaryButton: requiredElement<HTMLButtonElement>("#primaryButton"),
    stopButton: requiredElement<HTMLButtonElement>("#stopButton"),
    tokenOverlay: requiredElement<HTMLDivElement>("#tokenOverlay"),
    tokenForm: requiredElement<HTMLFormElement>("#tokenForm"),
    tokenInput: requiredElement<HTMLInputElement>("#tokenInput"),
    tokenScanButton: requiredElement<HTMLButtonElement>("#tokenScanButton"),
    tokenScanPanel: requiredElement<HTMLDivElement>("#tokenScanPanel"),
    tokenScanVideo: requiredElement<HTMLVideoElement>("#tokenScanVideo"),
    tokenScanStatus: requiredElement<HTMLSpanElement>("#tokenScanStatus"),
    tokenScanStopButton: requiredElement<HTMLButtonElement>("#tokenScanStopButton"),
    sessionButton: requiredElement<HTMLButtonElement>("#sessionButton"),
    expandButton: requiredElement<HTMLButtonElement>("#expandButton"),
    sessionDrawer: requiredElement<HTMLElement>("#sessionDrawer"),
    sessionBackdrop: requiredElement<HTMLDivElement>("#sessionBackdrop"),
    sessionCloseButton: requiredElement<HTMLButtonElement>("#sessionCloseButton"),
    sessionNewButton: requiredElement<HTMLButtonElement>("#sessionNewButton"),
    sessionListEl: requiredElement<HTMLDivElement>("#sessionList"),
    sessionBarEl: requiredElement<HTMLDivElement>("#sessionBar"),
    queueToggle: requiredElement<HTMLButtonElement>("#queueToggle"),
    attachButton: requiredElement<HTMLButtonElement>("#attachButton"),
    imageInput: requiredElement<HTMLInputElement>("#imageInput"),
    attachmentsEl: requiredElement<HTMLDivElement>("#attachments"),
    modelControl: requiredElement<HTMLDivElement>("#modelControl"),
    modelSettingsButton: requiredElement<HTMLButtonElement>("#modelSettingsButton"),
    modelSettingsLabel: requiredElement<HTMLSpanElement>("#modelSettingsLabel"),
    modelSettingsThinking: requiredElement<HTMLSpanElement>("#modelSettingsThinking"),
    modelSettingsPopover: requiredElement<HTMLDivElement>("#modelSettingsPopover"),
    modelSelectEl: requiredElement<HTMLSelectElement>("#modelSelect"),
    thinkingSelectEl: requiredElement<HTMLSelectElement>("#thinkingSelect"),
    headerActionsEl: requiredElement<HTMLSpanElement>("#headerActions"),
    sessionInfoButton: requiredElement<HTMLButtonElement>("#sessionInfoButton"),
    sessionInfoPopover: requiredElement<HTMLDivElement>("#sessionInfoPopover"),
    sessionInfoId: requiredElement<HTMLButtonElement>("#sessionInfoId"),
    sessionInfoCwd: requiredElement<HTMLButtonElement>("#sessionInfoCwd"),
    sessionInfoGit: requiredElement<HTMLButtonElement>("#sessionInfoGit"),
    sessionInfoGitCount: requiredElement<HTMLSpanElement>("#sessionInfoGitCount"),
    newSessionHeaderButton: requiredElement<HTMLButtonElement>("#newSessionHeaderButton"),
    conversationTreeButton: requiredElement<HTMLButtonElement>("#conversationTreeButton"),
    filesButton: requiredElement<HTMLButtonElement>("#filesButton"),
    filesPanel: requiredElement<HTMLElement>("#filesPanel"),
    gitButton: requiredElement<HTMLButtonElement>("#gitButton"),
    currentSessionBucketButton: requiredElement<HTMLButtonElement>("#currentSessionBucketButton"),
    settingsButton: requiredElement<HTMLButtonElement>("#settingsButton"),
    settingsPanel: requiredElement<HTMLElement>("#settingsPanel"),
    settingsBackdrop: requiredElement<HTMLDivElement>("#settingsBackdrop"),
    settingsCloseButton: requiredElement<HTMLButtonElement>("#settingsCloseButton"),
    settingDensitySelect: requiredElement<HTMLSelectElement>("#settingDensitySelect"),
    settingLoadingAnimationSelect: requiredElement<HTMLSelectElement>("#settingLoadingAnimationSelect"),
    settingAccentMenuButton: requiredElement<HTMLButtonElement>("#settingAccentMenuButton"),
    settingAccentMenuName: requiredElement<HTMLSpanElement>("#settingAccentMenuName"),
    settingAccentMenuValue: requiredElement<HTMLSpanElement>("#settingAccentMenuValue"),
    settingAccentPopover: requiredElement<HTMLDivElement>("#settingAccentPopover"),
    settingAccentColorInput: requiredElement<HTMLInputElement>("#settingAccentColorInput"),
    settingAccentPreviewButton: requiredElement<HTMLButtonElement>("#settingAccentPreviewButton"),
    settingAccentCancelButton: requiredElement<HTMLButtonElement>("#settingAccentCancelButton"),
    settingAccentApplyButton: requiredElement<HTMLButtonElement>("#settingAccentApplyButton"),
    settingQueueModeSelect: requiredElement<HTMLSelectElement>("#settingQueueModeSelect"),
    settingComposerExpandedCheckbox: requiredElement<HTMLInputElement>("#settingComposerExpandedCheckbox"),
    settingDefaultBucketColorSelect: requiredElement<HTMLSelectElement>("#settingDefaultBucketColorSelect"),
    settingModelDefaultsValue: requiredElement<HTMLSpanElement>("#settingModelDefaultsValue"),
    settingSaveModelDefaultsButton: requiredElement<HTMLButtonElement>("#settingSaveModelDefaultsButton"),
    settingClearModelDefaultsButton: requiredElement<HTMLButtonElement>("#settingClearModelDefaultsButton"),
    extensionStatusBadge: requiredElement<HTMLSpanElement>("#extensionStatusBadge"),
    extensionStatusMessage: requiredElement<HTMLParagraphElement>("#extensionStatusMessage"),
    extensionStatusDetails: requiredElement<HTMLDivElement>("#extensionStatusDetails"),
    extensionReloadButton: requiredElement<HTMLButtonElement>("#extensionReloadButton"),
    settingsStatusEl: requiredElement<HTMLSpanElement>("#settingsStatus"),
    tokenShareSection: requiredElement<HTMLElement>("#tokenShareSection"),
    tokenShareQr: requiredElement<HTMLDivElement>("#tokenShareQr"),
    tokenShareUrl: requiredElement<HTMLInputElement>("#tokenShareUrl"),
    tokenShareFullscreenButton: requiredElement<HTMLButtonElement>("#tokenShareFullscreenButton"),
    tokenShareCopyButton: requiredElement<HTMLButtonElement>("#tokenShareCopyButton"),
    tokenShareFullscreen: requiredElement<HTMLDivElement>("#tokenShareFullscreen"),
    tokenShareFullscreenQr: requiredElement<HTMLDivElement>("#tokenShareFullscreenQr"),
    tokenShareFullscreenCloseButton: requiredElement<HTMLButtonElement>("#tokenShareFullscreenCloseButton"),
    gitPanel: requiredElement<HTMLElement>("#gitPanel"),
    emptyCwdChooserEl: requiredElement<HTMLDivElement>("#emptyCwdChooser"),
    emptyCwdPathEl: requiredElement<HTMLSpanElement>("#emptyCwdChooser .emptyCwdPath"),
    emptyCwdButton: requiredElement<HTMLButtonElement>("#emptyCwdChooser .emptyCwdButton"),
  };
}

export function syncAppHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  // iOS Safari can scroll the document body when focusing an input near the
  // bottom of the viewport (keyboard appearance). With our fixed-height,
  // overflow:hidden layout that just leaves part of the UI — e.g. the
  // composer footer or send button — visually clipped at the edges of the
  // visual viewport. Snap any stray scroll back to the top.
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0);
  }
}

export function initAppHeightSync() {
  syncAppHeight();
  window.addEventListener("resize", syncAppHeight);
  window.visualViewport?.addEventListener("resize", syncAppHeight);
  window.visualViewport?.addEventListener("scroll", syncAppHeight);
  // iOS Safari ignores `html, body { overflow: hidden }` when the user types
  // in a focused textarea: it scrolls the document horizontally to keep the
  // caret in view, which clips the composer footer (send button) at the right
  // edge. The visualViewport `scroll` event does NOT fire for document scroll,
  // so we also need a window-level scroll listener to snap back.
  window.addEventListener("scroll", syncAppHeight, { passive: true });
  // After focusing an input, iOS may scroll once more on the next frame;
  // schedule a follow-up snap-back so the UI never lands offset.
  document.addEventListener("focusin", () => {
    requestAnimationFrame(syncAppHeight);
  }, { passive: true });
}
