import { generateSummary } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "@ashwin-pc/pi-web/extensions";

const RECAP_INSTRUCTIONS = [
  "Produce an extremely terse session recap as Markdown.",
  "Return at most TWO short sentences total, no headings and no bullets.",
  "Sentence 1: what this session is about.",
  "Sentence 2: what's happening now.",
  "Each sentence must be maximum 18 words.",
  "Do not include caveats, implementation details, or extra sections.",
].join("\n");

async function buildRecap(ctx: PiWebExtensionContext) {
  const model = ctx.model;
  if (!model) throw new Error("No model is configured for this session");
  const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
  if (!messages.length) throw new Error("This session has no messages to recap yet");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const markdown = await generateSummary(messages, model, 4096, auth.apiKey, auth.headers, ctx.signal, RECAP_INSTRUCTIONS);
  return { markdown: markdown.trim() };
}

export default function recapExtension(pi: PiWebExtensionAPI) {
  const add = (_event: unknown, ctx: PiWebExtensionContext) => {
    ctx.ui.web.setHeaderAction("recap", {
      icon: "scroll-text",
      title: "Session recap",
      label: "Recap",
      invoke: () => buildRecap(ctx),
    });
  };

  pi.on("session_start", add);
  pi.on("session_before_switch", add);
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.web.setHeaderAction("recap", undefined));
}
