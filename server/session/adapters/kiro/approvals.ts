import type { RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { InteractionChoiceDto } from "../../dto.js";
import { approvalContext } from "../codex/approval-context.js";
import { mergeTool } from "./projection.js";
import { object } from "./transport.js";

export const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
export type KiroApproval = { body: string; choices: InteractionChoiceDto[]; responses: Map<string, RequestPermissionResponse> };
/** The browser never supplies native option IDs or policy JSON. Remembered scopes
 * are deliberately absent until Kiro's actual persistence semantics are verified. */
export function approval(value: unknown, previous?: ToolCallUpdate): KiroApproval | undefined {
  const raw = object(value);
  const tool = object(raw?.toolCall);
  if (!raw || !tool || Object.keys(raw).some((k) => !["sessionId", "toolCall", "options", "_meta"].includes(k))
    || Object.keys(tool).some((k) => !["toolCallId", "kind", "status", "title", "name", "content", "locations", "rawInput", "rawOutput", "_meta"].includes(k))
    || typeof tool.toolCallId !== "string" || !Array.isArray(raw.options) || raw.options.length > 100) return;
  const request = value as RequestPermissionRequest;
  const merged = mergeTool(previous, request.toolCall);
  if (typeof merged.title !== "string" || !merged.title.trim() || !["read", "edit", "delete", "move", "search", "execute", "fetch", "other"].includes(merged.kind ?? "")
    || !object(merged.rawInput) || !Object.keys(merged.rawInput as object).length) return;
  const ids = new Set<string>();
  for (const option of request.options) {
    if (!object(option) || typeof option.optionId !== "string" || !option.optionId || ids.has(option.optionId) || typeof option.name !== "string"
      || !["allow_once", "reject_once", "allow_always", "reject_always"].includes(option.kind)) return;
    ids.add(option.optionId);
  }
  const context = { toolCall: merged, options: request.options, scope: "Only once choices are available. Remembered permission changes are not supported." };
  const body = approvalContext(context);
  if (!body) return;
  const responses = new Map<string, RequestPermissionResponse>();
  const choices: InteractionChoiceDto[] = [];
  for (const [index, option] of request.options.entries()) {
    if (option.kind !== "allow_once" && option.kind !== "reject_once") continue;
    const id = `option-${index}`;
    choices.push({ id, label: option.kind === "allow_once" ? "Allow once" : "Decline action", meaning: option.kind === "allow_once" ? "accept" : "decline", scope: "once" });
    responses.set(id, { outcome: { outcome: "selected", optionId: option.optionId } });
  }
  choices.push({ id: "cancel", label: "Stop turn", meaning: "cancel" });
  responses.set("cancel", cancelled);
  return { body, choices, responses };
}
