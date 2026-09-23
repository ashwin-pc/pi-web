import { DEFAULT_SETTINGS, type WavySettings } from "./types.js";

/** Shared by project validation, engine requests, and the public tool schema. */
export const SETTINGS_LIMITS = {
  maxSemanticTokens: { minimum: 128, maximum: 16384, integer: true },
  cfgScale: { minimum: 0, maximum: 20, integer: false },
  temperature: { minimum: 0.01, maximum: 3, integer: false },
  topP: { minimum: 0.01, maximum: 1, integer: false },
  topK: { minimum: 1, maximum: 184704, integer: true },
  steps: { minimum: 1, maximum: 128, integer: true },
} as const;

export function validateSettings(value: unknown, base: WavySettings = DEFAULT_SETTINGS): WavySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wavy settings must be an object.");
  const raw = value as Record<string, unknown>;
  const accepted = new Set(["precision", "planning", ...Object.keys(SETTINGS_LIMITS)]);
  for (const key of Object.keys(raw)) {
    if (!accepted.has(key)) throw new Error(`Unsupported Wavy setting: ${key}`);
    if (raw[key] === undefined) throw new Error(`Wavy setting ${key} cannot be undefined.`);
  }
  const merged = { ...base, ...raw } as WavySettings;
  if (merged.precision !== "bf16" && merged.precision !== "4bit") throw new Error("Wavy precision must be bf16 or 4bit.");
  if (!["off", "melody", "full"].includes(merged.planning)) throw new Error("Wavy planning must be off, melody, or full.");
  for (const [key, limit] of Object.entries(SETTINGS_LIMITS)) {
    const n = (merged as unknown as Record<string, unknown>)[key];
    if (n === undefined && key !== "maxSemanticTokens") continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < limit.minimum || n > limit.maximum || (limit.integer && !Number.isInteger(n))) {
      throw new Error(`Wavy ${key} must be ${limit.integer ? "an integer" : "a number"} between ${limit.minimum} and ${limit.maximum}.`);
    }
  }
  return merged;
}
