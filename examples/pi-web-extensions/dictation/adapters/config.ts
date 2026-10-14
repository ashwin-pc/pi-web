import { arch, platform } from "node:process";

export const DICTATION_FAMILIES = [
  { value: "parakeet", label: "Parakeet" },
  { value: "whisper", label: "Whisper" },
] as const;

export const DICTATION_RUNTIMES = [
  { value: "auto", label: "Automatic" },
  { value: "mlx", label: "MLX (Apple Silicon)" },
  { value: "photon", label: "Photon (Parakeet CPU; telemetry blocked by audited shim)" },
  { value: "faster-whisper", label: "faster-whisper (portable CPU/CUDA)" },
] as const;

export type DictationFamily = typeof DICTATION_FAMILIES[number]["value"];
export type DictationRuntime = Exclude<typeof DICTATION_RUNTIMES[number]["value"], "auto">;

export const isAppleSilicon = (hostPlatform = platform, hostArch = arch) => hostPlatform === "darwin" && hostArch === "arm64";

export function platformDefaults(hostPlatform = platform, hostArch = arch): { family: DictationFamily; runtime: "auto" } {
  return { family: isAppleSilicon(hostPlatform, hostArch) ? "parakeet" : "whisper", runtime: "auto" };
}

export function resolveRuntime(family: DictationFamily, runtime: "auto" | DictationRuntime, hostPlatform = platform, hostArch = arch): DictationRuntime {
  if (runtime !== "auto") return runtime;
  if (isAppleSilicon(hostPlatform, hostArch)) return "mlx";
  if (family === "whisper") return "faster-whisper";
  throw new Error("Parakeet Automatic has no portable runtime. Select Photon explicitly and install parakeet-photon, or choose Whisper.");
}

export function defaultModel(family: DictationFamily, runtime: DictationRuntime): string {
  if (family === "parakeet" && runtime === "photon") return "moondream/parakeet-redux";
  if (family === "parakeet" && runtime === "mlx") return "mlx-community/parakeet-tdt-0.6b-v3";
  if (family === "whisper" && runtime === "mlx") return "mlx-community/whisper-large-v3-turbo";
  if (family === "whisper" && runtime === "faster-whisper") return "large-v3-turbo";
  throw new Error(`Unsupported dictation family/runtime: ${family}/${runtime}`);
}

export function validateCombination(family: DictationFamily, runtime: DictationRuntime, hostPlatform = platform, hostArch = arch) {
  if (runtime === "mlx" && !isAppleSilicon(hostPlatform, hostArch)) {
    throw new Error(`MLX requires macOS on Apple Silicon; current host is ${hostPlatform}/${hostArch}.`);
  }
  const photonArchitectures: Partial<Record<NodeJS.Platform, readonly string[]>> = {
    darwin: ["arm64"],
    win32: ["x64"],
    linux: ["x64", "arm64"],
  };
  if (runtime === "photon" && !photonArchitectures[hostPlatform]?.includes(hostArch)) {
    throw new Error(`Photon is not configured for ${hostPlatform}/${hostArch}.`);
  }
  if (family === "parakeet" && runtime !== "mlx" && runtime !== "photon") {
    throw new Error("This extension includes Parakeet only through MLX or optional Photon.");
  }
  if (family === "whisper" && runtime !== "mlx" && runtime !== "faster-whisper") {
    throw new Error(`Whisper does not support runtime ${runtime}.`);
  }
}
