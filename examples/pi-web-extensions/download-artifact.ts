import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const ACTION_KEY = "download-artifact";

export default function downloadArtifactExtension(pi: PiWebExtensionAPI) {
  const add = (_event: unknown, ctx: PiWebExtensionContext) => {
    ctx.ui.web.contribute(ACTION_KEY, {
      slot: "artifact-action",
      kind: "rendered",
      title: "Download artifact to this device",
      label: "Download",
      render: (event) => ({
        download: { filename: typeof event?.context?.name === "string" ? event.context.name : undefined },
      }),
    });
  };

  pi.on("session_start", add);
  pi.on("session_before_switch", add);
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.web.contribute(ACTION_KEY, undefined));
}
