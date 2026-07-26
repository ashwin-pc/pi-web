import { ArrowLeft, createElement } from "lucide";
import { renderUnifiedDiff } from "./diffView.js";
import type { GitCommit, GitCommitFile } from "./types.js";

export function renderCommitView(options: {
  container: HTMLElement;
  commit?: GitCommit;
  files?: GitCommitFile[];
  diff?: string;
  loading?: boolean;
  onBack?: () => void;
}) {
  const { container, commit, files = [], diff = "", loading, onBack } = options;
  container.textContent = "";
  const header = document.createElement("div");
  header.className = "gitDetailHeader";
  if (onBack) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "gitBackButton";
    back.replaceChildren(createElement(ArrowLeft, { "aria-hidden": "true" }));
    back.setAttribute("aria-label", "Back to commit graph");
    back.title = "Back to commit graph";
    back.addEventListener("click", onBack);
    header.append(back);
  }
  const title = document.createElement("h3");
  title.textContent = "Commit";
  header.append(title);
  container.append(header);

  if (!commit) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Select a commit to view details.";
    container.append(empty);
    return;
  }

  const card = document.createElement("div");
  card.className = "gitCommitDetails";
  const subject = document.createElement("h4");
  subject.textContent = commit.subject;
  const hash = document.createElement("code");
  hash.textContent = commit.hash;
  const meta = document.createElement("p");
  meta.textContent = `${commit.author} · ${new Date(commit.date).toLocaleString()}`;
  card.append(subject, hash, meta);
  if (commit.refs.length) {
    const refs = document.createElement("p");
    refs.textContent = `Refs: ${commit.refs.join(", ")}`;
    card.append(refs);
  }
  container.append(card);

  if (loading) {
    const el = document.createElement("div");
    el.className = "gitEmpty";
    el.textContent = "Loading commit diff…";
    container.append(el);
    return;
  }

  const filesTitle = document.createElement("h3");
  filesTitle.className = "gitSectionTitle";
  filesTitle.textContent = `Changed files (${files.length})`;
  container.append(filesTitle);

  const fileList = document.createElement("div");
  fileList.className = "gitCommitFiles";
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "gitCommitFile";
    const status = document.createElement("span");
    status.className = "gitCommitFileStatus";
    status.textContent = file.status;
    const path = document.createElement("span");
    path.className = "gitCommitFilePath";
    path.textContent = file.path;
    const stats = document.createElement("span");
    stats.className = "gitCommitFileStats";
    const additions = file.additions ?? 0;
    const deletions = file.deletions ?? 0;
    stats.textContent = additions || deletions ? `+${additions} -${deletions}` : "";
    row.append(status, path, stats);
    fileList.append(row);
  }
  container.append(fileList);

  const diffTitle = document.createElement("h3");
  diffTitle.className = "gitSectionTitle";
  diffTitle.textContent = "Diff";
  container.append(diffTitle, renderUnifiedDiff(diff));
}
