import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { callFusionMcp, fusionMcpUrl, requestFusionMcp } from "../fusion/client.js";
import { fusionCapabilities, fusionScreenshot, fusionScript, SCRIPT_CONTRACT } from "../fusion/adapter.js";
import { generateHunyuan } from "../hunyuan/tools.js";
import { sliceStl } from "../slicing/prusa.js";
import { slicingDefaults } from "../slicing/tools.js";
import { discover, executeModeling } from "./runtime.js";
import { execLocal, redact, redactValue } from "./process.js";

export interface CadContext { cwd: string; signal?: AbortSignal; exec?: PiWebExtensionAPI["exec"] }
export class CadError extends Error {
  constructor(message: string, public exitCode = 1, public result?: unknown) { super(redact(message)); this.name = "CadError"; }
}
const COMMANDS = [
  { command: "help [command]", description: "Offline complete command/parameter reference; same arguments in CLI and modeling tool." },
  { command: "discover", description: "Offline configured runtime filesystem evidence and backend setup; no MCP connection or model startup." },
  { command: "fusion capabilities [--cursor STRING]", description: "Live bounded MCP tools/list including full schemas; use returned nextCursor to page explicitly." },
  { command: "fusion resources [--cursor STRING]", description: "Live bounded MCP resources/list catalog. Page explicitly with returned nextCursor; catalog presence does not guarantee useful resource content." },
  { command: "fusion resource --json OBJECT", description: "Read-only MCP resources/read; JSON: uri (required string). Content and schemas depend on the installed bridge; no arbitrary RPC passthrough." },
  { command: "fusion electronics --json OBJECT", description: "Generic read-only fusion_mcp_electronics_read arguments forwarded unchanged. Discover installed entity/schema support using fusion capabilities and fusion resources; no hardcoded entity list." },
  { command: "fusion status", description: "Live read activeCommand probe." },
  { command: "fusion read --json OBJECT", description: "Generic fusion_mcp_read query forwarded unchanged. queryType: projects, document (operation search/open/recent), activeCommand, apiDocumentation, screenshot. Use capabilities for the installed schema. No execute or update RPC passthrough." },
  { command: "fusion docs --json OBJECT", description: "API documentation read. JSON fields searchPattern (required), apiCategory class/member/description/all, filter (optional); queryType forced to apiDocumentation. Some bridges return success without documentation payload; that is not evidence that class/member docs were retrieved. Inspect returned content and resource catalogs; missing upstream docs remain a backend limitation." },
  { command: "fusion screenshot --json OBJECT", description: "Save bounded PNG artifact. JSON: output (required .png), width/height (32–4096, default 1024/768), direction (current/front/back/top/bottom/left/right/iso-top-left/iso-top-right/iso-bottom-left/iso-bottom-right), transparent (boolean default false)." },
  { command: "fusion exec --script ARTIFACT.py (--read-only | --allow-mutation)", description: SCRIPT_CONTRACT + " Read-only requires advertised upstream boolean readOnly support and otherwise fails closed." },
  { command: "fusion undo --allow-mutation", description: "Explicit document mutation via fusion_mcp_update featureType undo; no automatic retry." },
  { command: "fusion redo --allow-mutation", description: "Explicit document mutation via fusion_mcp_update featureType redo." },
  { command: "slice --json OBJECT", description: "Named-profile PrusaSlicer only; JSON: input (.stl), output (.gcode) required; printerProfile, printProfile, materialProfile optional (1–200 chars); datadir optional existing directory. No arbitrary slicer argv.", defaults: slicingDefaults() },
  { command: "hunyuan generate --json OBJECT", description: "Owned installed Hunyuan3D 2.1 image→untextured GLB. JSON: image artifact PNG/JPEG/WebP required; seed safe integer >=0 optional; steps 1–50 default30; resolution 128/256 default256. Requires explicit PI_HUNYUAN_COMFY_ROOT, optional PI_HUNYUAN_PYTHON. Runner owns ComfyUI lifecycle/cleanup. No downloads, texture, scale or printability guarantee." },
  { command: "runtime discover", description: "Configured generic local runtimes (Blender, procedural Python, etc.), filesystem evidence only. PI_MODELING_CONFIG or ~/.pi/modeling.json; no default runtimes or inference." },
  { command: "runtime exec --json OBJECT --allow-mutation", description: "Unsandboxed owned POSIX process-group execution. JSON: runtime configured id, script artifact path, timeoutMs optional <=configured limit. Retains source snapshot, hash, redacted logs/results. Whole-argument placeholders {script}, {artifacts}, {run}. No arbitrary executable/argv overrides." },
];

