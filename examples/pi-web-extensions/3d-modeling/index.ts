import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { gcodeContribution } from "./gcode.js";
import { stlContribution } from "./stl.js";
import { registerFusionTools } from "./fusion/tools.js";
import { registerSlicingTools, slicingArtifactAction } from "./slicing/tools.js";

const GCODE_KEY = "gcode-viewer.preview";
const STL_KEY = "stl-viewer.preview";
const SLICE_KEY = "3d-modeling.slice";

export default function modelingViewers(pi: PiWebExtensionAPI) {
  registerFusionTools(pi);
  registerSlicingTools(pi);
  let cwd = "";
  const register = (ctx: any) => {
    cwd = ctx.cwd;
    const web = ctx.ui?.web;
    const caps = web?.capabilities;
    if (!web || typeof web.contribute !== "function" || !caps?.slots?.includes("artifact-preview") || !caps?.kinds?.includes("rendered")) return;
    web.contribute(GCODE_KEY, gcodeContribution(() => cwd));
    web.contribute(STL_KEY, stlContribution(() => cwd));
    if (caps.slots.includes("artifact-action")) web.contribute(SLICE_KEY, { slot: "artifact-action", kind: "rendered", ...slicingArtifactAction(pi, () => cwd) });
  };
  pi.on("session_start", (_event, ctx) => register(ctx));
  pi.on("session_before_switch", (_event, ctx) => register(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (typeof ctx.ui?.web?.contribute === "function") {
      ctx.ui.web.contribute(GCODE_KEY, undefined);
      ctx.ui.web.contribute(STL_KEY, undefined);
      ctx.ui.web.contribute(SLICE_KEY, undefined);
    }
    cwd = "";
  });
}
