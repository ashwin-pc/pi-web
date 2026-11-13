import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveArtifactRead, resolveArtifactWrite } from "../shared.js";
import { callFusionMcp, requestFusionMcp } from "./client.js";

export const SCRIPT_CONTRACT = "Source is forwarded unchanged: the CLI does not parse Python, enforce the callback, reset retained globals, or wrap source. Caller responsibility: define a fresh top-level def run(context): with exactly one argument on every call; put operations inside it, never overwrite run, and let exceptions propagate. Fusion may retain globals. Python is unsandboxed; --read-only is an upstream intent flag, not a filesystem/security sandbox. Never blindly retry mutation after an error.";
export async function fusionCapabilities(signal?: AbortSignal, cursor?: string) {
  return (await requestFusionMcp("tools/list", cursor ? { cursor } : {}, { signal, timeoutMs: 8000 })).result;
}

export async function fusionScript(cwd: string, scriptPath: string, mode: "read-only" | "mutate", signal?: AbortSignal) {
  const source = await resolveArtifactRead(cwd, scriptPath, ".py", 256 * 1024, "Fusion script");
  const script = await readFile(source.path, "utf8");
  // Do not regex-parse Python or wrap source: annotations, multiline signatures,
  // strings and rebinding cannot be interpreted reliably here. The caller must
  // supply a fresh callback; Fusion reports Python syntax/runtime diagnostics.
  const args: any = { featureType: "script", object: { script } };
  if (mode === "read-only") {
    // Fail closed on old bridges: an ignored intent flag would falsely promise read-only execution.
    const capabilities = await fusionCapabilities(signal);
    const schema = capabilities?.tools?.find((tool: any) => tool.name === "fusion_mcp_execute")?.inputSchema;
    if (schema?.properties?.readOnly?.type === "boolean") args.readOnly = true;
    else if (schema?.properties?.object?.properties?.readOnly?.type === "boolean") args.object.readOnly = true;
    else throw new Error("Fusion bridge does not advertise a boolean readOnly script flag; use fusion read queries, or explicitly acknowledge --allow-mutation for unsandboxed Python.");
  }
  return (await callFusionMcp("fusion_mcp_execute", args, { signal, timeoutMs: 120_000 })).result;
}

export async function fusionScreenshot(cwd: string, params: Record<string, any>, signal?: AbortSignal) {
  const { output, width = 1024, height = 768, direction = "current", transparent = false } = params;
  if (typeof output !== "string") throw new Error("Screenshot output is required.");
  if (![width, height].every(value => Number.isInteger(value) && value >= 32 && value <= 4096)) throw new Error("Screenshot dimensions must be integers from 32 to 4096.");
  if (!["current", "front", "back", "left", "right", "top", "bottom", "iso-top-right", "iso-top-left", "iso-bottom-right", "iso-bottom-left"].includes(direction) || typeof transparent !== "boolean") throw new Error("Invalid screenshot direction or transparency.");
  const target = await resolveArtifactWrite(cwd, output, ".png");
  return withFileMutationQueue(target.path, async () => {
    const temporary = `${target.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      const response = await callFusionMcp("fusion_mcp_read", { queryType: "screenshot", width, height, direction, transparentBackground: transparent }, { signal, timeoutMs: 45_000, maxResponseBytes: 24 * 1024 * 1024 });
      const image = response.result?.content?.find((item: any) => item?.type === "image");
      const encoded = image?.data ?? image?.base64Data;
      if (typeof encoded !== "string" || encoded.length > Math.ceil(16 * 1024 * 1024 * 4 / 3) + 8) throw new Error("Fusion screenshot missing or exceeds size limit.");
      const decoded = Buffer.from(encoded, "base64");
      if (!decoded.length || decoded.length > 16 * 1024 * 1024 || decoded.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Fusion screenshot is not a bounded PNG.");
      await writeFile(temporary, decoded, { flag: "wx" });
      await rename(temporary, target.path);
      return { url: target.url, bytes: decoded.length };
    } finally { await rm(temporary, { force: true }); }
  });
}
