---
name: wavy
description: Create, revise, audition, and render Wavy music projects with local YuE2, or transcribe attached melody audio with optional SheetSage2. Use for .wavy files, written melody/chord editing, song takes, source humming, and portable music project exports.
---

# Wavy music workflow

Wavy is a native-file project, not a standalone studio. The `.wavy` index references lyrics, requested style, canonical ABC notation, settings, audio sources, immutable revision inputs, and recordings. The browser shows a read-only artifact; the agent performs all composition mutations.

## Tools

Use **one public `music` tool** with an `action`:

- `generate`: supply non-empty lyrics and style; optional title/path, score, settings, seed, count. Creates a Wavy project, then records using YuE2. No score is required: without one, planning is off. Defaults BF16 and 9000 semantic tokens. Omitted path gets a unique `music/song-<id>.wavy`; omitted title is New song.
- `create`, `inspect`, `revise`, `source`, `export`: native project management; no inference.
- `status`: lightweight prerequisites, no weight loading or downloads.
- `compose`: generate ABC melody/chords with YuE2, no audio.
- `render`: whole new performance from saved inputs, sequential `count` takes.
- `transcribe`: SheetSage2 source draft with retained timed events. Missing local interpreter/model prerequisites fail explicitly; never install or download automatically.

For a song request, use `music` action `generate` directly unless written planning is requested. No MiniMax default or fallback, hidden aliases, or standalone YuE tool is needed. Preserve full lyrics. Return the resulting .wavy and audio links. An exact five-second duration is not promised; token ceilings are not duration controls.

## Normal sequence

1. Create a `.wavy` artifact with the user's lyrics and direction. If drafting lyrics yourself, say so; lyrics are supplied to YuE, not discovered from its audio.
2. Inspect before changing anything. Use the returned `revision` as `expected_revision` for guarded changes.
3. Compose using `music compose` or supply valid ABC through `music revise`. A supplied score is authoritative; rendering must not silently re-plan it.
4. Return the `.wavy` artifact link. The user can inspect notation or piano roll and hear synthesized written notes before a real render.
5. On request, call `music render`. Label this as a new full performance, not an in-place waveform edit. Previous recordings remain available with their original revision.
6. Return the `.wavy` link again, and the ordinary audio artifact link if the sandbox player cannot authenticate. Existing open cards are snapshots; reopening loads the new state. No automatic update or playback handoff is promised.

A manually copied score-passage comment from the preview is context, not an edit command. Read the referenced immutable `score.abc`, inspect the latest project, and compare the supplied composition revision and SHA-256 before interpreting UTF-16 source ranges. Never apply stale offsets to a newer score. If the request is still current, make changes only through guarded `music revise` with the current `expected_revision`; do not automatically render a new recording merely because a comment was submitted. Piano-audition times describe written-note playback, not generated-recording word or lyric timing.

Use the dedicated tools to commit music changes. Do not mutate immutable revision files or edit index/hash fields with bash/write/edit. For larger edits, read the native score, develop the replacement ABC, then commit it through `music revise` with an explicit change summary. Never silently repair old hashes to conceal changed render inputs.

## Inputs and outputs

- Requested style, desired tempo, vocal direction, and lyrics are inputs. Do not label them as measured classifications.
- YuE2 produces the audio performance. With planning enabled, it also produces a symbolic melody (`melody`) or melody/chord (`full`) plan.
- Legacy direct-generation recordings have no retained score unless one actually exists. Never fabricate a score or history to fill an empty preview.
- Synthesized score audition plays notes; it is not the generated singer, guitar tone, or production.
- Do not promise exact score/audio alignment, unchanged audio outside edited bars, inpainting, singer cloning, stems, or exact duration.

## Source audio

Use `music source` with the attachment's local path to copy it into the project before transcription. SheetSage2 does not produce lyrics; it estimates music structure. Humming, octave choice, beat grids, and chord estimates require review. `music transcribe` defaults to retaining a source draft without replacing the song. Use `apply_score` only when applying that draft is intended, with a current expected revision.

Retain the raw events because ABC quantizes timing. Do not invent per-note confidence values or claim a transcription was reviewed automatically.

## Rendering and controls

`music generate` defaults to BF16, direct/off planning without a score, and a 9,000 semantic-token **safety ceiling**. Advanced project `create` defaults to full planning. Do not lower the ceiling to shorten phrases, force faster pacing, or sharpen transitions. Address those in lyrics, style direction, or the written music. If a take reaches the ceiling, report the truncation; do not call it naturally finished.

Seeds help compare repeated runs but are not a promise of stable unchanged audio after input edits. All recordings retain the exact revision, request, result, and effective backend metadata. Multiple takes should run sequentially through `count`; avoid parallel YuE/MiniMax/SheetSage inference competing for unified memory.

`planning: off` is an explicit direct-generation mode without a saved score. For planned composition, first compose or supply ABC. Advanced supported settings are centrally validated; do not sneak unsupported flags into settings JSON.

## Missing prerequisites and permissions

Run `music status` when engine configuration is uncertain. Report missing local environments/weights and consult [the extension README](../README.md) and [engine setup](../engine/README.md). Do not install packages, download large weights, mutate another model's virtualenv, use paid services, or weaken authentication just to hide a missing dependency.

YuE2/SheetSage2/MERT weights are non-commercial (CC BY-NC 4.0). Make this limitation clear when relevant; do not promise commercial rights.

Long operations are awaited cancellable tool calls. On cancellation or failure, report preserved takes and diagnostic files; do not silently retry costly inference. Export with `music export` to get the index and native dependencies together, not an incomplete index-only download.
