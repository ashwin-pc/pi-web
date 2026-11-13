import type { IncomingMessage, ServerResponse } from "node:http";
import type { PiWebArtifactDeriveOptions } from "../../src/extensions.js";
import { HttpError } from "../shared/httpError.js";
import type { ArtifactDerivations } from "./artifactDerived.js";

type SelectedArtifact = Parameters<ArtifactDerivations["select"]>[0];
type RouteDependencies = {
  derivations: ArtifactDerivations;
  readBody(req: IncomingMessage): Promise<unknown>;
  resolveSessionId(value: unknown): string | undefined;
  invoke(sessionId: string, selection: SelectedArtifact, options: PiWebArtifactDeriveOptions): Promise<void>;
};

/** Called only after the server's authentication and session access gates. */
export async function handleArtifactDerivedRoute(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouteDependencies): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/api/web-contributions/artifact-derived") return false;
  const body = await deps.readBody(req) as { sessionId?: unknown; key?: unknown; selection?: unknown };
  const sessionId = deps.resolveSessionId(body.sessionId);
  if (!sessionId || typeof body.selection !== "string" || typeof body.key !== "string") throw new HttpError("Invalid derivation request", 400);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Artifact request cancelled"));
  req.once("aborted", abort);
  res.once("close", abort);
  let output: Awaited<ReturnType<ArtifactDerivations["derive"]>> | undefined;
  try {
    output = await deps.derivations.derive(body.selection, sessionId, body.key, controller.signal,
      (selection, options) => deps.invoke(sessionId, selection, options));
    controller.signal.throwIfAborted();
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": output.size, "cache-control": "no-store" });
    const stream = output.file.createReadStream({ autoClose: false });
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const close = () => { stream.destroy(); finish(); };
      const error = (reason: Error) => { cleanup(); stream.destroy(); reject(reason); };
      const cleanup = () => { stream.off("error", error); res.off("finish", finish); res.off("close", close); };
      stream.once("error", error);
      res.once("finish", finish);
      res.once("close", close);
      stream.pipe(res);
    });
  } finally {
    req.off("aborted", abort); res.off("close", abort);
    await output?.cleanup();
  }
  return true;
}

/** Convert host-only registration identity to bounded selected-source authority. */
export function mintArtifactDerivedSelection(derivations: ArtifactDerivations, sessionId: string | undefined, body: Record<string, unknown>, result: Record<string, unknown>): void {
  if (!sessionId || result.artifactDerived !== true || typeof result.registration !== "string" || typeof body.key !== "string") return;
  const context = (body.event as { context?: SelectedArtifact["artifact"] })?.context;
  if (!context) throw new HttpError("Missing selected artifact", 400);
  const prefix = `/api/session-artifacts/${encodeURIComponent(sessionId)}/`;
  const selectedUrl = context.path.startsWith("/api/artifacts/") ? prefix + context.path.slice("/api/artifacts/".length) : context.path;
  result.selection = derivations.select({ sessionId, key: body.key, registration: result.registration, artifact: context, url: selectedUrl });
  delete result.registration;
}
