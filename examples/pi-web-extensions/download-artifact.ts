// Uses typed compatibility wrappers; see notepad.ts for the current contribute() API.
import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const ACTION_KEY = "download-artifact";

export default function downloadArtifactExtension(pi: PiWebExtensionAPI) {
  const add = (_event: unknown, ctx: PiWebExtensionContext) => {
    ctx.ui.web.setArtifactAction(ACTION_KEY, {
      title: "Download artifact to this device",
      label: "Download",
      invoke: ({ name }) => ({ download: { filename: name } }),
    });
  };

  pi.on("session_start", add);
  pi.on("session_before_switch", add);
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.web.setArtifactAction(ACTION_KEY, undefined));
}
