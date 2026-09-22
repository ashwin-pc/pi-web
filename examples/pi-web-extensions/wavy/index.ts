import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomInt } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedProject } from "./types.js";

// Keep discovery/registration lightweight. Project storage, the preview renderer,
// and local engine adapters enter the module graph only for the action that uses
// them. This also keeps child_process and vendored viewer code out of idle sessions.
const loadStore = () => import("./store.js");
const loadEngines = () => import("./engines.js");
const loadPreview = () => import("./preview.js");
import { SETTINGS_LIMITS } from "./settings.js";

const KEY = "wavy.preview";
const ROOT = dirname(fileURLToPath(import.meta.url));
const pathField = Type.String({ minLength: 1, maxLength: 1000, description: "Artifact-relative .wavy index path (or its /api/artifacts/ URL)." });
const seedField = Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647, description: "Reproducibility seed. Omit to choose and retain a random seed." }));
const bounds = (limit: { minimum: number; maximum: number }) => ({ minimum: limit.minimum, maximum: limit.maximum });
const settingsFields = Type.Object({
  precision: Type.Optional(StringEnum(["bf16", "4bit"] as const)),
  planning: Type.Optional(StringEnum(["melody", "full", "off"] as const)),
  maxSemanticTokens: Type.Optional(Type.Integer({ ...bounds(SETTINGS_LIMITS.maxSemanticTokens), description: "Safety ceiling, never a pacing or duration target. Wavy default: 9000." })),
  cfgScale: Type.Optional(Type.Number(bounds(SETTINGS_LIMITS.cfgScale))),
  temperature: Type.Optional(Type.Number(bounds(SETTINGS_LIMITS.temperature))),
  topP: Type.Optional(Type.Number(bounds(SETTINGS_LIMITS.topP))),
  topK: Type.Optional(Type.Integer(bounds(SETTINGS_LIMITS.topK))),
  steps: Type.Optional(Type.Integer(bounds(SETTINGS_LIMITS.steps))),
}, { additionalProperties: false });
const revisionField = Type.Integer({ minimum: 1, description: "Current composition revision from inspect; rejects stale edits." });

