import { parakeetBackend } from "./parakeet/config.js";
import { whisperBackend } from "./whisper/config.js";

export const DICTATION_BACKENDS = [parakeetBackend, whisperBackend] as const;
export const DEFAULT_DICTATION_BACKEND = parakeetBackend;
