import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isSessionReferenceId, parseSessionReference, sessionReferenceHref, type SessionReference } from "../shared/sessionReference.js";

const parameters = Type.Object({
  id: Type.String({ description: "Session ID or canonical pi-web session URL. A URL with entryId reads that exact saved entry." }),
  tail: Type.Optional(Type.Number({ description: "Trailing entries to include (default 20, maximum 200; ignored for an exact entry URL)" })),
});
type Parameters = Static<typeof parameters>;

export type SessionReadText = { entryId?: string; text: string; truncated?: boolean };
/** Deliberately narrow, read-only data supplied by LocalSessionService. */
export type SessionReadResult = {
  reference: SessionReference;
  source: "active branch" | "saved history (may include alternate branches)";
  entries: SessionReadText[];
  truncated: boolean;
};
export type ReadSession = (reference: SessionReference, tail: number) => Promise<SessionReadResult>;

export function truncateSessionText(value: string, limit: number) {
  return value.length <= limit ? { text: value, truncated: false } : { text: `${value.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

export function sessionsReadTail(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value === 0) return 20;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function sessionReferenceForId(id: string): SessionReference | undefined {
  const value = id.trim();
  return parseSessionReference(value) || (isSessionReferenceId(value) ? { sessionId: value } : undefined);
}

function formatRead(result: SessionReadResult) {
  const href = sessionReferenceHref(result.reference);
  const lines = [
    `Read-only session ${href} (${result.source}).`,
    ...result.entries.map((entry) => `${entry.entryId ? `${sessionReferenceHref({ ...result.reference, entryId: entry.entryId })}\n` : ""}${entry.text}`),
    ...(result.truncated ? ["… Earlier or longer saved text was omitted."] : []),
  ];
  return { text: lines.join("\n") || "(no messages)", href };
}

/** Native core tool; it does not depend on extension lifecycle or HTTP access. */
export function createSessionsReadTools(readSession: ReadSession): ToolDefinition[] {
  return [defineTool({
    name: "sessions_read",
    label: "Read session transcript",
    description: "Read a compact, read-only transcript tail from another saved session. Pass its session ID or a copied pi-web session URL; a URL with entryId reads that exact entry without changing the session.",
    promptSnippet: "Read the recent transcript of another session",
    promptGuidelines: ["Use sessions_read to inspect a cited or worker session without steering, opening, or changing it."],
    parameters,
    async execute(_toolCallId, params: Parameters) {
      const reference = sessionReferenceForId(params.id);
      if (!reference) throw new Error("sessions_read: id must be a session ID or canonical pi-web session URL.");
      const result = await readSession(reference, sessionsReadTail(params.tail));
      const formatted = formatRead(result);
      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          sessionId: reference.sessionId,
          ...(reference.entryId ? { entryId: reference.entryId } : {}),
          href: formatted.href,
          sessionRefs: [reference],
          ...(result.truncated ? { truncated: true } : {}),
        },
      };
    },
  })];
}
