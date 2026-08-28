import { basename, dirname, extname, join } from "node:path";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { Type } from "typebox";
import { artifactRelativeFromUrl } from "../shared.js";
import { sliceStl } from "./prusa.js";

const DEFAULT_PRINTER = "Original Prusa MINI & MINI+ Input Shaper";
const DEFAULT_PRINT = "0.20mm SPEED @MINIIS 0.4";
const DEFAULT_MATERIAL = "Generic PLA @MINIIS";

function defaults() {
  return {
    printerProfile: process.env.PRUSA_SLICER_PRINTER_PROFILE || DEFAULT_PRINTER,
    printProfile: process.env.PRUSA_SLICER_PRINT_PROFILE || DEFAULT_PRINT,
    materialProfile: process.env.PRUSA_SLICER_MATERIAL_PROFILE || DEFAULT_MATERIAL,
  };
}

function outputFor(input: string) {
  const extension = extname(input);
  return join(dirname(input), `${basename(input, extension)}.gcode`).replaceAll("\\", "/");
}

function markdownText(value: string) { return value.replaceAll("\\", "\\\\").replace(/([\[\]*_`])/g, "\\$1"); }
function markdownUrl(value: string) { return value.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll(" ", "%20"); }

export function registerSlicingTools(pi: PiWebExtensionAPI) {
  pi.registerTool({
    name: "slice_stl", label: "Slice STL",
    description: "Slice an artifact STL to G-code with named PrusaSlicer profiles. No arbitrary PrusaSlicer arguments are accepted.",
    parameters: Type.Object({
      input: Type.String({ description: "Artifact-relative .stl input path" }),
      output: Type.String({ description: "Artifact-relative .gcode output path" }),
      printerProfile: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: `Defaults to ${DEFAULT_PRINTER}` })),
      printProfile: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: `Defaults to ${DEFAULT_PRINT}` })),
      materialProfile: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: `Defaults to ${DEFAULT_MATERIAL}` })),
      datadir: Type.Optional(Type.String({ description: "Optional existing PrusaSlicer configuration directory" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await sliceStl(pi, ctx.cwd, { ...defaults(), ...params }, signal);
      return { content: [{ type: "text", text: `Generated ${result.url} (${result.bytes.toLocaleString()} bytes).` }], details: result };
    },
  });
}

export function slicingArtifactAction(pi: PiWebExtensionAPI, getCwd: () => string) {
  return {
    title: "Slice STL with PrusaSlicer", label: "Slice", extensions: [".stl"],
    async render(event: any) {
      const context = event?.context;
      try {
        if (!context || typeof context.path !== "string") throw new Error("The artifact context is missing.");
        const input = artifactRelativeFromUrl(context.path);
        const output = outputFor(input);
        const result = await sliceStl(pi, getCwd(), { input, output, ...defaults(), datadir: process.env.PRUSA_SLICER_DATADIR });
        // Artifact-action downloads are intentionally sanitized to the source
        // artifact by pi-web. Return an authenticated artifact link for the
        // newly generated file instead of a misleading `download` effect.
        return { markdown: `Sliced **${markdownText(context.name)}** to [${markdownText(basename(output))}](${markdownUrl(result.url)}) (${result.bytes.toLocaleString()} bytes).` };
      } catch (error) {
        return { message: `Could not slice STL: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
