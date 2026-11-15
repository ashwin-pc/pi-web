import {
  createArtifactSource,
  streamArtifactIntoRenderer,
} from "./artifactStreamSource.js";
import { createStreamShell } from "./artifactStreamShell.js";
import { createDerivedStreamController } from "./artifactDerivedStreamController.js";
import { watchArtifactConnection } from "./artifactStreamLifecycle.js";
// Only the selected session artifact crosses a private, backpressured port.
export function selectedArtifactUrl(path: string, session: string): string {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || url.search || url.hash)
    throw new Error("Invalid preview artifact URL");
  const scoped = `/api/session-artifacts/${encodeURIComponent(session)}/`;
  if (!session) throw new Error("Preview session is missing");
  if (url.pathname.startsWith(scoped)) return url.pathname;
  if (url.pathname.startsWith("/api/artifacts/"))
    return scoped + url.pathname.slice("/api/artifacts/".length);
  throw new Error("Preview artifact belongs to another session");
}
export interface ArtifactStreamOptions {
  host: HTMLElement;
  frame: HTMLIFrameElement;
  url: string;
  headers: () => Record<string, string>;
  isCurrent: () => boolean;
  onFrameReady?: (frame: HTMLIFrameElement, surface: HTMLElement) => void;
  layout?: "inline" | "panel";
  derivation?: { selection: string; key: string; sessionId: string };
  onRetry?: () => void;
}

export function mountArtifactStream(options: ArtifactStreamOptions) {
  const {
    host,
    frame,
    headers,
    isCurrent,
    onFrameReady,
    layout = "inline",
    derivation,
    onRetry,
  } = options;
  const controller = new AbortController();
  const shell = createStreamShell(host, layout);
  let unwatch = () => {};
  let streamComplete = false;
  const current = () =>
    !controller.signal.aborted && shell.ownsPanel() && isCurrent();
  const source = createArtifactSource(options, controller.signal);
  const derived = createDerivedStreamController({
    frame,
    derivation,
    headers,
    current,
    getPort: () => stream.getPort(),
    isStreamComplete: () => streamComplete,
  });
  const stream = streamArtifactIntoRenderer({
    source,
    frame,
    signal: controller.signal,
    current,
    ready: () => { streamComplete = true; },
    release: () => recover("Preview closed", "The preview has been unloaded to release its resources."),
    reopen: () => { stop(); retry(); },
    derive: () => {
      void derived.derive();
    },
    cancelDerivation: () => derived.cancel(),
    error: (error) => fail(error),
  });
  const stop = () => {
    controller.abort();
    derived.dispose();
    stream.dispose();
    unwatch();
    frame.remove();
    shell.clear();
  };
  const retry = () => {
    if (!shell.ownsPanel() || !isCurrent()) return;
    // Fresh selected-source authority must come from a re-render, never rebinding.
    if (onRetry) {
      onRetry();
      return;
    }
    if (derivation) {
      shell.reopenRequired();
      return;
    }
    mountArtifactStream({
      ...options,
      frame: frame.cloneNode(false) as HTMLIFrameElement,
    });
  };
  const recover = (heading: string, message: string) => {
    stop();
    shell.recover(heading, message, retry);
  };
  const fail = (error: unknown) => {
    if (!current()) return;
    const message =
      error instanceof TypeError
        ? "The download was interrupted. Check your connection and open again to restart loading."
        : error instanceof Error
          ? error.message
          : String(error);
    recover("Preview could not be opened", message);
  };
  unwatch = watchArtifactConnection(() => {
    if (!host.isConnected || !shell.ownsPanel() || !isCurrent()) stop();
  });
  void source
    .probe()
    .then((size) => {
      if (!current()) return;
      // Install the load listener before attaching; consent belongs to the renderer.
      void stream.run(size).catch(fail);
      shell.prepare(frame, onFrameReady);
    })
    .catch(fail);
}