function result(text: string, details: Record<string, unknown> = {}) {
  const shortened = truncateHead(text, { maxBytes: 40_000, maxLines: 700 });
  return {
    content: [{ type: "text" as const, text: shortened.content + (shortened.truncated ? "\n[Output shortened. Read the project's native files for full content.]" : "") }],
    details,
  };
}
function markdownLabel(text: string) { return text.replace(/[\[\]\\`<>\n\r]/g, " "); }
function projectFileUrl(project: LoadedProject, file: string) {
  const base = project.artifactPath.slice(0, project.artifactPath.lastIndexOf("/") + 1);
  return base + file.split(/[\\/]/).map(encodeURIComponent).join("/");
}
function projectResult(project: LoadedProject, message: string, _cwd: string, takeId?: string) {
  const { index } = project;
  const recent = takeId
    ? index.takes.find(take => take.id === takeId && take.audio && take.status === "complete")
    : index.takes.filter(take => take.audio && take.status === "complete").slice(-1)[0];
  if (takeId && !recent) throw new Error("Selected take has no completed recording. Inspect Wavy for available take IDs.");
  const audio = recent?.audio ? projectFileUrl(project, recent.audio.path) : undefined;
  // Host-owned media links are also the safe fallback when the opaque iframe
  // cannot authenticate. Never place browser/server credentials in preview HTML.
  return result([
    message,
    `[${markdownLabel(index.title)} — Wavy](${project.artifactPath})`,
    `Composition revision ${index.revision}; ${index.takes.length} recording(s).`,
    "Preview is a snapshot: reopen it after changes. Editing written music does not regenerate existing recordings.",
    ...(audio ? [`[Listen to ${markdownLabel(recent!.id)} (composition ${recent!.revision})](${audio})`] : []),
    ...project.warnings.map(warning => `Warning: ${warning}`),
  ].join("\n\n"), { path: project.artifactPath, revision: index.revision, ...(audio ? { audio } : {}) });
}
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this action.`);
  return value;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }


export default function wavy(pi: PiWebExtensionAPI) {
  // Session-scoped cancellation; the engine layer owns cross-session inference
  // exclusion. No timers, listeners, subprocesses or model loads at factory time.
  const operations = new Map<AbortController, Promise<unknown>>();
  async function operation<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const task = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); });
    operations.set(controller, task);
    try { return await task; }
    finally { operations.delete(controller); signal?.removeEventListener("abort", abort); }
  }

  pi.on("resources_discover", () => ({ skillPaths: [join(ROOT, "skill", "SKILL.md")] }));
  pi.on("session_start", (_event, ctx) => {
    const web = ctx.ui?.web;
    if (typeof web?.contribute !== "function" || !web.capabilities?.slots.includes("artifact-preview") || !web.capabilities.kinds.includes("rendered")) {
      ctx.ui.notify("Wavy tools are available; artifact previews require pi-web's artifact-preview API.", "warning");
      return;
    }
    const cwd = ctx.cwd;
    web.contribute(KEY, {
      slot: "artifact-preview", kind: "rendered", title: "Wavy", label: "Wavy",
      match: { kinds: ["file"], extensions: [".wavy"] },
      async render(event) {
        const path = event?.context?.path;
        if (typeof path !== "string") throw new Error("Missing Wavy artifact path.");
        const [{ loadProject }, { renderWavyView }] = await Promise.all([loadStore(), loadPreview()]);
        return { html: await renderWavyView(await loadProject(cwd, path)) };
      },
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    for (const controller of operations.keys()) controller.abort(new Error("Wavy session closed or reloaded."));
    await Promise.allSettled([...operations.values()]);
    ctx.ui?.web?.contribute?.(KEY, undefined);
  });

  pi.registerTool({
    name: "wavy", label: "Wavy project",
    description: "Create, inspect, revise, attach source audio, or export a Wavy song. Native lyrics/style/settings/ABC live outside the index; revisions and recordings are preserved. Paths are artifact-relative. Inspect before revising; expected_revision prevents overwriting newer work. Export produces a portable archive. Never edits audio or starts inference. Output bounded to 40 KB.",
    promptSnippet: "Create and edit Wavy music projects, inspect native compositions, attach audio, and export bundles",
    promptGuidelines: [
      "Use wavy for Wavy project changes rather than editing immutable revision files or the index directly. Read its skill for composition/rendering workflows.",
      "After using wavy, include the returned .wavy artifact link so the user sees the score and lyrics inline. Use the returned audio link if sandbox playback is unavailable.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "inspect", "revise", "source", "export"] as const),
      path: pathField,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      lyrics: Type.Optional(Type.String({ maxLength: 32000 })),
      style: Type.Optional(Type.String({ maxLength: 16000 })),
      score: Type.Optional(Type.String({ maxLength: 128000, description: "Canonical ABC written music; supplying it does not generate audio." })),
      remove_score: Type.Optional(Type.Boolean()),
      settings: Type.Optional(settingsFields),
      expected_revision: Type.Optional(revisionField),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      source_path: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "For source: explicit local attachment path to copy; never deletes original." })),
      source_label: Type.Optional(Type.String({ maxLength: 160 })),
      take_id: Type.Optional(Type.String({ maxLength: 100, description: "For inspect: return the host-owned audio link for this take instead of the latest recording." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { createProject, exportProject, importSource, loadProject, reviseProject } = await loadStore();
      if (params.action === "create") {
        return projectResult(await createProject(ctx.cwd, {
          path: params.path, title: required(params.title, "title"), lyrics: params.lyrics,
          style: params.style, score: params.score, settings: params.settings,
        }), "Created Wavy project. No models ran.", ctx.cwd);
      }
      if (params.action === "revise") {
        if (params.remove_score && params.score !== undefined) throw new Error("Use score or remove_score, not both.");
        return projectResult(await reviseProject(ctx.cwd, params.path, {
          expectedRevision: required(params.expected_revision, "expected_revision"),
          summary: required(params.summary, "summary"), origin: "agent", lyrics: params.lyrics,
          style: params.style, score: params.remove_score ? null : params.score, settings: params.settings,
        }), "Saved a new composition revision. Existing recordings are unchanged.", ctx.cwd);
      }
      if (params.action === "source") return projectResult(await importSource(ctx.cwd, params.path, {
        sourcePath: required(params.source_path, "source_path"), label: params.source_label,
      }), "Copied the source audio. It has not been transcribed yet.", ctx.cwd);
      if (params.action === "export") {
        const bundle = await exportProject(ctx.cwd, params.path);
        return result(`[Download complete Wavy bundle](${bundle.artifactPath})`, { path: bundle.artifactPath });
      }
      const project = await loadProject(ctx.cwd, params.path);
      const base = projectResult(project, "Wavy project inspected.", ctx.cwd, params.take_id);
      return result(base.content[0].text + "\n\n" + JSON.stringify({
        title: project.index.title, revision: project.index.revision, composition: project.head,
        files: project.index.revisions.at(-1)?.files,
        sources: project.index.sources, takes: project.index.takes.slice(-20),
      }, null, 2), base.details);
    },
  });

  pi.registerTool({
    name: "wavy_status", label: "Wavy engines",
    description: "Check local YuE2 and SheetSage2 configuration without loading or downloading model weights. Reports setup requirements; does not run inference.",
    parameters: Type.Object({}),
    async execute() { const { engineStatus } = await loadEngines(); const status = await engineStatus(); return result(JSON.stringify(status, null, 2)); },
  });

  pi.registerTool({
    name: "wavy_compose", label: "Compose written music",
    description: "Use local YuE2 to plan ABC melody/chords from this Wavy project's lyrics and requested style, then save a new revision. Does not synthesize singing/audio. Non-commercial weights. Current revision required; stale results are retained but never overwrite a newer composition. No waveform inpainting or singer cloning.",
    promptSnippet: "Plan a Wavy composition with local YuE2 before generating its recording",
    parameters: Type.Object({ path: pathField, expected_revision: revisionField, seed: seedField }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return operation(signal, async abortSignal => {
        const [{ loadProject, newOperationDir, reviseProject }, { planComposition }] = await Promise.all([loadStore(), loadEngines()]);
        const project = await loadProject(ctx.cwd, params.path);
        if (project.index.revision !== params.expected_revision) throw new Error("Composition changed. Inspect Wavy before composing.");
        if (project.head.settings.planning === "off") throw new Error("Set planning to melody or full with wavy revise before composing.");
        const outputDir = await newOperationDir(ctx.cwd, params.path, "compose");
        const seed = params.seed ?? randomInt(2147483648);
        const progress = (text: string) => onUpdate?.(result(text.slice(-3000)));
        progress("Planning written music locally. No audio synthesis in this step.");
        const planned = await planComposition({ ...project.head, seed, outputDir }, abortSignal, progress);
        abortSignal.throwIfAborted();
        const rawPlanPath = await realpath(planned.rawPlanPath);
        const planRelative = relative(await realpath(outputDir), rawPlanPath);
        if (!planRelative || planRelative === ".." || planRelative.startsWith(`..${sep}`) || isAbsolute(planRelative)) throw new Error("Engine plan provenance escaped its operation directory.");
        if ((await stat(rawPlanPath)).size > 512000) throw new Error(`Plan provenance is too large; retained in ${outputDir}.`);
        const rawPlan = await readFile(rawPlanPath, "utf8");
        const saved = await reviseProject(ctx.cwd, params.path, {
          expectedRevision: params.expected_revision, origin: "yue", summary: "YuE2 written-music plan",
          score: planned.score, provenance: { operation: "compose", seed, baseRevision: params.expected_revision,
            requestedSettings: project.head.settings, rawPlan, result: planned.result },
        });
        return projectResult(saved, "Saved YuE2's written music. Audition the notes in the preview; ask for a recording when ready.", ctx.cwd);
      });
    },
  });

  pi.registerTool({
    name: "wavy_render", label: "Record Wavy composition",
    description: "Generate a full local YuE2 performance from the project's exact saved ABC/lyrics/style/settings. Preserves older recordings and revision inputs. No audio inpainting: edited music creates a new performance. Uses BF16 by default. Non-commercial weights. Safety token ceiling is NOT a duration/phrasing control. count generates sequential takes of the same captured composition. Without saved score, requires planning=off for an explicitly direct generation.",
    promptSnippet: "Render a saved Wavy composition into one or more local YuE2 takes",
    parameters: Type.Object({
      path: pathField, expected_revision: revisionField, seed: seedField,
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return operation(signal, async abortSignal => {
        const [{ beginTake, finishTake, loadProject }, { renderComposition }] = await Promise.all([loadStore(), loadEngines()]);
        const project = await loadProject(ctx.cwd, params.path);
        if (project.index.revision !== params.expected_revision) throw new Error("Composition changed. Inspect Wavy before rendering.");
        if (!project.head.score && project.head.settings.planning !== "off") throw new Error("Compose or supply an ABC score first. For deliberate direct audio generation set planning=off.");
        const count = params.count ?? 1;
        const firstSeed = params.seed ?? randomInt(2147483648);
        let latest = project;
        for (let i = 0; i < count; i++) {
          abortSignal.throwIfAborted();
          const seed = (firstSeed + i) % 2147483648;
          const request = { operation: "render", revision: project.index.revision, seed, ...project.head };
          const { take, outputDir } = await beginTake(ctx.cwd, params.path, {
            revision: project.index.revision, seed, precision: project.head.settings.precision, request,
          });
          const progress = (text: string) => onUpdate?.(result(`Take ${i + 1}/${count} · ${take.id}\n${text.slice(-3000)}`));
          try {
            progress("Rendering the saved composition locally. Abort stops the subprocess.");
            const rendered = await renderComposition({ ...project.head, seed, outputDir }, abortSignal, progress);
            abortSignal.throwIfAborted();
            latest = await finishTake(ctx.cwd, params.path, take.id, { status: "complete", ...rendered });
          } catch (error) {
            let persistenceWarning = "";
            try {
              await finishTake(ctx.cwd, params.path, take.id, {
                status: abortSignal.aborted ? "cancelled" : "failed", error: errorText(error).slice(0, 2000),
              });
            } catch (saveError) {
              persistenceWarning = ` The failure receipt could not be saved (${errorText(saveError)}); its displayed status may be stale. Logs remain in ${outputDir}.`;
            }
            throw new Error(`Take ${take.id} ${abortSignal.aborted ? "cancelled" : "failed"}: ${errorText(error)}. Earlier recordings are preserved. Reopen ${project.artifactPath}.${persistenceWarning}`);
          }
        }
        return projectResult(latest, `Saved ${count} new recording${count === 1 ? "" : "s"}. Check completion/truncation metadata before treating a take as finished.`, ctx.cwd);
      });
    },
  });

  pi.registerTool({
    name: "wavy_transcribe", label: "Transcribe source melody",
    description: "Use local SheetSage2 on a source previously attached with wavy source. Retains original audio, raw timed events and draft ABC. Does not transcribe lyrics; humming accuracy and quantization require review. Does not replace the composition unless apply_score=true with expected_revision. Never automatically installs/downloads models. Non-commercial weights.",
    parameters: Type.Object({
      path: pathField, source_id: Type.String({ minLength: 1, maxLength: 100 }),
      apply_score: Type.Optional(Type.Boolean()), expected_revision: Type.Optional(revisionField),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return operation(signal, async abortSignal => {
        const [{ attachTranscription, loadProject, newOperationDir, resolveFile, reviseProject }, { transcribeSource }] = await Promise.all([loadStore(), loadEngines()]);
        const project = await loadProject(ctx.cwd, params.path);
        if (params.apply_score && required(params.expected_revision, "expected_revision") !== project.index.revision) throw new Error("Composition changed. Inspect Wavy before applying a transcription.");
        const source = project.index.sources.find(item => item.id === params.source_id);
        if (!source) throw new Error("Source not found. Inspect Wavy for source IDs.");
        const audioPath = await resolveFile(project, source.audio);
        const outputDir = await newOperationDir(ctx.cwd, params.path, "transcribe");
        const transcribed = await transcribeSource({ audioPath, outputDir }, abortSignal, text => onUpdate?.(result(text.slice(-3000))));
        abortSignal.throwIfAborted();
        let saved = await attachTranscription(ctx.cwd, params.path, source.id, {
          events: { events: transcribed.events, result: transcribed.result }, score: transcribed.score,
        });
        if (params.apply_score) saved = await reviseProject(ctx.cwd, params.path, {
          expectedRevision: params.expected_revision!, origin: "transcription", summary: "Draft score from source transcription; review required",
          score: transcribed.score, provenance: { operation: "transcribe", sourceId: source.id, result: transcribed.result },
        });
        return projectResult(saved, params.apply_score
          ? "Saved transcription as a draft composition. Review pitches, octave, rhythm, and chords; original timed events are preserved."
          : "Saved source transcription and draft ABC for review. Current composition and recordings are unchanged.", ctx.cwd);
      });
    },
  });
}
