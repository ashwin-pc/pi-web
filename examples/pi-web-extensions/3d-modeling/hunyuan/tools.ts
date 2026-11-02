import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative as pathRelative } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactRelativeFromUrl, resolveArtifactRead, resolveArtifactWrite } from "../shared.js";

const runner = join(dirname(fileURLToPath(import.meta.url)), "runner.py");
// Serialize this backend in one runtime; installed image/video tools have no global broker.
let busy = false;
export function runOwned(request: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Hunyuan3D cancelled"));
    const root = process.env.PI_HUNYUAN_COMFY_ROOT?.trim();
    if (!root) return reject(new Error("Set PI_HUNYUAN_COMFY_ROOT to your ComfyUI checkout"));
    const child = spawn(process.env.PI_HUNYUAN_PYTHON || join(root, ".venv/bin/python"), [runner, request], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    // SIGTERM is handled by the runner, which waits for owned ComfyUI cleanup.
    const cancel = () => { child.kill("SIGTERM"); };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16384); });
    child.once("error", (error) => { signal?.removeEventListener("abort", cancel); reject(error); });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(new Error("Hunyuan3D cancelled; owned runner stopped"));
      else if (code !== 0) reject(new Error(`Hunyuan3D failed (${code}): ${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

export function registerHunyuanTools(pi: PiWebExtensionAPI) {
  if (!process.env.PI_HUNYUAN_COMFY_ROOT?.trim()) return;
  pi.registerTool({
    name: "comfy_image_to_3d",
    label: "Generate local 3D geometry",
    description: "Generate untextured GLB geometry from an artifact image using installed Hunyuan3D 2.1. Owned loopback ComfyUI stops afterward. No Blender, texture generation, or automatic downloads. Inferred unseen surfaces are approximate; not dimensionally accurate or guaranteed printable. Requires other ComfyUI inference to be idle.",
    parameters: Type.Object({
      image: Type.String({ description: "Artifact-relative PNG/JPEG/WebP path or /api/artifacts/ URL. Prefer a centered single object on a plain background." }),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Sampling steps; default 30" })),
      resolution: Type.Optional(Type.Union([Type.Literal(128), Type.Literal(256)], { description: "Octree mesh resolution; default 256" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (busy) throw new Error("Hunyuan3D is already running; retry when idle");
      const steps = params.steps ?? 30, resolution = params.resolution ?? 256;
      const seed = params.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isInteger(steps) || steps < 1 || steps > 50 || ![128, 256].includes(resolution)) throw new Error("Invalid Hunyuan3D settings");
      const relative = params.image.startsWith("/api/") ? artifactRelativeFromUrl(params.image) : params.image;
      const extension = extname(relative).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("Image must be PNG/JPEG/WebP");
      busy = true;
      try {
        const source = await resolveArtifactRead(ctx.cwd, relative, extension, 25_000_000, "Image");
        const prefix = `image-to-3d/${randomUUID()}`;
        const request = await resolveArtifactWrite(ctx.cwd, `${prefix}/request.json`, ".json");
        const root = dirname(request.path);
        await mkdir(join(root, "input"));
        const image = `source${extension}`;
        await copyFile(source.path, join(root, "input", image));
        await writeFile(request.path, JSON.stringify({ root, image, seed, steps, resolution }));
        onUpdate?.({ content: [{ type: "text", text: "Generating local untextured Hunyuan3D geometry…" }], details: { seed, steps, resolution } });
        const result = JSON.parse(await runOwned(request.path, signal)) as { output: string };
        // Never trust a backend-returned absolute path as a public artifact.
        // root comes from resolveArtifactWrite and is already canonical, even
        // when the artifact directory (or cwd) was reached through a symlink.
        const withinRun = pathRelative(root, result.output).replaceAll("\\", "/");
        if (!withinRun.startsWith("output/")) throw new Error("Backend output escapes owned run");
        const rel = `${prefix}/${withinRun}`;
        const output = await resolveArtifactRead(ctx.cwd, rel, ".glb", 250_000_000, "GLB");
        const url = `/api/artifacts/${output.relative.split("/").map(encodeURIComponent).join("/")}`;
        await writeFile(join(root, "metadata.json"), JSON.stringify({ seed, steps, resolution, output: output.relative, textured: false, ownedProcessStopped: true }, null, 2));
        return { content: [{ type: "text", text: `[Download untextured 3D geometry (GLB)](${url})\nOwned ComfyUI stopped. Surfaces unseen in the image are inferred; scale and printability are not guaranteed.` }], details: { url, seed, steps, resolution, textured: false } };
      } finally { busy = false; }
    },
  });
}
