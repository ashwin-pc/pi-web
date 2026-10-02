import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const selections = {
  quick: "viggle-4step",
  quality: "official-bf16",
  "uc-quick": "uc-viggle",
  "uc-quality": "uc-q4",
} as const;
type Selection = keyof typeof selections;
export const parameters = Type.Object({
  prompt: Type.Optional(Type.String({ minLength: 1, description: "Shared prompt; required unless every batch job has its own prompt" })),
  mode: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("quality"), Type.Literal("uc-quick"), Type.Literal("uc-quality")], { description: "Default quick; quality uses 40 steps, uc variants use quantized weights" })),
  image_path: Type.Optional(Type.String({ description: "Primary PNG/JPEG/WebP input; omit to generate" })),
  reference_image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 2, description: "Additional edit references; requires image_path" })),
  jobs: Type.Optional(Type.Array(Type.Object({
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    image_path: Type.Optional(Type.String()),
    reference_image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
    width: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, multipleOf: 32 })),
    height: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, multipleOf: 32 })),
  }), { minItems: 1, maxItems: 20, description: "Independent jobs run sequentially; cannot combine with top-level image inputs" })),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
  width: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, multipleOf: 32, description: "Generation canvas; for edits the first image determines aspect ratio" })),
  height: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, multipleOf: 32 })),
});
type Job = { prompt?: string; image_path?: string; reference_image_paths?: string[]; seed?: number; width?: number; height?: number };
type Request = Job & { jobs?: Job[]; mode?: Selection };
export function normalize(input: Request): (Required<Pick<Job, "prompt" | "seed" | "width" | "height">> & { images: string[] })[] {
  if (input.jobs && (input.image_path !== undefined || input.reference_image_paths !== undefined || input.seed !== undefined || input.width !== undefined || input.height !== undefined)) throw new Error("Use jobs or top-level image/seed/dimensions, not both");
  const jobs = input.jobs ?? [input];
  return jobs.map((job) => {
    const prompt = job.prompt ?? input.prompt;
    if (!prompt?.trim()) throw new Error("A nonempty prompt is required for each job");
    if (job.reference_image_paths?.length && !job.image_path) throw new Error("reference_image_paths requires image_path");
    return { prompt, images: job.image_path ? [job.image_path, ...(job.reference_image_paths ?? [])] : [], seed: job.seed ?? Math.floor(Math.random() * 2147483648), width: job.width ?? 1024, height: job.height ?? 1024 };
  });
}
const runner = join(dirname(fileURLToPath(import.meta.url)), "runner.py");
// Runtime root is explicitly configured; no weights or virtualenv are bundled.
const runtimeRoot = () => {
  const root = process.env.PI_IMAGE_RUNTIME_ROOT;
  if (!root) throw new Error("Set PI_IMAGE_RUNTIME_ROOT to the isolated ComfyUI runtime directory (see README)");
  return resolve(root);
};
export function run(request: string, signal?: AbortSignal): Promise<string> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new Error("Image operation cancelled"));
    let root: string;
    try { root = runtimeRoot(); } catch (error) { fail(error); return; }
    const child = spawn(join(root, "venv", "bin", "python"), [runner, request], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_IMAGE_RUNTIME_ROOT: root } });
    let stdout = "", stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("error", (error) => { signal?.removeEventListener("abort", abort); fail(error); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code !== 0 || signal?.aborted) fail(new Error(signal?.aborted ? "Image operation cancelled" : `Image runner exited ${code}: ${stderr.slice(-3000)}`));
      else done(stdout);
    });
  });
}
export default function imageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "image", label: "Generate or edit images",
    description: "Generate images with no inputs, or edit/compose using one to three input images. mode: quick (default), quality, uc-quick, uc-quality. Use jobs for independent batch outputs; jobs execute sequentially. Isolated local inference stops and unloads weights after every job; no cross-session lock.",
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const jobs = normalize(params);
      runtimeRoot(); // Fail configuration before creating run artifacts.
      const mode = params.mode ?? "quick";
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const artifacts = join(ctx.cwd, ".pi", "web", "artifacts");
      const root = join(artifacts, "image", id);
      await mkdir(root, { recursive: true });
      const urls: string[] = [];
      try {
        for (const [index, job] of jobs.entries()) {
          if (signal?.aborted) throw new Error("Image operation cancelled");
          const jobRoot = join(root, `job-${index + 1}`);
          await mkdir(jobRoot, { recursive: true });
          const request = { model: selections[mode], prompt: job.prompt, images: job.images.map((p) => resolve(ctx.cwd, p)), seed: job.seed, width: job.width, height: job.height, root: jobRoot };
          const requestPath = join(jobRoot, "request.json");
          await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
          onUpdate?.({ content: [{ type: "text", text: `Running image job ${index + 1}/${jobs.length} (${mode})…` }], details: { runId: id, mode, completed: index } });
          const result = JSON.parse((await run(requestPath, signal)).trim()) as { outputs: string[]; prompt_id: string };
          const outputUrls = result.outputs.map((path) => `/api/artifacts/${relative(artifacts, path).split(sep).map(encodeURIComponent).join("/")}`);
          urls.push(...outputUrls);
          await writeFile(join(jobRoot, "result.json"), `${JSON.stringify({ outputUrls, prompt_id: result.prompt_id, stopped: true }, null, 2)}\n`);
        }
      } catch (error) {
        await writeFile(join(root, "error.txt"), `${String(error)}\n`);
        throw error;
      }
      return { content: [{ type: "text", text: `Image ${jobs.length === 1 ? (jobs[0].images.length ? "edit" : "generation") : "batch"} complete (${mode}); isolated inference stopped after each job.\n${urls.map((url, i) => `![Output ${i + 1}](${url})`).join("\n")}` }], details: { runId: id, mode, outputUrls: urls } };
    },
  });
}
