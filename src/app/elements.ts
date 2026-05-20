export type AppElements = {
  messagesEl: HTMLDivElement;
  statusTitleEl: HTMLSpanElement;
  statusPathEl: HTMLSpanElement;
  connectionStatusEl: HTMLSpanElement;
  formEl: HTMLFormElement;
  contextMeterEl: HTMLButtonElement;
  contextMeterFillEl: HTMLSpanElement;
  contextMeterLabelEl: HTMLSpanElement;
  contextMeterPopoverEl: HTMLDivElement;
  promptEl: HTMLTextAreaElement;
  slashCommandsEl: HTMLDivElement;
  primaryButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  tokenOverlay: HTMLDivElement;
  tokenForm: HTMLFormElement;
  tokenInput: HTMLInputElement;
  sessionButton: HTMLButtonElement;
  expandButton: HTMLButtonElement;
  sessionDrawer: HTMLElement;
  sessionBackdrop: HTMLDivElement;
  sessionCloseButton: HTMLButtonElement;
  sessionNewButton: HTMLButtonElement;
  sessionListEl: HTMLDivElement;
  sessionBarEl: HTMLDivElement;
  repoInfoBarEl: HTMLDivElement;
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
  newSessionHeaderButton: HTMLButtonElement;
  conversationTreeButton: HTMLButtonElement;
  gitButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  settingsPanel: HTMLElement;
  settingsBackdrop: HTMLDivElement;
  settingsCloseButton: HTMLButtonElement;
  settingDensitySelect: HTMLSelectElement;
  settingQueueModeSelect: HTMLSelectElement;
  settingComposerExpandedCheckbox: HTMLInputElement;
  settingModelDefaultsValue: HTMLSpanElement;
  settingSaveModelDefaultsButton: HTMLButtonElement;
  settingClearModelDefaultsButton: HTMLButtonElement;
  settingsStatusEl: HTMLSpanElement;
  gitPanel: HTMLElement;
  emptyCwdChooserEl: HTMLDivElement;
  emptyCwdPathEl: HTMLDivElement;
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
    connectionStatusEl: requiredElement<HTMLSpanElement>("#connectionStatus"),
    formEl: requiredElement<HTMLFormElement>("#promptForm"),
    contextMeterEl: requiredElement<HTMLButtonElement>("#contextMeter"),
    contextMeterFillEl: requiredElement<HTMLSpanElement>("#contextMeterFill"),
    contextMeterLabelEl: requiredElement<HTMLSpanElement>("#contextMeterLabel"),
    contextMeterPopoverEl: requiredElement<HTMLDivElement>("#contextMeterPopover"),
    promptEl: requiredElement<HTMLTextAreaElement>("#prompt"),
    slashCommandsEl: requiredElement<HTMLDivElement>("#slashCommands"),
    primaryButton: requiredElement<HTMLButtonElement>("#primaryButton"),
    stopButton: requiredElement<HTMLButtonElement>("#stopButton"),
    tokenOverlay: requiredElement<HTMLDivElement>("#tokenOverlay"),
    tokenForm: requiredElement<HTMLFormElement>("#tokenForm"),
    tokenInput: requiredElement<HTMLInputElement>("#tokenInput"),
    sessionButton: requiredElement<HTMLButtonElement>("#sessionButton"),
    expandButton: requiredElement<HTMLButtonElement>("#expandButton"),
    sessionDrawer: requiredElement<HTMLElement>("#sessionDrawer"),
    sessionBackdrop: requiredElement<HTMLDivElement>("#sessionBackdrop"),
    sessionCloseButton: requiredElement<HTMLButtonElement>("#sessionCloseButton"),
    sessionNewButton: requiredElement<HTMLButtonElement>("#sessionNewButton"),
    sessionListEl: requiredElement<HTMLDivElement>("#sessionList"),
    sessionBarEl: requiredElement<HTMLDivElement>("#sessionBar"),
    repoInfoBarEl: requiredElement<HTMLDivElement>("#repoInfoBar"),
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
    newSessionHeaderButton: requiredElement<HTMLButtonElement>("#newSessionHeaderButton"),
    conversationTreeButton: requiredElement<HTMLButtonElement>("#conversationTreeButton"),
    gitButton: requiredElement<HTMLButtonElement>("#gitButton"),
    settingsButton: requiredElement<HTMLButtonElement>("#settingsButton"),
    settingsPanel: requiredElement<HTMLElement>("#settingsPanel"),
    settingsBackdrop: requiredElement<HTMLDivElement>("#settingsBackdrop"),
    settingsCloseButton: requiredElement<HTMLButtonElement>("#settingsCloseButton"),
    settingDensitySelect: requiredElement<HTMLSelectElement>("#settingDensitySelect"),
    settingQueueModeSelect: requiredElement<HTMLSelectElement>("#settingQueueModeSelect"),
    settingComposerExpandedCheckbox: requiredElement<HTMLInputElement>("#settingComposerExpandedCheckbox"),
    settingModelDefaultsValue: requiredElement<HTMLSpanElement>("#settingModelDefaultsValue"),
    settingSaveModelDefaultsButton: requiredElement<HTMLButtonElement>("#settingSaveModelDefaultsButton"),
    settingClearModelDefaultsButton: requiredElement<HTMLButtonElement>("#settingClearModelDefaultsButton"),
    settingsStatusEl: requiredElement<HTMLSpanElement>("#settingsStatus"),
    gitPanel: requiredElement<HTMLElement>("#gitPanel"),
    emptyCwdChooserEl: requiredElement<HTMLDivElement>("#emptyCwdChooser"),
    emptyCwdPathEl: requiredElement<HTMLDivElement>("#emptyCwdChooser .emptyCwdPath"),
    emptyCwdButton: requiredElement<HTMLButtonElement>("#emptyCwdChooser .emptyCwdButton"),
  };
}

export function syncAppHeight() {
  const vv = window.visualViewport;
  const height = vv?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);

  // Detect keyboard-open state: viewport shrinks significantly AND a text input is focused.
  // Used by CSS to hide non-essential chrome (session bar) on mobile.
  const activeTag = document.activeElement?.tagName;
  const inputFocused = activeTag === "TEXTAREA" || activeTag === "INPUT";
  const keyboardOpen = vv ? (inputFocused && height < window.innerHeight * 0.75) : false;
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
}

let _appHeightInitialized = false;

export function initAppHeightSync() {
  if (_appHeightInitialized) return;
  _appHeightInitialized = true;

  syncAppHeight();
  window.addEventListener("resize", syncAppHeight);
  window.addEventListener("orientationchange", () => {
    // iOS needs a short delay after orientation change for viewport to settle
    setTimeout(syncAppHeight, 100);
    setTimeout(syncAppHeight, 300);
  });
  window.visualViewport?.addEventListener("resize", syncAppHeight);
  window.visualViewport?.addEventListener("scroll", syncAppHeight);

  // On iOS, focusing an input can sometimes leave the page slightly scrolled
  // horizontally (due to prior zoom). Reset scroll on focus to prevent drift.
  document.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      window.scrollTo(0, 0);
    }
  });
}
