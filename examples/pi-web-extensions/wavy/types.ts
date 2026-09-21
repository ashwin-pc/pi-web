/** Native files are canonical. The index contains references and provenance only. */
export interface FileRef { path: string; sha256: string; bytes: number }
export interface CompositionFiles { lyrics: FileRef; style: FileRef; settings: FileRef; score?: FileRef }
export interface WavyRevision {
  id: number;
  createdAt: string;
  summary: string;
  origin: "user" | "agent" | "yue" | "transcription";
  files: CompositionFiles;
  provenance?: FileRef;
}
export interface WavySource {
  id: string;
  label: string;
  audio: FileRef;
  transcription?: FileRef;
  score?: FileRef;
  createdAt: string;
}
export interface WavyTake {
  id: string;
  revision: number;
  createdAt: string;
  status: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  seed: number;
  precision: "bf16" | "4bit";
  request: FileRef;
  result?: FileRef;
  audio?: FileRef;
  wav?: FileRef;
  durationSeconds?: number;
  elapsedSeconds?: number;
  finishReason?: string;
  truncated?: boolean;
  error?: string;
}
export interface WavyIndex {
  format: "wavy";
  version: 1;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  revisions: WavyRevision[];
  sources: WavySource[];
  takes: WavyTake[];
}
export interface WavySettings {
  precision: "bf16" | "4bit";
  planning: "melody" | "full" | "off";
  maxSemanticTokens: number;
  cfgScale?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  steps?: number;
}
export interface CompositionInput {
  lyrics: string;
  style: string;
  score?: string;
  settings: WavySettings;
}
export interface LoadedProject {
  index: WavyIndex;
  /** Absolute index path and its /api/artifacts/ URL, never credentials. */
  absolutePath: string;
  artifactPath: string;
  head: CompositionInput;
  warnings: string[];
}
export const DEFAULT_SETTINGS: WavySettings = {
  precision: "bf16", planning: "full", maxSemanticTokens: 9000,
};
