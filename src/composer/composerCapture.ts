import type { ApiClient } from "../app/api.js";
import { iconElement, isIconName } from "../app/icons.js";
import { createComposerCaptureRenderer } from "./composerCaptureRenderer.js";

export type ComposerCaptureDescriptor = {
  version: 1;
  key: string;
  slot: "composer-input";
  kind: "capture";
  title: string;
  label?: string;
  icon?: string;
  capture: { media: "audio"; maxSeconds: number; maxBytes: number; mimeTypes?: string[]; registrationId: string };
};

export type EditorSnapshot = { sessionId: string; revision: number; selectionStart: number; selectionEnd: number };

export function capturedTextInsertion(input: {
  text: string;
  placement: "selection" | "cursor" | "end";
  snapshot: EditorSnapshot;
  current: { sessionId: string; revision: number; value: string; selectionStart: number; selectionEnd: number };
}) {
  if (input.snapshot.sessionId !== input.current.sessionId || input.snapshot.revision !== input.current.revision) return undefined;
  if (input.snapshot.selectionStart !== input.current.selectionStart || input.snapshot.selectionEnd !== input.current.selectionEnd) return undefined;
  const start = input.placement === "end" ? input.current.value.length
    : input.placement === "cursor" ? input.snapshot.selectionEnd : input.snapshot.selectionStart;
  const end = input.placement === "selection" ? input.snapshot.selectionEnd : start;
  return { value: `${input.current.value.slice(0, start)}${input.text}${input.current.value.slice(end)}`, cursor: start + input.text.length };
}

type CaptureOperation = {
  generation: number;
  descriptor: ComposerCaptureDescriptor;
  snapshot: EditorSnapshot;
  abort: AbortController;
  phase: "permission" | "recording" | "processing";
  recorder?: MediaRecorder;
  stream?: MediaStream;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  timeout?: number;
  ticker?: number;
  audioContext?: AudioContext;
  analyserFrame?: number;
};

