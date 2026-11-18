import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { Type } from "typebox";
import { CadError, runCad } from "./cad/core.js";
import { redact, redactValue } from "./cad/process.js";

/** The optional agent surface uses exactly the standalone CLI's dispatcher. */
export function registerModelingTool(pi: PiWebExtensionAPI) {
  pi.registerTool({
    name: "modeling",
    label: "Modeling CLI",
    description: "Run the shared modeling CLI. Start with args:['help'] or ['discover']; use ['fusion','capabilities'] to discover the installed MCP schemas. The same argv supports Fusion reads/API documentation, screenshots, incremental Python execution, undo/redo, configured local runtimes, image-to-3D and slicing. Fusion scripts must define a fresh run(context) callback. Fusion execute/update and local runtime script commands require explicit --allow-mutation; --read-only requires an advertised upstream boolean flag and requests upstream design-read-only execution, not a security sandbox. Generic MCP read/resource queries follow the installed bridge's contract. Transport cancellation does not guarantee a remote Fusion mutation stopped; inspect state before retrying. Paths refer to the current workspace's artifact directory. No models load during discovery.",
    parameters: Type.Object({
      args: Type.Array(Type.String({ maxLength: 262144 }), { maxItems: 128, description: "CLI argument vector without executable. Example: ['fusion','read','--json','{\"queryType\":\"activeCommand\"}']. Use ['help'] for all commands and parameter contracts." }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      let result: unknown;
      try {
        result = await runCad(params.args, { cwd: ctx.cwd, signal, exec: pi.exec.bind(pi) });
      } catch (error) {
        if (error instanceof CadError) {
          // Throw, rather than returning successful content, while retaining the
          // same diagnostic fields exposed by the standalone CLI.
          throw new Error(JSON.stringify(redactValue({ ok: false, error: redact(error.message), exitCode: error.exitCode, ...(error.result !== undefined ? { result: error.result } : {}) })));
        }
        throw error;
      }
      const serialized = JSON.stringify(result, null, 2);
      // Full structured output remains available to the host; keep advertised
      // discovery schemas from overwhelming the model's text context.
      const text = serialized.length <= 48000 ? serialized : `${serialized.slice(0, 48000)}\n[Text truncated; narrow the query or use the standalone CLI for full JSON.]`;
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
