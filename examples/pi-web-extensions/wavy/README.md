# Wavy

An opt-in **pi-web example extension** for composing, auditioning, recording, and transcribing music with local models. Wavy uses the existing HTML-only artifact-preview and agent-tool APIs; it adds no Wavy-specific route, bridge, authentication scheme, studio, or navigation surface.

A song is a `.wavy` JSON index plus a companion `.wavy.d/` directory. Lyrics, ABC notation, requested style, settings, sources, and recordings remain native files. The browser is **view-only**: create and edit through the agent; listen and inspect in the artifact preview.

## Install for all pi-web sessions

Build the extension from a pi-web source checkout, then link that extension directory:

```sh
cd examples/pi-web-extensions/wavy
npm ci
npm run build
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD" ~/.pi/web/extensions/wavy
```

The extension has its own lockfile and pinned build/test dependencies. `npm ci` installs only its local `node_modules`; it does not modify or remove the checkout's root dependencies. The symlink keeps this directory canonical. New sessions discover it automatically; use `/reload` in already-open sessions. Its companion skill is contributed automatically—no second skill symlink is required.

For a built archive, run `npm run verify:package`, then `npm pack`. Extract the resulting `.tgz`, install its production peer dependencies without running excluded development lifecycle scripts, and link the extracted directory:

```sh
tar -xzf ashwin-pc-pi-web-wavy-example-*.tgz
cd package
npm install --omit=dev --ignore-scripts --no-save \
  @ashwin-pc/pi-web@0.6.1 \
  @earendil-works/pi-ai@0.87.1 \
  @earendil-works/pi-coding-agent@0.87.1 \
  typebox@1.0.64
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD" ~/.pi/web/extensions/wavy
```

Wavy imports pi coding-agent, pi-ai, and typebox at runtime and imports the pi-web SDK contract for typing, so all four are declared as peers rather than bundling a second host SDK runtime. Because this is an extracted private package rather than a registry-installed dependency, the command above explicitly installs the tested compatible peer set locally; `--no-save` leaves the archived manifest unchanged, and `--ignore-scripts` avoids invoking development scripts that are intentionally absent from the archive. Incompatible host/SDK versions fail dependency resolution instead of being silently borrowed from an unrelated checkout. `npm run verify:package` repeats this exact install in a temporary directory with no ancestor `node_modules`, then performs real SDK discovery and checks every Wavy tool registration.

The archive includes `browser.js`, runtime TypeScript, native engine bridges, the skill, and vendor provenance; it excludes tests, build scripts, caches, and engine test files. The normal `@ashwin-pc/pi-web` package explicitly excludes this optional extension.

These are **pi-web** extension locations, not `~/.pi/agent/extensions`: the preview depends on browser APIs. To remove it, remove only the symlink and reload. Songs and recordings are not deleted.

## Use

Ask the agent, for example:

- “Create a Wavy song called Halfway with these lyrics and an acoustic pop direction.”
- “Compose melody and chords, but let me hear the written notes before recording.”
- “Shorten the pickup and hold the final note. Keep the previous recording.”
- “Generate two takes of this version with different seeds.”
- “Attach this humming clip and transcribe it for review.”
- “Export the complete Wavy project.”

The agent should return the `.wavy` artifact link after each operation. Reopen the preview after edits: mounted previews are snapshots, not live job dashboards. The inline score stays visible during optional oscillator audition and highlights the written notes being played. Tap a note to position the cursor; use Select, Shift-click, keyboard extension, or the passage handles to audition or loop a range. Passage comments remain local to the iframe and produce selectable text containing the composition revision, score hash, and UTF-16 source ranges; copy that text into chat manually. Clipboard attempts gracefully fall back to selecting the draft. The preview never edits the score, submits chat, fetches generated recordings, runs inference, or renders a recording. Notation and piano roll are projections of the saved ABC, not a separately editable browser document.

### Tools

| Tool | Purpose |
| --- | --- |
| `wavy` | `create`, `inspect`, `revise`, `source`, `export` |
| `wavy_status` | Check local backend configuration without loading weights |
| `wavy_compose` | YuE2 → ABC written music, no audio synthesis |
| `wavy_render` | Saved composition → a new full YuE2 performance; optional sequential takes |
| `wavy_transcribe` | Attached audio → retained timed events and draft ABC |

`wavy revise`, `wavy_compose`, and `wavy_render` require the expected composition revision. Inspect before changing a project. A stale model result never silently replaces newer written music. Transcription does not replace the composition unless `apply_score` is explicitly requested.

Long engine tools run as cancellable tool calls, not detached jobs. Progress appears in the tool transcript. Abort/reload stops their subprocesses; completed takes, failed-run diagnostics, and prior revisions remain on disk. There is no automatic renderer refresh, inline/expanded playback handoff, or model invocation from browser controls.

## Local engines

The project format, editing, preview, and synthesized-note audition do not require model weights. Engine tools require separately configured **local** runtimes. No model weights are installed, downloaded, or loaded merely by opening a session or inspecting a song.

### YuE2

