import type { Readable, Writable } from "node:stream";
import type { SessionService } from "./dto.js";
import { dispatchSessionService } from "./stdioDispatcher.js";

/** Thin composition root. Production and deterministic fixtures supply the same LocalSessionService here. */
export async function runSessionRunner(options: { createService(): Promise<SessionService>; build: string; input?: Readable; output?: Writable }) {
  const service = await options.createService();
  return dispatchSessionService({ service, build: options.build, input: options.input ?? process.stdin, output: options.output ?? process.stdout });
}
