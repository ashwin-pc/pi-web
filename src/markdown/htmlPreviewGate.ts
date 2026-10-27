export type HtmlPreviewGateOptions = {
  source: string;
  mount: (frame: HTMLIFrameElement) => void;
  sourceElement?: HTMLPreElement;
  showSourceInitially?: boolean;
  frameClassName?: string;
  frameTitle?: string;
  onMount?: (frame: HTMLIFrameElement) => void;
  onStop?: () => void;
};

function createSourceElement(source: string) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-html";
  code.textContent = source;
  pre.append(code);
  return pre;
}

export function createHtmlPreviewGate(options: HtmlPreviewGateOptions) {
  const {
    source,
    mount,
    sourceElement = createSourceElement(source),
    showSourceInitially = true,
    frameClassName = "htmlPreviewFrame",
    frameTitle = "Interactive HTML preview",
    onMount,
    onStop,
  } = options;
  const container = document.createElement("div");
  container.className = "htmlPreview htmlPreview--unarmed";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "HTML preview");

  const header = document.createElement("div");
  header.className = "htmlPreviewHeader";

  const status = document.createElement("span");
  status.className = "htmlPreviewStatus";

  const actions = document.createElement("div");
  actions.className = "htmlPreviewActions";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "htmlPreviewRun";
  run.textContent = "Run preview";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "htmlPreviewToggle";

  let frame: HTMLIFrameElement | undefined;
  let showingSource = showSourceInitially;
  const placeholder = document.createElement("div");
  placeholder.className = "htmlPreviewPlaceholder";
  placeholder.textContent = "HTML preview is inactive.";

  const renderState = () => {
    sourceElement.hidden = !showingSource;
    placeholder.hidden = showingSource || Boolean(frame);
    if (frame) frame.hidden = showingSource;
    container.classList.toggle("htmlPreview--source", showingSource);
    status.textContent = frame ? (showingSource ? "Running · source" : "Running") : (showingSource ? "Inactive · source" : "Inactive");
    toggle.hidden = !frame && showSourceInitially;
    toggle.textContent = showingSource ? (frame ? "Preview" : "Hide source") : "Source";
    toggle.title = showingSource
      ? (frame ? "Show interactive preview" : "Hide HTML source")
      : "Show HTML source";
    toggle.setAttribute("aria-label", toggle.title);
  };

  run.addEventListener("click", () => {
    if (frame) {
      frame.remove();
      frame = undefined;
      showingSource = showSourceInitially;
      container.classList.add("htmlPreview--unarmed");
      container.classList.remove("htmlPreview--compact");
      container.style.width = "";
      delete container.dataset.pinnedAvailable;
      run.textContent = "Run preview";
      onStop?.();
      renderState();
      return;
    }

    frame = document.createElement("iframe");
    frame.className = frameClassName;
    frame.title = frameTitle;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    mount(frame);
    header.after(frame);
    onMount?.(frame);
    container.classList.remove("htmlPreview--unarmed");
    run.textContent = "Stop preview";
    showingSource = false;
    renderState();
  });
  toggle.addEventListener("click", () => {
    showingSource = !showingSource;
    renderState();
  });
  actions.append(run, toggle);
  header.append(status, actions);
  container.append(header, sourceElement, placeholder);
  renderState();
  return container;
}
