# Wavy

An opt-in **pi-web example extension** for composing, auditioning, recording, and transcribing music with local models. Wavy uses the generic artifact-preview, read-only asset/theme bridge, and agent-tool APIs; it adds no Wavy-specific routes, authentication scheme, studio, or navigation surface.

A song is a `.wavy` JSON index plus a companion `.wavy.d/` directory. Lyrics, ABC notation, requested style, settings, sources, and recordings remain native files. The browser is **view-only**: create and edit through the agent; listen and inspect in the artifact preview.

## Install for all pi-web sessions

From the pi-web checkout:

```sh
mkdir -p ~/.pi/web/extensions
ln -s "$PWD/examples/pi-web-extensions/wavy" ~/.pi/web/extensions/wavy
```

If a Wavy installation already exists, inspect it before replacing it. The symlink makes this example directory the single implementation, not a copied installation. New sessions discover it automatically; use `/reload` in already-open sessions. Its companion skill is contributed automatically—no second skill symlink is required.

These are **pi-web** extension locations, not `~/.pi/agent/extensions`: the preview depends on browser APIs. To remove it, remove only the symlink and reload. Songs and recordings are not deleted.

## Use

Ask the agent, for example:

- “Create a Wavy song called Halfway with these lyrics and an acoustic pop direction.”
- “Compose melody and chords, but let me hear the written notes before recording.”
- “Shorten the pickup and hold the final note. Keep the previous recording.”
- “Generate two takes of this version with different seeds.”
- “Attach this humming clip and transcribe it for review.”
- “Export the complete Wavy project.”

The agent should return the `.wavy` artifact link after each operation. Reopen the preview after edits: existing mounted previews are snapshots, not live job dashboards. The inline score stays visible during synthesized audition and highlights the notes actually being played. Tap a note to position the silent play cursor; use Select, Shift-click, keyboard extension, or the passage handles to audition/loop a range. A passage comment opens host-owned review and, only after approval, stages a frozen score reference plus editable request in the composer. It never edits the score, submits chat, runs inference, or renders audio by itself. Notation and piano roll are projections of the saved ABC, not a separately editable browser document. See the [real in-chat preview](/api/artifacts/wavy-preview-in-chat.png) and [expanded Artifacts-panel preview](/api/artifacts/wavy-preview-expanded.png) from final-build validation.

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

Score audition uses a small local subset of Salamander Grand Piano samples through WebAudio. It makes no remote soundfont/model requests and preserves the pitches and timing parsed from the saved ABC; it is not a preview of the final singer or production. An explicitly labelled oscillator is used only when the host asset bridge or piano samples are unavailable. Generated singing is **not** assumed to align exactly with the notation.

pi-web renders custom artifacts in `sandbox="allow-scripts"` without `allow-same-origin`. Its generic preview bridge provides authenticated assets as `Blob`s without exposing credentials or weakening the sandbox. Wavy creates and revokes its own blob URLs, loads only a recording selected by the user, and cancels stale loads. A normal host-player link remains available in the parent chat if the bridge or decoder is unavailable; `wavy inspect` also accepts `take_id` to return a selected take's host-player link. The iframe receives audio bytes, not login credentials or transferable server-access URLs. Already downloaded bytes remain available until the preview closes; a logout cannot retract a completed download.

Piano samples are copied on demand into a bounded, content-addressed `.pi/web/artifacts/wavy-preview-cache/` under the current project. This derived cache does not modify the Wavy project. The HTML stays under the host's 1 MB response limit, including its pinned ABCjs library; recordings and samples are never embedded in it.

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

Extension code follows pi-web's MIT license. Vendored ABCjs retains its [MIT notice](vendor/LICENSE.md). The piano subset is Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0; exact source, package version, and attribution are retained in [`vendor/piano/README.md`](vendor/piano/README.md). The machine-verifiable [`vendor/manifest.json`](vendor/manifest.json) records the exact shipped subset, byte lengths, and SHA-256 hashes. YuE2, SheetSage2, and the MERT parent model use **CC BY-NC 4.0** weights; Wavy is intended for non-commercial model use unless you separately obtain appropriate permission. A successful render is not a commercial-rights clearance.

## Development

`player.ts` and `player-model.ts` are the readable canonical browser sources. `browser.js` is deterministic generated output: it is ignored by Git but included in built npm packages. Preview rendering performs no compilation, install, download, or global lookup. Generate or verify it with the repository's exact development-time esbuild pin:

```sh
npm run build:wavy-browser
npm run build:wavy-browser -- --check
```

Normal `npm run dev` remains Wavy-free. When actively changing Wavy's browser sources, run the opt-in watcher in a second terminal:

```sh
npm run watch:wavy-browser
```

A source checkout without the generated bundle reports a rebuild instruction when a Wavy preview is opened; published packages ship the bundle. From the repository root:

```sh
npm run typecheck
npx vitest run tests/wavy-player.test.ts tests/wavy-store.test.ts tests/wavy-preview.test.ts tests/wavy-engines.test.ts tests/wavy-extension.test.ts
npm run build
npm test
```

Model tests are separate from the normal suite. Unit tests must not download weights or launch inference. Keep Wavy-specific functionality inside this example and its tests; changes to the core contribution API require a separate, generic design decision.
