import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveArtifactRead, resolveArtifactWrite } from "../shared.js";
import { callFusionMcp, fusionMcpUrl, type FusionDirection } from "./client.js";

const DIRECTIONS = ["front", "back", "left", "right", "top", "bottom", "iso-top-right", "iso-top-left", "iso-bottom-right", "iso-bottom-left"] as const;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function text(value: string, details: unknown = {}) { return { content: [{ type: "text" as const, text: value }], details }; }
function contentItems(result: any) { return Array.isArray(result?.content) ? result.content : []; }

export function registerFusionTools(pi: PiWebExtensionAPI) {
  pi.registerTool({
    name: "fusion_status", label: "Fusion Status",
    description: "Check the loopback-only Fusion 360 MCP server and report whether it is available.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const response = await callFusionMcp("fusion_mcp_read", { queryType: "activeCommand" }, { signal, timeoutMs: 8_000, maxResponseBytes: 512 * 1024 });
      return text(`Fusion MCP is available at ${fusionMcpUrl()}.`, response.result);
    },
  });

  pi.registerTool({
    name: "fusion_screenshot", label: "Fusion Screenshot",
    description: "Capture Fusion's active viewport as a PNG artifact. The Fusion MCP endpoint is restricted to loopback.",
    parameters: Type.Object({
      output: Type.String({ description: "Artifact-relative .png output path" }),
      width: Type.Integer({ minimum: 32, maximum: 4096 }),
      height: Type.Integer({ minimum: 32, maximum: 4096 }),
      direction: StringEnum(DIRECTIONS),
      transparent: Type.Boolean(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const output = await resolveArtifactWrite(ctx.cwd, params.output, ".png");
      return withFileMutationQueue(output.path, async () => {
        const temporary = `${output.path}.tmp-${process.pid}-${Date.now()}`;
        try {
          const response = await callFusionMcp("fusion_mcp_read", { queryType: "screenshot", width: params.width, height: params.height, direction: params.direction as FusionDirection, transparentBackground: params.transparent }, { signal, timeoutMs: 45_000, maxResponseBytes: 24 * 1024 * 1024 });
          const image = contentItems(response.result).find((item: any) => item?.type === "image");
          const encoded = image?.data ?? image?.base64Data;
          if (typeof encoded !== "string") throw new Error("Fusion MCP response did not contain an image.");
          if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw new Error("Fusion screenshot exceeds the decoded size limit.");
          const decoded = Buffer.from(encoded, "base64");
          if (!decoded.length || decoded.length > MAX_IMAGE_BYTES) throw new Error("Fusion screenshot exceeds the decoded size limit.");
          if (decoded.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Fusion screenshot is not a PNG.");
          await writeFile(temporary, decoded, { flag: "wx" });
          await rename(temporary, output.path);
          return text(`Saved Fusion screenshot: ${output.url}`, { path: output.url, bytes: decoded.length });
        } finally { await rm(temporary, { force: true }); }
      });
    },
  });

  pi.registerTool({
    name: "fusion_execute_script", label: "Execute Fusion Script",
    description: "Execute an artifact .py file inside Fusion 360. WARNING: Fusion Python is unsandboxed and runs with the user's permissions; it can mutate documents and access files.",
    parameters: Type.Object({
      script: Type.String({ description: "Artifact-relative .py script path" }),
      mutateDocument: Type.Boolean({ description: "Must be true to acknowledge unsandboxed document mutation" }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.mutateDocument !== true) throw new Error("mutateDocument:true is required. Fusion executes this script unsandboxed with user privileges.");
      const source = await resolveArtifactRead(ctx.cwd, params.script, ".py", MAX_SCRIPT_BYTES, "Fusion script");
      const script = await readFile(source.path, "utf8");
      const response = await callFusionMcp("fusion_mcp_execute", { featureType: "script", object: { script } }, { signal, timeoutMs: 120_000, maxResponseBytes: 2 * 1024 * 1024 });
      return text("Fusion executed the script unsandboxed. Review the active document and returned diagnostics.", response.result);
    },
  });
}
