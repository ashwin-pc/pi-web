export function createHtmlPreviewGate(
  source: string,
  reporter: string,
  onMount: (frame: HTMLIFrameElement) => void,
) {
  const container = document.createElement("div");
  container.className = "htmlPreview htmlPreview--source htmlPreview--unarmed";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "HTML preview");

  const notice = document.createElement("div");
  notice.className = "htmlPreviewNotice";
  const inactiveNotice = "HTML preview is inactive. Review the source, then run it in a sandboxed frame.";
  const activeNotice = "HTML preview is active in a sandboxed frame.";
  notice.textContent = inactiveNotice;

  const header = document.createElement("div");
  header.className = "htmlPreviewHeader";

  const actions = document.createElement("div");
  actions.className = "htmlPreviewActions";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "htmlPreviewRun";
  run.textContent = "Run preview";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "htmlPreviewToggle";
  toggle.hidden = true;

  let frame: HTMLIFrameElement | undefined;
  const showSource = (showing: boolean) => {
    const pre = container.querySelector<HTMLPreElement>(":scope > pre");
    if (!pre || !frame) return;
    pre.hidden = !showing;
    frame.hidden = showing;
    container.classList.toggle("htmlPreview--source", showing);
    toggle.textContent = showing ? "Preview" : "Source";
    toggle.title = showing ? "Show interactive preview" : "Show HTML source";
    toggle.setAttribute("aria-label", toggle.title);
  };

  run.addEventListener("click", () => {
    if (frame) {
      frame.remove();
      frame = undefined;
      const pre = container.querySelector<HTMLPreElement>(":scope > pre");
      if (pre) pre.hidden = false;
      container.classList.add("htmlPreview--source", "htmlPreview--unarmed");
      container.classList.remove("htmlPreview--compact");
      container.style.width = "";
      delete container.dataset.pinnedAvailable;
      notice.textContent = inactiveNotice;
      run.textContent = "Run preview";
      toggle.hidden = true;
      return;
    }

    frame = document.createElement("iframe");
    frame.className = "htmlPreviewFrame";
    frame.title = "Interactive HTML preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = source + reporter;
    header.after(frame);
    onMount(frame);
    container.classList.remove("htmlPreview--unarmed");
    notice.textContent = activeNotice;
    run.textContent = "Stop preview";
    toggle.hidden = false;
    showSource(false);
  });
  toggle.addEventListener("click", () => showSource(frame?.hidden === false));
  actions.append(run, toggle);
  header.append(notice, actions);
  container.append(header);
  return container;
}
