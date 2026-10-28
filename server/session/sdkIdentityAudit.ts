import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Prompt = AgentSession["agent"]["prompt"];

/** Optional proof only: resolution/import failure must never prevent startup or
 * turn an ambiguous rejected custom send into a proven non-admission. Capture
 * before loading extensions, rather than trusting a later instance/prototype.
 */
export async function captureOriginalAgentPrompt(
  resolve = () => {
    const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    try { return pathToFileURL(require.resolve("@earendil-works/pi-agent-core")).href; }
    catch {
      // The current SDK dependency is import-only. Use its public package.json
      // export as a compatibility fallback; unknown export shapes disable proof.
      const path = require.resolve("@earendil-works/pi-agent-core/package.json");
      const entry: unknown = require(path).exports?.["."]?.import;
      if (typeof entry !== "string") throw new Error("Unknown agent-core export");
      return new URL(entry, pathToFileURL(path)).href;
    }
  },
  load: (url: string) => Promise<{ Agent: { prototype: { prompt: Prompt } } }> = url => import(url),
): Promise<Prompt | undefined> {
  try { return (await load(resolve())).Agent.prototype.prompt; }
  catch { return undefined; }
}