Wavy's extension-owned Python bridge imports the existing community `npario/YuE2-3B-MLX` implementation. This is YuE2—not original YuE and not a ComfyUI workflow. Configure `WAVY_YUE_ROOT` to the local `yue-local` checkout with its isolated `.venv`, backend code, and model assets. The default location is `~/projects/yue-local`.

The pre-existing `yue_music_generate` tool and its legacy defaults are unchanged. Wavy's defaults are **BF16**, **full melody/chord planning**, and a **9,000 semantic-token safety ceiling**. Optional 4-bit refers to that backend's mixed 4-bit AR / 8-bit NAR model. Changing the ceiling does not specify a duration or improve phrasing. Natural end and ceiling-limited output must be distinguished using completion metadata.

Supported controls are validated centrally: precision, planning mode, semantic token ceiling, semantic CFG, temperature, top-p, top-k, and synthesis steps. A project can deliberately use `planning: "off"` for direct audio generation with no saved score. Otherwise, compose or supply ABC before rendering.

### SheetSage2

SheetSage2 is an optional, separately configured Python/model environment. See [engine setup](engine/README.md) for its actual adapter contract and local dependencies. `wavy_status` reports availability; missing prerequisites produce an actionable error rather than fabricated transcription. Do not reuse or mutate the YuE/MiniMax environments to install transcription dependencies.

SheetSage2 does **not** transcribe lyrics. Melody, chord, beat, meter, and related estimates require review, especially for humming and sparse clips. Retain original audio and raw timed events: the draft ABC necessarily quantizes timing. No calibrated per-note confidence or automatic “correct transcription” label is invented.

## Playback and authentication

Score audition uses an explicitly labelled WebAudio oscillator. It makes no soundfont, model, recording, or network request and preserves the pitches and timing parsed from the saved ABC; it is not a preview of the final singer or production. Generated singing is **not** assumed to align exactly with the notation.

pi-web renders the self-contained document in `sandbox="allow-scripts"` without `allow-same-origin`. Wavy declares no preview assets or host callbacks. Generated recordings are available only through ordinary tool-returned host-player links; `wavy inspect` accepts `take_id` to return a selected take's link. The HTML stays under the host's 1 MB response limit, including its pinned ABCjs library.

## Files and integrity

Example layout:

```text
halfway.wavy
halfway.wavy.d/
  revisions/000001/lyrics.md
  revisions/000001/style.md
  revisions/000001/score.abc
  revisions/000001/settings.json
  revisions/000001/provenance.json
  sources/<source-id>/audio.m4a
  sources/<source-id>/transcription.json
  sources/<source-id>/score.abc
  takes/<take-id>/receipts/request.json
  takes/<take-id>/run/...
  takes/<take-id>/receipts/result.json
  takes/<take-id>/audio.wav
  jobs/compose/<operation-id>/...
```

Paths in the index are relative to its directory and remain inside its named `.wavy.d` companion directory. References include byte lengths and SHA-256 hashes. New revisions contain new native files; old render inputs stay immutable. Do not edit the index or immutable revision files behind the tools: hashes deliberately detect this and refuse to pass changed data off as the original input.

The loader validates bounds, paths, symlinks, references, and integrity. Mutations use the canonical file queue and atomic index replacement. Source imports copy explicitly supplied local audio paths; they do not delete or alter the originals. File extensions are not a guarantee of safe media—decoders must validate actual content too.

Export returns a `.tar.gz` containing the index and companion files, not just the index. The host needs `tar`. Extract the archive without renaming only one half of the pair. Browser validation is defense in depth: installed pi extensions and configured Python runtimes are trusted local code running with the user's permissions.

## Licensing

Extension code follows pi-web's MIT license. Vendored ABCjs retains its [MIT notice](vendor/LICENSE.md). The machine-verifiable [`vendor/manifest.json`](vendor/manifest.json) records the exact shipped file, byte length, and SHA-256 hash. YuE2, SheetSage2, and the MERT parent model use **CC BY-NC 4.0** weights; Wavy is intended for non-commercial model use unless you separately obtain appropriate permission. A successful render is not a commercial-rights clearance.

## Development

`player.ts` and `player-model.ts` are the readable canonical browser sources. `browser.js` is deterministic generated output: it is ignored by Git but included in built npm packages. Preview rendering performs no compilation, install, download, or global lookup. Install and run its canonical extension-owned commands from this directory:

```sh
npm ci
npm run build
npm run build:check
npm run typecheck
npm run test:unit
npm run test:e2e
npm run verify:package
```

`npm run dev` is the opt-in browser-bundle watcher. E2E reuses the host's generic server and Playwright infrastructure, so build the host (`npm run build` at the repository root) first. The root unit runner, E2E discovery, release workflow, and test orchestrator contain no Wavy hooks; root TypeScript explicitly excludes this independently typechecked package. A source checkout without the generated bundle reports `npm run build`; independently packed archives always ship it.

Model tests are separate from the normal suite. Unit/E2E tests and package verification never download weights or launch inference. Keep Wavy-specific functionality inside this example and its tests; changes to the core contribution API require a separate, generic design decision.