export function createComposerCapture(options: {
  container: HTMLElement;
  prompt: HTMLTextAreaElement;
  api: ApiClient;
  getSessionId: () => string;
  getRevision: () => number;
  insertText: (text: string, placement: "selection" | "cursor" | "end", snapshot: EditorSnapshot) => boolean;
  onError: (message: string) => void;
  onRecovery?: (text: string) => void;
}) {
  let descriptors: ComposerCaptureDescriptor[] = [];
  let operation: CaptureOperation | undefined;
  let generation = 0;
  const visual = createComposerCaptureRenderer(options.container);

  function releaseMedia(op: CaptureOperation) {
    if (op.timeout) window.clearTimeout(op.timeout);
    if (op.ticker) window.clearInterval(op.ticker);
    if (op.analyserFrame) cancelAnimationFrame(op.analyserFrame);
    void op.audioContext?.close().catch(() => undefined);
    const stream = op.stream;
    op.stream = undefined;
    for (const track of stream?.getTracks() || []) track.stop();
  }

  function cancel() {
    generation += 1;
    const op = operation;
    operation = undefined;
    if (op) {
      op.abort.abort();
      releaseMedia(op);
      if (op.recorder?.state !== "inactive") op.recorder?.stop();
    }
    visual.reset();
    render();
  }

  function stopRecording(op: CaptureOperation) {
    if (stale(op) || op.phase !== "recording" || op.recorder?.state === "inactive") return;
    // Stopping MediaRecorder is already the beginning of processing. Mark that
    // synchronously so a visibility change cannot mistake finalization/upload
    // for live microphone ownership and abort an otherwise complete capture.
    op.phase = "processing";
    visual.setPhase("handoff");
    op.recorder?.stop();
    releaseMedia(op);
    render();
  }

  async function responseBody(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      } catch { data = { text }; }
    }
    const structuredError = data.error;
    const errorMessage = typeof structuredError === "string" ? structuredError
      : structuredError && typeof structuredError === "object" && typeof (structuredError as { message?: unknown }).message === "string"
        ? (structuredError as { message: string }).message : "";
    if (!response.ok || errorMessage) {
      const plain = errorMessage.trim()
        || (typeof data.text === "string" && !/^\s*</.test(data.text) ? data.text.trim() : "");
      throw new Error((plain || response.statusText || `Request failed (${response.status})`).slice(0, 2_000));
    }
    return data;
  }

  function stale(op: CaptureOperation) {
    return operation !== op || generation !== op.generation || op.abort.signal.aborted;
  }

  async function finish(op: CaptureOperation) {
    releaseMedia(op);
    if (stale(op)) return;
    op.phase = "processing";
    // The renderer owns a continuous handoff-to-processing clock; network work
    // begins immediately and never waits for the visual transition.
    visual.setPhase("handoff");
    render();
    try {
      const durationMs = Math.max(1, Math.min(performance.now() - op.startedAt, op.descriptor.capture.maxSeconds * 1000));
      const blob = new Blob(op.chunks, { type: op.recorder?.mimeType || op.chunks[0]?.type || "audio/webm" });
      if (!blob.size || blob.size > op.descriptor.capture.maxBytes) throw new Error("Audio capture exceeded the allowed size");
      const params = new URLSearchParams({
        sessionId: op.snapshot.sessionId, key: op.descriptor.key,
        registrationId: op.descriptor.capture.registrationId,
        durationMs: String(Math.round(durationMs)),
      });
      const { "content-type": _json, ...headers } = options.api.headers();
      const upload = await fetch(`/api/web-captures?${params}`, {
        method: "POST", headers: { ...headers, "content-type": blob.type || "audio/webm" }, body: blob, signal: op.abort.signal,
      });
      const { captureId } = await responseBody(upload) as { captureId?: string };
      if (!captureId) throw new Error("Capture upload returned no id");
      const response = await fetch("/api/web-contributions/invoke", {
        method: "POST", headers: options.api.headers(), signal: op.abort.signal,
        body: JSON.stringify({ sessionId: op.snapshot.sessionId, slot: "composer-input", key: op.descriptor.key, event: { captureId } }),
      });
      const result = await responseBody(response) as { effects?: Array<{ type?: string; text?: string; placement?: string }> };
      if (stale(op)) return;
      visual.setPhase("resolving");
      for (const effect of result.effects || []) {
        if (effect.type !== "insert-composer-text" || typeof effect.text !== "string") continue;
        const placement = effect.placement === "cursor" || effect.placement === "end" ? effect.placement : "selection";
        if (!options.insertText(effect.text, placement, op.snapshot)) {
          if (options.onRecovery) options.onRecovery(effect.text);
          else options.onError(`Draft changed while dictation was processing. Recovered transcript:\n\n${effect.text}`);
        }
      }
      visual.revealResult();
    } catch (error) {
      if (!op.abort.signal.aborted) options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation === op) operation = undefined;
      window.setTimeout(() => { if (!operation) visual.setPhase("idle"); }, 220);
      render();
    }
  }

  async function start(descriptor: ComposerCaptureDescriptor) {
    cancel();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      options.onError("Microphone capture requires a secure context and MediaRecorder support.");
      return;
    }
    const sessionId = options.getSessionId();
    if (!sessionId) return;
    const op: CaptureOperation = {
      generation: ++generation, descriptor,
      snapshot: { sessionId, revision: options.getRevision(), selectionStart: options.prompt.selectionStart, selectionEnd: options.prompt.selectionEnd },
      abort: new AbortController(), phase: "permission", chunks: [], bytes: 0, startedAt: 0,
    };
    operation = op;
    visual.setPhase("permission");
    render();
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (stale(op)) { for (const track of stream.getTracks()) track.stop(); return; }
      op.stream = stream;
      const requestedMime = descriptor.capture.mimeTypes?.find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, requestedMime ? { mimeType: requestedMime } : undefined);
      op.recorder = recorder;
      // Analysis is display-only; failures must not prevent or interrupt the
      // MediaRecorder path, whose bytes are the sole extension input.
      if (typeof AudioContext !== "undefined") {
        let audioContext: AudioContext | undefined;
        try {
          audioContext = new AudioContext();
          op.audioContext = audioContext;
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 512;
          audioContext.createMediaStreamSource(stream).connect(analyser);
          const values = new Float32Array(analyser.fftSize);
          const sample = () => {
            if (stale(op) || op.phase !== "recording") return;
            try {
              analyser.getFloatTimeDomainData(values);
              let sum = 0; for (const value of values) sum += value * value;
              visual.addSample(Math.sqrt(sum / values.length));
              op.analyserFrame = requestAnimationFrame(sample);
            } catch {
              // A device/context can disappear while MediaRecorder remains valid.
            }
          };
          op.analyserFrame = requestAnimationFrame(sample);
        } catch {
          if (op.audioContext === audioContext) op.audioContext = undefined;
          void audioContext?.close().catch(() => undefined);
        }
      }
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || stale(op)) return;
        op.bytes += event.data.size;
        if (op.bytes > descriptor.capture.maxBytes) {
          options.onError("Audio capture exceeded the allowed size");
          cancel();
          return;
        }
        op.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => { if (!stale(op)) void finish(op); }, { once: true });
      recorder.start(1_000);
      op.phase = "recording";
      visual.setPhase("recording");
      op.startedAt = performance.now();
      op.timeout = window.setTimeout(() => stopRecording(op), descriptor.capture.maxSeconds * 1000);
      op.ticker = window.setInterval(() => updateStatus(op), 1_000);
      render();
    } catch (error) {
      for (const track of stream?.getTracks() || []) track.stop();
      if (operation === op) operation = undefined;
      visual.reset();
      if (!op.abort.signal.aborted) options.onError(error instanceof Error ? error.message : String(error));
      render();
    }
  }

  function operationStatus(op: CaptureOperation) {
    if (op.phase === "permission") return "Microphone…";
    if (op.phase === "processing") return "Transcribing…";
    const elapsed = Math.floor((performance.now() - op.startedAt) / 1000);
    return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  }

  function updateStatus(op: CaptureOperation) {
    if (operation !== op) return;
    const status = options.container.querySelector<HTMLElement>(".composerCaptureStatus");
    if (status) status.textContent = operationStatus(op);
  }

  function render() {
    const focusedControl = options.container.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.captureControl
      : undefined;
    options.container.replaceChildren();
    options.container.hidden = descriptors.length === 0;
    for (const descriptor of descriptors) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "iconButton composerCaptureButton";
      button.dataset.captureControl = `capture:${descriptor.key}`;
      const own = operation?.descriptor.key === descriptor.key;
      const recording = own && operation?.phase === "recording";
      button.classList.toggle("recording", recording);
      button.disabled = Boolean(operation && !recording);
      button.title = recording ? `Stop ${descriptor.label || descriptor.title}` : descriptor.title;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(recording));
      const icon = descriptor.icon && isIconName(descriptor.icon) ? descriptor.icon : "mic";
      button.append(iconElement(recording ? "square" : icon));
      // Keep textarea focus/selection stable on touch layouts while the dynamic
      // composer controls rerender between record and stop.
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (recording && operation) stopRecording(operation);
        else if (!operation) void start(descriptor);
      });
      options.container.append(button);
    }
    if (operation) {
      const status = document.createElement("span");
      status.className = "composerCaptureStatus";
      status.textContent = operationStatus(operation);
      status.setAttribute("aria-live", "polite");
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "iconButton composerCaptureCancel";
      cancelButton.dataset.captureControl = "cancel";
      cancelButton.title = operation.phase === "processing" ? "Cancel transcription" : "Cancel recording";
      cancelButton.setAttribute("aria-label", cancelButton.title);
      cancelButton.append(iconElement("x"));
      cancelButton.addEventListener("pointerdown", (event) => event.preventDefault());
      cancelButton.addEventListener("click", cancel);
      options.container.append(status, cancelButton);
    }
    if (focusedControl) {
      let target = options.container.querySelector<HTMLElement>(`[data-capture-control="${CSS.escape(focusedControl)}"]`);
      if (target instanceof HTMLButtonElement && target.disabled) {
        target = options.container.querySelector<HTMLElement>('[data-capture-control="cancel"]');
      }
      target?.focus({ preventScroll: true });
    }
  }

  window.addEventListener("pagehide", cancel);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || !operation) return;
    if (operation.phase === "recording") stopRecording(operation);
    else if (operation.phase === "permission") cancel();
    // Processing owns no microphone and is intentionally allowed to finish.
  });

  return {
    setContributions(next: ComposerCaptureDescriptor[], sessionId: string) {
      const identity = JSON.stringify(next.map(({ key, capture }) => [key, capture]));
      const previous = JSON.stringify(descriptors.map(({ key, capture }) => [key, capture]));
      if (identity === previous && (!operation || operation.snapshot.sessionId === sessionId)) return;
      cancel();
      descriptors = next;
      render();
    },
    cancel,
  };
}
