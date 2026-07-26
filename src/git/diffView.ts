import { ArrowLeft, Columns2, createElement, Rows2 } from "lucide";
import { renderUnifiedPatch, setDiffLayout } from "../components/diff.js";
import type { GitFileStatus } from "./types.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function mobileDefaultStacked() {
  return window.matchMedia("(max-width: 700px)").matches;
}

function isImagePath(path: string) {
  const lower = path.toLowerCase();
  return [...imageExtensions].some((extension) => lower.endsWith(extension));
}

function imageFileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function gitImageUrl(file: GitFileStatus, repo: string | undefined, version: "before" | "after", sessionId?: string) {
  const query = new URLSearchParams({
    path: file.path,
    version,
    staged: file.staged && file.worktreeStatus === " " ? "1" : "0",
  });
  if (file.oldPath) query.set("oldPath", file.oldPath);
  if (repo) query.set("repo", repo);
  if (sessionId) query.set("sessionId", sessionId);
  return `/api/git/image?${query}`;
}

async function loadPreviewImage(container: HTMLElement, url: string, headers: HeadersInit, alt: string) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const image = document.createElement("img");
    image.src = objectUrl;
    image.alt = alt;
    image.addEventListener("load", () => container.classList.add("loaded"), { once: true });
    container.textContent = "";
    container.append(image);
  } catch {
    container.textContent = "No image";
  }
}

function renderImageDiff(options: { file: GitFileStatus; repo?: string; apiHeaders: () => HeadersInit; sessionId?: string }) {
  const { file, repo, apiHeaders, sessionId } = options;
  const wrapper = document.createElement("div");
  wrapper.className = "gitImageDiff";

  const before = createImagePane("Before", file.oldPath ? imageFileName(file.oldPath) : imageFileName(file.path));
  const after = createImagePane("After", imageFileName(file.path));
  wrapper.append(before.pane, after.pane);

  void loadPreviewImage(before.preview, gitImageUrl(file, repo, "before", sessionId), apiHeaders(), `Before ${file.path}`);
  void loadPreviewImage(after.preview, gitImageUrl(file, repo, "after", sessionId), apiHeaders(), `After ${file.path}`);
  return wrapper;
}

function createImagePane(titleText: string, fileName: string) {
  const pane = document.createElement("section");
  pane.className = "gitImagePane";
  const title = document.createElement("h4");
  title.textContent = titleText;
  const name = document.createElement("div");
  name.className = "gitImageName";
  name.textContent = fileName;
  const preview = document.createElement("div");
  preview.className = "gitImagePreview";
  preview.textContent = "Loading image…";
  pane.append(title, name, preview);
  return { pane, preview };
}

export function renderUnifiedDiff(diff: string) {
  const wrapper = document.createElement("div");
  const toolbar = document.createElement("div");
  toolbar.className = "diffToolbar gitDiffToolbar";
  const label = document.createElement("span");
  const fileCount = (diff.match(/^diff --git /gm) || []).length;
  label.textContent = `${fileCount || 1} file${fileCount === 1 ? "" : "s"}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diffLayoutToggle";

  let stacked = mobileDefaultStacked();
  const patch = renderUnifiedPatch(diff, { stacked });
  const updateToggle = () => {
    toggle.replaceChildren(createElement(stacked ? Columns2 : Rows2, { "aria-hidden": "true" }));
    const text = stacked ? "Switch to side-by-side diff view" : "Switch to top/bottom diff view";
    toggle.title = text;
    toggle.setAttribute("aria-label", text);
  };
  toggle.addEventListener("click", () => {
    stacked = !stacked;
    setDiffLayout(patch, stacked);
    updateToggle();
  });
  updateToggle();
  toolbar.append(label, toggle);
  wrapper.append(toolbar, patch);
  return wrapper;
}

export function renderDiffView(options: {
  container: HTMLElement;
  file?: GitFileStatus;
  repo?: string;
  diff?: string;
  loading?: boolean;
  apiHeaders: () => HeadersInit;
  sessionId?: string;
  onBack?: () => void;
}) {
  const { container, file, repo, diff, loading, apiHeaders, sessionId, onBack } = options;
  container.textContent = "";
  const header = document.createElement("div");
  header.className = "gitDetailHeader";
  if (onBack) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "gitBackButton";
    back.replaceChildren(createElement(ArrowLeft, { "aria-hidden": "true" }));
    back.setAttribute("aria-label", "Back to changed files");
    back.title = "Back to changed files";
    back.addEventListener("click", onBack);
    header.append(back);
  }
  const title = document.createElement("h3");
  title.textContent = file ? file.path : "Diff";
  header.append(title);
  container.append(header);

  if (!file) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Select a file to view its diff.";
    container.append(empty);
    return;
  }
  if (loading) {
    const el = document.createElement("div");
    el.className = "gitEmpty";
    el.textContent = "Loading diff…";
    container.append(el);
    return;
  }

  if (isImagePath(file.path) || Boolean(file.oldPath && isImagePath(file.oldPath))) {
    container.append(renderImageDiff({ file, repo, apiHeaders, sessionId }));
    return;
  }

  if (!diff) {
    const el = document.createElement("div");
    el.className = "gitEmpty";
    el.textContent = "No diff available.";
    container.append(el);
    return;
  }

  container.append(renderUnifiedDiff(diff));
}
