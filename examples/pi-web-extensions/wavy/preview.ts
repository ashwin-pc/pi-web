import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePianoAssets, type WavyPreviewAsset } from "./preview-assets.js";
import type { FileRef, LoadedProject } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
// Read on render: SDK resource reloads can retain imported module instances.
// A reopened preview must not keep an old player bundle or stylesheet forever.
export async function readWavyPreviewAssets(root = here, includeNotation = true) {
  try {
    const [css, browser, abcjs] = await Promise.all([
      readFile(join(root, "styles.css"), "utf8"),
      readFile(join(root, "browser.js"), "utf8"),
      includeNotation ? readFile(join(root, "vendor/abcjs-basic-min.js"), "utf8") : Promise.resolve(""),
    ]);
    return [css, browser, abcjs] as const;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT" && failure.path === join(root, "browser.js")) {
      throw new Error("Wavy browser bundle is missing. In a source checkout run `npm run build:wavy-browser`; in an installed package reinstall or update @ashwin-pc/pi-web.", { cause: error });
    }
    throw error;
  }
}
const MAX_HTML = 1_000_000;

function artifactUrl(indexUrl: string, relative: string): string {
  if (relative.startsWith("/") || relative.split(/[\\/]/).some(part => part === "..")) throw new Error(`Unsafe Wavy file path: ${relative}`);
  const base = indexUrl.slice(0, indexUrl.lastIndexOf("/") + 1);
  return base + relative.split(/[\\/]/).map(encodeURIComponent).join("/");
}
function jsonData(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64"); }
function actionIcon(kind: "play" | "loop" | "comment" | "clear"): string {
  const paths = {
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    loop: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-3v2a3 3 0 0 1-3 3H3"/>',
    comment: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8Z"/>',
    clear: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  return `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[kind]}</svg>`;
}
export interface WavyPreviewResult { html: string; assets: WavyPreviewAsset[] }

function isRenderableScore(score: unknown): score is string {
  return typeof score === "string" && score.trim().length > 0
    && !/(?:https?:|javascript:|%%\s*(?:beginhtml|header|footer|text|center)|\[\s*[Uu][Rr][Ll]:)/i.test(score);
}

export async function renderWavyView(project: LoadedProject, options: { cwd?: string } = {}): Promise<WavyPreviewResult> {
  const scoreRef = project.index.revisions.at(-1)?.files.score;
  const hasRenderableScore = isRenderableScore(project.head.score);
  const hasPersistedScoreReference = hasRenderableScore && Boolean(scoreRef);
  const [css, browser, abcjs] = await readWavyPreviewAssets(here, hasRenderableScore);
  const seen = new Map<string, FileRef>();
  const add = (ref?: FileRef) => { if (ref) seen.set(ref.path, ref); };
  for (const revision of project.index.revisions) { add(revision.files.lyrics); add(revision.files.style); add(revision.files.settings); add(revision.files.score); add(revision.provenance); }
  for (const source of project.index.sources) { add(source.audio); add(source.transcription); add(source.score); }
  for (const take of project.index.takes) { add(take.request); add(take.result); add(take.audio); add(take.wav); }
  const file = (ref: FileRef) => ({ path: ref.path, bytes: ref.bytes, sha: ref.sha256, url: artifactUrl(project.artifactPath, ref.path) });
  const recordingAssets: WavyPreviewAsset[] = [];
  const takes = project.index.takes.map((t, index) => {
    const audio = t.audio ?? t.wav;
    const mediaType = audio ? ({ mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg" } as const)[audio.path.split(".").pop()?.toLowerCase() as "mp3" | "wav" | "flac" | "opus"] : undefined;
    const assetId = mediaType ? `recording-${index}` : undefined;
    if (audio && assetId) recordingAssets.push({ id: assetId, path: artifactUrl(project.artifactPath, audio.path), mediaType, bytes: audio.bytes, sha256: audio.sha256 });
    return { ...t, audio: audio ? { ...file(audio), assetId } : undefined };
  });
  const data = { title: project.index.title, revision: project.index.revision, artifactPath: project.artifactPath, scoreSha256: scoreRef?.sha256, lyrics: project.head.lyrics, style: project.head.style, score: project.head.score, settings: project.head.settings, warnings: project.warnings, revisions: project.index.revisions, sources: project.index.sources.map(s => ({ ...s, audio: file(s.audio) })), takes, files: [...seen.values()].map(ref => ({ ...file(ref), audio: /\.(?:mp3|wav|m4a|aac|ogg|opus|flac|webm)$/i.test(ref.path) })) };
  const encoded = jsonData(data);
  const html = `<!doctype html><html lang="en" data-wavy="${encoded}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wavy preview</title><style>${css}</style></head><body><main><header><div><h1 id="title"></h1><div id="summary" class="muted"></div></div><span class="status">Score review</span></header><ul id="warnings" class="warnings"></ul><section class="transport"${data.takes.length ? "" : " hidden"}><h2>Recording</h2><div class="recording-controls"><label for="takeSelect">Take</label><select id="takeSelect" aria-describedby="selectedTakeMeta selectedTakeWarnings mediaNotice"></select><button id="loadRecording" type="button" aria-label="Load recording"><span class="wide-label">Load recording</span><span class="narrow-label" aria-hidden="true">Load</span></button></div><div id="selectedTakeMeta" class="meta"></div><div id="selectedTakeWarnings" aria-live="polite"></div><audio id="recording" controls preload="none" hidden></audio><div id="mediaNotice" class="meta" aria-live="polite"></div></section><section id="scoreSection" class="section"><div class="score-heading"><h2>Score</h2><div class="score-heading-actions"><div id="zoomControls" class="zoom-controls" aria-label="Notation zoom"><button id="zoomOut" type="button" aria-label="Zoom notation out" title="Zoom out">−</button><button id="zoomReset" type="button" aria-label="Reset notation zoom" title="Reset zoom">100%</button><button id="zoomIn" type="button" aria-label="Zoom notation in" title="Zoom in">+</button></div><div id="pitchZoomControls" class="zoom-controls pitch-zoom-controls" aria-label="Piano roll pitch height" hidden><button id="pitchOut" type="button" aria-label="Decrease piano roll pitch height" title="Shorter pitch rows">−</button><button id="pitchFit" type="button" aria-label="Fit all used pitches" title="Fit the song's used pitch range">Fit pitches</button><button id="pitchIn" type="button" aria-label="Increase piano roll pitch height" title="Taller pitch rows">+</button></div><div class="view-buttons"><button id="notationButton" type="button" aria-pressed="true">Notation</button><button id="rollButton" type="button" aria-pressed="false">Piano roll</button></div></div></div><div class="transport-row"><button id="scorePlay" type="button" aria-label="Play written music">Play</button><button id="selectMode" type="button" aria-pressed="false">Select</button><label class="progress" aria-label="Written music position"><input id="scoreProgressTrack" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek written music"></label><span id="position" class="meta"></span></div><div id="selectionActions" class="selection-actions" hidden><strong id="selectionLabel"></strong><button id="playSelection" type="button" title="Play selected passage" aria-label="Play selected passage">${actionIcon("play")}<span class="button-label">Play range</span></button><button id="loopSelection" type="button" title="Loop selected passage" aria-label="Loop selected passage" aria-pressed="false">${actionIcon("loop")}<span class="button-label">Loop</span></button><button id="commentSelection" type="button" title="Comment on selected passage" aria-label="Comment on selected passage">${actionIcon("comment")}<span class="button-label">Comment</span></button><button id="clearSelection" type="button" title="Clear selection" aria-label="Clear passage selection">${actionIcon("clear")}<span class="button-label">Clear</span></button></div><div class="paper" id="scorePaper"><div id="notation"></div><div id="roll" class="roll" hidden></div><button id="selectionStart" class="selection-handle" type="button" aria-label="Adjust passage start" hidden></button><button id="selectionEnd" class="selection-handle" type="button" aria-label="Adjust passage end" hidden></button></div><div id="commentPanel" class="comment-panel" hidden><div><strong>Edit this passage</strong><span id="commentContext" class="meta"></span></div><textarea id="commentText" maxlength="4000" rows="3" placeholder="What should pi change?" aria-label="Passage edit comment"></textarea><div class="comment-actions"><button id="commentCancel" type="button" aria-label="Close comment">${actionIcon("clear")}<span class="wide-label">Cancel</span></button><button id="commentStage" type="button" aria-label="Review edit request"><span class="wide-label">Add to chat for review</span><span class="narrow-label" aria-hidden="true">Review</span></button></div><div id="commentStatus" class="meta" aria-live="polite"></div><pre id="commentFallback" class="comment-fallback" tabindex="0" hidden></pre></div><div id="scoreError" class="warn" aria-live="polite"></div><p class="meta score-note">Written-note piano only · tap positions silently</p></section><p id="scoreMissing" class="section empty"${data.score ? " hidden" : ""}></p><div class="grid"><div><section class="section"><h2>Lyrics · supplied input</h2><div id="lyrics" class="lyrics"></div></section><details class="section take-history"${data.takes.length ? "" : " hidden"}><summary>Take history</summary><div id="takes" class="takes"></div></details></div><div><section class="section"><h2>Requested style · supplied input</h2><div id="style" class="style"></div></section><section class="section"${data.sources.length ? "" : " hidden"}><h2>Sources and provenance</h2><div id="sources" class="sources"></div></section></div></div><details${data.revisions.length ? "" : " hidden"}><summary>Composition history</summary><div id="history" class="history"></div></details><details><summary>Generation settings</summary><div id="settings"></div></details><details${data.files.length ? "" : " hidden"}><summary>Native files</summary><div id="files" class="files"></div></details><footer>Snapshot preview. Edit through pi, then reopen to refresh.</footer></main><script>${abcjs}</script><script>${browser}</script></body></html>`;
  if (Buffer.byteLength(html, "utf8") >= MAX_HTML) throw new Error("Wavy preview exceeds the 1 MB artifact-preview limit");
  // Notation renders the in-memory composition, but host-granted piano assets
  // remain limited to scores represented by the persisted revision manifest.
  const pianoAssets = hasPersistedScoreReference ? await stagePianoAssets(options.cwd) : [];
  return { html, assets: [...recordingAssets, ...pianoAssets] };
}

/** Compatibility wrapper for tests and callers needing only srcdoc HTML. */
export async function renderWavyPreview(project: LoadedProject): Promise<string> { return (await renderWavyView(project)).html; }
export const wavyPreviewTest = { artifactUrl, MAX_HTML };
