export type UnifiedPatchFile = { name: string; lines: string[] };
export type DiffHunk = { oldText: unknown; newText: unknown };
type LineDiff = { op: "same" | "add" | "del"; oldLine?: string; newLine?: string };

function fileNameFromHeader(header: string) {
  const match = header.match(/^diff --git a\/(.*?) b\/(.*)$/);
  return match?.[2] || header.replace(/^diff --git /, "");
}

export function splitUnifiedPatch(diff: string): UnifiedPatchFile[] {
  const files: UnifiedPatchFile[] = [];
  let current: UnifiedPatchFile | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { name: fileNameFromHeader(line), lines: [line] };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { name: "Diff", lines: [line] };
      files.push(current);
    }
  }
  return files;
}

function tokenize(value: unknown) {
  return String(value ?? "").match(/\w+|\s+|[^\w\s]+/g) || [];
}

export function lcsPairs<T>(a: T[], b: T[]) {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function splitLines(value: unknown) {
  return String(value ?? "").split("\n");
}

function lineDiff(oldText: unknown, newText: unknown): LineDiff[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const pairs = lcsPairs(oldLines, newLines);
  const out: LineDiff[] = [];
  let oi = 0, ni = 0;
  for (const [oldMatch, newMatch] of pairs) {
    while (oi < oldMatch || ni < newMatch) {
      if (oi < oldMatch && ni < newMatch) out.push({ op: "del", oldLine: oldLines[oi++] }, { op: "add", newLine: newLines[ni++] });
      else if (oi < oldMatch) out.push({ op: "del", oldLine: oldLines[oi++] });
      else out.push({ op: "add", newLine: newLines[ni++] });
    }
    out.push({ op: "same", oldLine: oldLines[oi++], newLine: newLines[ni++] });
  }
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length) out.push({ op: "del", oldLine: oldLines[oi++] }, { op: "add", newLine: newLines[ni++] });
    else if (oi < oldLines.length) out.push({ op: "del", oldLine: oldLines[oi++] });
    else out.push({ op: "add", newLine: newLines[ni++] });
  }
  return out;
}

function appendWordDiff(cell: HTMLElement, oldLine: string, newLine: string, side: "old" | "new") {
  const oldTokens = tokenize(oldLine), newTokens = tokenize(newLine);
  const matches = new Set(lcsPairs(oldTokens, newTokens).map(([i, j]) => side === "old" ? i : j));
  const tokens = side === "old" ? oldTokens : newTokens;
  tokens.forEach((token, i) => {
    const span = document.createElement("span");
    span.textContent = token;
    if (!matches.has(i)) span.className = `diffWord diffWord--${side === "old" ? "del" : "add"}`;
    cell.append(span);
  });
}

function patchKind(raw: string) {
  if (raw.startsWith("+") && !raw.startsWith("+++")) return "add";
  if (raw.startsWith("-") && !raw.startsWith("---")) return "del";
  if (raw.startsWith("@@") || raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) return "meta";
  return "same";
}

function makePatchRow(
  kind: "add" | "del" | "same" | "meta" | "changed",
  oldText = "",
  newText = "",
  oldLine?: number,
  newLine?: number,
) {
  const tr = document.createElement("tr");
  tr.className = `diffLine diffLine--${kind === "meta" ? "same gitPatchMeta" : kind}`;
  const oldGutter = document.createElement("td");
  oldGutter.className = "diffGutter";
  const oldCell = document.createElement("td");
  oldCell.className = "diffCode diffCode--old";
  const newGutter = document.createElement("td");
  newGutter.className = "diffGutter";
  const newCell = document.createElement("td");
  newCell.className = "diffCode diffCode--new";

  oldGutter.textContent = oldLine === undefined ? "" : String(oldLine);
  newGutter.textContent = newLine === undefined ? "" : String(newLine);
  if (kind === "add") { newCell.textContent = newText; }
  else if (kind === "del") { oldCell.textContent = oldText; }
  else if (kind === "changed") {
    appendWordDiff(oldCell, oldText, newText, "old");
    appendWordDiff(newCell, oldText, newText, "new");
  } else {
    oldCell.textContent = oldText;
    newCell.textContent = newText || oldText;
  }
  tr.append(oldGutter, oldCell, newGutter, newCell);
  return tr;
}

