import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const ACTION_KEY = "artifact-reference";

function replaceUnsafeCharacters(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? "�" : character;
  }
  return safe;
}

function escapeMarkdownText(value: string): string {
  return replaceUnsafeCharacters(value).replace(/([\\`*_[\]{}()<>#+.!|~-])/g, "\\$1");
}

function encodeMarkdownDestination(value: string): string {
  return encodeURI(replaceUnsafeCharacters(value))
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

export default function artifactReferenceExtension(pi: PiWebExtensionAPI) {
  const add = (_event: unknown, ctx: PiWebExtensionContext) => {
    ctx.ui.web.contribute(ACTION_KEY, {
      slot: "artifact-action",
      kind: "rendered",
      title: "Copy an artifact reference",
      label: "Reference",
      render: (event) => {
        const name = typeof event?.context?.name === "string" ? event.context.name : "artifact";
        const path = typeof event?.context?.path === "string" ? event.context.path : "";
        const kind = typeof event?.context?.kind === "string" ? event.context.kind : "unknown";
        const link = `[${escapeMarkdownText(name)}](${encodeMarkdownDestination(path)})`;
        return {
          markdown: `**Artifact:** ${escapeMarkdownText(name)} (${escapeMarkdownText(kind)})\n\n**API path:** ${escapeMarkdownText(path)}\n\n**Markdown link:**\n\n    ${link}`,
        };
      },
    });
  };

  pi.on("session_start", add);
  pi.on("session_before_switch", add);
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.web.contribute(ACTION_KEY, undefined));
}