function help(topic = "") {
  return { name: "modeling", version: 1, invocation: "node /absolute/path/to/3d-modeling/cad.mjs <args>", sourceInvocation: "node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts <args>", request: { args: "string[] (identical CLI argv)" }, global: "--timeout-ms INTEGER (1–3900000, default 1800000; hunyuan generate defaults to 3900000 to cover its 3-minute startup + 1-hour generation budget and cleanup); bounds the complete invocation, propagates cancellation. Aborting Fusion transport does NOT cancel remote execution: document state is unknown and mutation must not be automatically retried. CLI success JSON to stdout; errors JSON to stderr only. Exit codes 0 success, 1 backend/configuration failure, 2 invalid arguments, 124 timeout, 130 cancellation.", artifacts: "Paths are relative to <cwd>/.pi/web/artifacts; traversal and escaping symlinks rejected. Fusion Python and configured runtimes are unsandboxed trusted code, not a security sandbox.", scope: "CAD modeling and read-only MCP introspection. Optional marketing, purchase and media services are excluded; no arbitrary MCP RPC invocation is exposed.", commands: COMMANDS.filter(c => !topic || c.command.startsWith(topic)), runtimeConfig: { version: 1, runtimes: [{ id: "blender", description: "Explicit locally installed Blender", executable: "/absolute/path/to/blender", args: ["--background", "--python-exit-code", "1", "--python", "{script}", "--", "{run}"], scriptExtension: ".py", requiredPaths: [], timeoutMs: 120000 }] } };
}

