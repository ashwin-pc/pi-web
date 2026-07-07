/**
 * pi-web bundled auto-session-name extension.
 *
 * Automatically names a session from the first user prompt using the active
 * model. The name is set only once and only if the session has no name yet.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
	};
};

function cleanSessionName(text: string) {
	return text
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/```$/i, "")
		.trim()
		.replace(/^Title:\s*/i, "")
		.replace(/^[\["'“”‘’]+|[\["'“”‘’]+$/g, "")
		.replace(/[.!?]+$/g, "")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		// Skip if this session already has a friendly name.
		if (pi.getSessionName()) return;

		// Only name new sessions from their first user prompt.
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const hasAssistantMessages = branch.some(
			(entry) => entry.type === "message" && entry.message?.role === "assistant",
		);
		if (hasAssistantMessages) return;

		const model = ctx.model;
		if (!model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;

		try {
			const response = await complete(
				model,
				{
					systemPrompt:
						"You generate concise chat/session titles. Given the user's first prompt, respond with only a short title of 3–6 words. Do not use quotes, markdown, punctuation at the end, or explanations.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: `Prompt: ${event.prompt}` }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
			);

			if (response.stopReason === "error") {
				console.error("[pi-web auto-session-name] model error:", response.errorMessage);
				return;
			}

			const name = cleanSessionName(
				response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(""),
			);

			if (name) pi.setSessionName(name.slice(0, 80));
		} catch (error) {
			console.error("[pi-web auto-session-name] error:", String(error));
		}
	});
}
