import type { ArtifactBridges } from "./artifactBridge.js";
import { HttpError } from "../shared/httpError.js";

/** Dispatch only preview transport operations; ordinary contributions fall through. */
export function invokeArtifactBridge(
  bridges: Pick<ArtifactBridges, "invoke">,
  owner: string,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  if (body.slot !== "artifact-preview" || !body.preview || typeof body.preview !== "object") return undefined;
  if (!sessionId || typeof body.key !== "string") throw new HttpError("Invalid preview connection", 400);
  return bridges.invoke(owner, sessionId, body.key, body.preview as Record<string, unknown>, signal);
}