function parse(args: string[]) {
  if (!Array.isArray(args) || args.length > 128 || args.some(a => typeof a !== "string" || a.length > 256 * 1024 || a.includes("\0"))) throw new CadError("Invalid bounded argv string array.", 2);
  const words: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (!["json", "script", "cursor", "timeout-ms", "read-only", "allow-mutation", "help"].includes(name) || Object.hasOwn(flags, name)) throw new CadError(`Unknown or repeated option: ${arg}`, 2);
    if (["read-only", "allow-mutation", "help"].includes(name)) flags[name] = true;
    else { const value = args[++i]; if (value === undefined || value.startsWith("--")) throw new CadError(`${arg} needs a value.`, 2); flags[name] = value; }
  }
  return { words, flags };
}
function json(flags: Record<string, string | true>, allowed?: string[]): Record<string, any> {
  let value: any;
  try { value = JSON.parse(String(flags.json)); } catch { throw new CadError("--json requires a JSON object.", 2); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CadError("--json requires a JSON object.", 2);
  if (allowed && Object.keys(value).some(k => !allowed.includes(k))) throw new CadError("Unknown JSON field; use help for the command schema.", 2);
  return value;
}

/** One argv contract and dispatch path for the standalone CLI and optional single extension tool. */
export async function runCad(args: string[], context: CadContext): Promise<unknown> {
  const { words, flags } = parse(args);
  if (!words.length || words[0] === "help" || flags.help) return redactValue(help(words[0] === "help" ? words.slice(1).join(" ") : words.join(" ")));
  const command = words.join(" ");
  const allowed: Record<string, string[]> = {
    discover: [], "fusion capabilities": ["cursor"], "fusion resources": ["cursor"], "fusion resource": ["json"], "fusion electronics": ["json"], "fusion status": [], "fusion read": ["json"], "fusion docs": ["json"], "fusion screenshot": ["json"], "fusion exec": ["script", "read-only", "allow-mutation"], "fusion undo": ["allow-mutation"], "fusion redo": ["allow-mutation"], slice: ["json"], "hunyuan generate": ["json"], "runtime discover": [], "runtime exec": ["json", "allow-mutation"],
  };
  if (!allowed[command]) throw new CadError("Unknown command; use help for the complete reference.", 2);
  if (Object.keys(flags).some(flag => flag !== "timeout-ms" && !allowed[command].includes(flag))) throw new CadError("Option is not valid for this command; use help.", 2);
  // Hunyuan owns a 3-minute startup + 1-hour generation budget; allow
  // another two minutes for setup/cleanup instead of truncating it at 30m.
  const timeoutMs = flags["timeout-ms"] === undefined ? (command === "hunyuan generate" ? 3_900_000 : 1_800_000) : Number(flags["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_900_000) throw new CadError("--timeout-ms must be an integer from 1 to 3900000.", 2);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    let result: unknown;
    switch (command) {
      case "discover": result = { reference: help(), fusion: { endpoint: fusionMcpUrl(), state: "not-probed", discover: "fusion capabilities" }, hunyuan: { configured: !!process.env.PI_HUNYUAN_COMFY_ROOT?.trim(), state: "not-probed", geometryOnly: true }, runtimes: await discover() }; break;
      case "runtime discover": result = await discover(); break;
      case "fusion capabilities": result = await fusionCapabilities(signal, flags.cursor as string | undefined); break;
      case "fusion resources": result = (await requestFusionMcp("resources/list", flags.cursor ? { cursor: flags.cursor } : {}, { signal, timeoutMs: 8000 })).result; break;
      case "fusion resource": {
        const query = json(flags, ["uri"]);
        if (typeof query.uri !== "string" || !query.uri || query.uri.length > 8192 || /[\x00-\x1f]/.test(query.uri)) throw new CadError("uri must be a nonempty resource URI string (maximum 8192 characters, no control characters).", 2);
        result = (await requestFusionMcp("resources/read", query, { signal })).result; break;
      }
      case "fusion electronics": result = (await callFusionMcp("fusion_mcp_electronics_read", json(flags), { signal })).result; break;
      case "fusion status": result = (await callFusionMcp("fusion_mcp_read", { queryType: "activeCommand" }, { signal, timeoutMs: 8000 })).result; break;
      case "fusion read": {
        const query = json(flags);
        if (typeof query.queryType !== "string" || !query.queryType) throw new CadError("queryType is required; use fusion capabilities for the installed read schema.", 2);
        result = (await callFusionMcp("fusion_mcp_read", query, { signal })).result; break;
      }
      case "fusion docs": {
        const query = json(flags, ["searchPattern", "apiCategory", "filter"]);
        if (typeof query.searchPattern !== "string" || !query.searchPattern) throw new CadError("searchPattern is required.", 2);
        result = (await callFusionMcp("fusion_mcp_read", { apiCategory: "all", ...query, queryType: "apiDocumentation" }, { signal })).result; break;
      }
      case "fusion screenshot": result = await fusionScreenshot(context.cwd, json(flags, ["output", "width", "height", "direction", "transparent"]), signal); break;
      case "fusion exec": {
        if (typeof flags.script !== "string" || !!flags["read-only"] === !!flags["allow-mutation"]) throw new CadError("--script plus exactly one of --read-only / --allow-mutation is required. Unsandboxed Python runs with user permissions.", 2);
        result = await fusionScript(context.cwd, flags.script, flags["read-only"] ? "read-only" : "mutate", signal); break;
      }
      case "fusion undo": case "fusion redo":
        if (!flags["allow-mutation"]) throw new CadError("--allow-mutation is required for undo/redo.", 2);
        result = (await callFusionMcp("fusion_mcp_update", { featureType: words[1] }, { signal, timeoutMs: 120_000 })).result; break;
      case "slice": {
        const options = json(flags, ["input", "output", "printerProfile", "printProfile", "materialProfile", "datadir"]);
        if (typeof options.input !== "string" || typeof options.output !== "string" || Object.values(options).some(v => typeof v !== "string")) throw new CadError("Slice input/output and supplied profiles/datadir must be strings.", 2);
        result = await sliceStl({ exec: context.exec ?? execLocal }, context.cwd, { ...slicingDefaults(), ...options } as any, signal); break;
      }
      case "hunyuan generate": result = await generateHunyuan(context.cwd, json(flags, ["image", "seed", "steps", "resolution"]) as any, signal); break;
      case "runtime exec": {
        if (!flags["allow-mutation"]) throw new CadError("--allow-mutation is required for unsandboxed local runtime scripts.", 2);
        const options = json(flags, ["runtime", "script", "timeoutMs"]);
        if (typeof options.runtime !== "string" || typeof options.script !== "string") throw new CadError("runtime and script strings are required.", 2);
        const run = await executeModeling(context.cwd, { ...options, acknowledgeUnsandboxed: true } as any, signal);
        if (run.status !== "succeeded") throw new CadError(`Local runtime ${run.status}.`, run.status === "timed-out" ? 124 : run.status === "cancelled" ? 130 : 1, run);
        result = run; break;
      }
    }
    signal.throwIfAborted();
    // Sanitize diagnostics at the shared boundary, not just in the CLI printer.
    return redactValue(result ?? null);
  } catch (error) {
    const remoteWarning = command.startsWith("fusion ") ? " Aborting transport does not cancel Fusion execution. Remote completion and document state are unknown; do not automatically retry mutation. Inspect Fusion before continuing." : " Local adapter cancellation was requested; inspect retained lifecycle evidence before assuming cleanup completed.";
    const evidence = error instanceof CadError ? redactValue(error.result) : undefined;
    if (context.signal?.aborted) throw new CadError(`Modeling invocation cancelled.${remoteWarning}`, 130, evidence);
    if (timeout.aborted) throw new CadError(`Modeling invocation timed out.${remoteWarning}`, 124, evidence);
    if (command.startsWith("fusion ") && error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new CadError(`Fusion transport interrupted.${remoteWarning}`, error.name === "TimeoutError" ? 124 : 130);
    if (command.startsWith("fusion ") && error instanceof TypeError) throw new CadError(`Fusion transport failed: ${error.message}.${remoteWarning}`);
    if (error instanceof CadError) { error.message = redact(error.message); error.result = redactValue(error.result); throw error; }
    throw new CadError(redact(error instanceof Error ? error.message : String(error)));
  }
}