function appendLineDiffRows(table: HTMLTableElement, lines: LineDiff[]) {
  lines.forEach((line, index) => {
    if (line.op === "del" && lines[index + 1]?.op === "add") {
      table.append(makePatchRow("changed", line.oldLine || "", lines[index + 1].newLine || ""));
    } else if (!(line.op === "add" && lines[index - 1]?.op === "del")) {
      if (line.op === "add") table.append(makePatchRow("add", "", line.newLine || ""));
      else if (line.op === "del") table.append(makePatchRow("del", line.oldLine || "", ""));
      else table.append(makePatchRow("same", line.oldLine || "", line.newLine || line.oldLine || ""));
    }
  });
}

function appendPatchRows(table: HTMLTableElement, lines: string[]) {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const kind = patchKind(raw);
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      table.append(makePatchRow("meta", raw, raw));
    } else if (kind === "del" && patchKind(lines[i + 1] || "") === "add") {
      table.append(makePatchRow("changed", raw.slice(1), lines[i + 1].slice(1), oldLine, newLine));
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
      i++;
    } else if (kind === "add") {
      table.append(makePatchRow("add", "", raw.slice(1), undefined, newLine));
      if (newLine !== undefined) newLine++;
    } else if (kind === "del") {
      table.append(makePatchRow("del", raw.slice(1), "", oldLine, undefined));
      if (oldLine !== undefined) oldLine++;
    } else if (kind === "meta") table.append(makePatchRow("meta", raw, raw));
    else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      table.append(makePatchRow("same", text, text, oldLine, newLine));
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
    }
  }
}

export function renderNumberedDiff(diff: string, options: { stacked?: boolean } = {}) {
  const container = document.createElement("div");
  container.className = "diffContainer";
  setDiffLayout(container, Boolean(options.stacked));
  const table = document.createElement("table");
  table.className = "diffTable";
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([ +\-])(\s*\d+|\s+)\s(.*)$/);
    if (!match) continue;
    const line = Number(match[2].trim());
    const number = Number.isFinite(line) ? line : undefined;
    const next = lines[i + 1]?.match(/^\+(\s*\d+|\s+)\s(.*)$/);
    if (match[1] === "-" && next) {
      const nextLine = Number(next[1].trim());
      table.append(makePatchRow("changed", match[3], next[2], number, Number.isFinite(nextLine) ? nextLine : undefined));
      i++;
    } else if (match[1] === "+") table.append(makePatchRow("add", "", match[3], undefined, number));
    else if (match[1] === "-") table.append(makePatchRow("del", match[3], "", number, undefined));
    else table.append(makePatchRow("same", match[3], match[3], number, number));
  }
  container.append(table);
  return container;
}

export function setDiffLayout(container: HTMLElement, stacked: boolean) {
  container.classList.toggle("diffContainer--stacked", stacked);
  container.classList.toggle("diffContainer--sideBySide", !stacked);
}

export function renderDiffHunks(hunks: DiffHunk[], options: { stacked?: boolean } = {}) {
  const container = document.createElement("div");
  container.className = "diffContainer";
  setDiffLayout(container, Boolean(options.stacked));
  hunks.forEach((hunk, i) => {
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "diffSep";
      container.append(sep);
    }
    const table = document.createElement("table");
    table.className = "diffTable";
    appendLineDiffRows(table, lineDiff(hunk.oldText, hunk.newText));
    container.append(table);
  });
  return container;
}

export function diffHunkLineCount(hunks: DiffHunk[]) {
  return hunks.reduce((n, h) => n + splitLines(h.oldText).length + splitLines(h.newText).length, 0);
}

export function renderUnifiedPatch(diff: string, options: { stacked?: boolean } = {}) {
  const container = document.createElement("div");
  container.className = "diffContainer gitPatchFiles";
  setDiffLayout(container, Boolean(options.stacked));
  const files = splitUnifiedPatch(diff);
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "No diff available.";
    container.append(empty);
    return container;
  }
  for (const file of files) {
    const details = document.createElement("details");
    details.className = "gitPatchFile";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = file.name;
    const table = document.createElement("table");
    table.className = "diffTable";
    appendPatchRows(table, file.lines);
    details.append(summary, table);
    container.append(details);
  }
  return container;
}
