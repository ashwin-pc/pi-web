import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type Profile = {
  model: { loader: "UNETLoader" | "UnetLoaderGGUF"; file: string; weight_dtype?: string };
  textEncoder: string;
  vae: string;
  lora?: { file: string; strength: number };
  sampling: { kind: "standard" | "viggle-flow"; steps: number; cfg: number; sampler: string; scheduler?: string; denoise?: number };
};
export type ImageConfig = { defaultModel: string; models: Record<string, Profile> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
};
const filename = (value: unknown, label: string): string => {
  const name = text(value, label);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error(`${label} must be a filename under the corresponding ComfyUI model folder`);
  return name;
};
const number = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
};
export function parseConfig(raw: unknown): ImageConfig {
  if (!record(raw) || !record(raw.models) || !Object.keys(raw.models).length) throw new Error("Image config requires a nonempty models object");
  const defaultModel = text(raw.defaultModel, "defaultModel");
  const models: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(raw.models)) {
    text(name, "model name");
    if (!record(value) || !record(value.model) || !record(value.sampling)) throw new Error(`Invalid Qwen 2.1 model profile: ${name}`);
    const loader = value.model.loader;
    if (loader !== "UNETLoader" && loader !== "UnetLoaderGGUF") throw new Error(`${name}: unsupported model loader`);
    const kind = value.sampling.kind;
    if (kind !== "standard" && kind !== "viggle-flow") throw new Error(`${name}: unsupported sampling kind`);
    if (value.lora !== undefined && !record(value.lora)) throw new Error(`${name}: invalid lora`);
    const steps = number(value.sampling.steps, `${name}.steps`, 1, 128);
    if (!Number.isInteger(steps) || (kind === "viggle-flow" && steps !== 4)) throw new Error(`${name}: viggle-flow requires 4 steps; steps must be an integer`);
    models[name] = {
      model: { loader, file: filename(value.model.file, `${name}.model.file`), ...(value.model.weight_dtype === undefined ? {} : { weight_dtype: text(value.model.weight_dtype, `${name}.model.weight_dtype`) }) },
      textEncoder: filename(value.textEncoder, `${name}.textEncoder`), vae: filename(value.vae, `${name}.vae`),
      ...(record(value.lora) ? { lora: { file: filename(value.lora.file, `${name}.lora.file`), strength: number(value.lora.strength, `${name}.lora.strength`, -10, 10) } } : {}),
      sampling: { kind, steps, cfg: number(value.sampling.cfg, `${name}.cfg`, 0, 30), sampler: text(value.sampling.sampler, `${name}.sampler`),
        ...(value.sampling.scheduler === undefined ? {} : { scheduler: text(value.sampling.scheduler, `${name}.scheduler`) }),
        ...(value.sampling.denoise === undefined ? {} : { denoise: number(value.sampling.denoise, `${name}.denoise`, 0, 1) }) },
    };
  }
  if (!Object.hasOwn(models, defaultModel)) throw new Error(`Unknown defaultModel: ${defaultModel}`);
  return { defaultModel, models };
}
export async function loadConfig(): Promise<ImageConfig> {
  const path = process.env.PI_IMAGE_CONFIG;
  if (!path) throw new Error("Set PI_IMAGE_CONFIG to your local image profile JSON (see README)");
  return parseConfig(JSON.parse(await readFile(resolve(path), "utf8")));
}
export function selectProfile(config: ImageConfig, model?: string): { name: string; profile: Profile } {
  const name = model ?? config.defaultModel;
  if (!Object.hasOwn(config.models, name)) throw new Error(`Unknown image model '${name}'. Available: ${Object.keys(config.models).join(", ")}`);
  return { name, profile: config.models[name] };
}
