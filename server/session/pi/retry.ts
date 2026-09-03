import type { PiWebSession } from "../../types.js";
import {
  isAssistantAbortedMessage,
  isAssistantFailureMessage,
  isIncompleteToolResultMessage,
} from "./projection.js";

type RetryTarget =
  | { kind: "failure"; messages: any[] }
  | { kind: "aborted"; messages: any[] }
  | { kind: "toolResult"; messages: any[] };

function targetFor(value: PiWebSession): RetryTarget | undefined {
  const messages = Array.isArray(value.agent?.state?.messages) ? value.agent.state.messages as any[] : [];
  const message = messages.at(-1);
  if (isAssistantFailureMessage(message)) return { kind: "failure", messages };
  if (isAssistantAbortedMessage(message)) return { kind: "aborted", messages };
  if (isIncompleteToolResultMessage(message)) return { kind: "toolResult", messages };
  return undefined;
}

function branchBeforeTrailingMessages(value: PiWebSession, predicate: (message: any) => boolean) {
  const manager = value.sessionManager;
  if (!manager.getBranch) return false;
  let branch: any[];
  try { branch = manager.getBranch(); } catch { return false; }
  if (!Array.isArray(branch)) return false;
  let last = -1;
  for (let index = branch.length - 1; index >= 0; index--) if (branch[index]?.type === "message") { last = index; break; }
  if (last < 0 || !predicate(branch[last]?.message)) return false;
  let first = last;
  while (first > 0 && branch[first - 1]?.type === "message" && predicate(branch[first - 1].message)) first--;
  const parentId = typeof branch[first]?.parentId === "string" ? branch[first].parentId : null;
  if (parentId && manager.branch) manager.branch(parentId);
  else if (!parentId && manager.resetLeaf) manager.resetLeaf();
  else return false;
  return true;
}

function syncMessages(value: PiWebSession) {
  if (!value.sessionManager.buildSessionContext) return false;
  value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
  return true;
}

/** Pi-only retry semantics, including compatibility with SDK versions predating retryFromFailure. */
export function canRetryPiSession(value: PiWebSession): boolean {
  return Boolean(targetFor(value));
}

export async function retryPiSession(value: PiWebSession): Promise<{ usedCompatibilityFallback: boolean }> {
  if (value.retryFromFailure) {
    await value.retryFromFailure();
    return { usedCompatibilityFallback: false };
  }
  const target = targetFor(value);
  if (!target) throw new Error("There is no failed or incomplete response to retry.");
  const internal = value as any;
  if (!internal.agent || typeof internal.agent.continue !== "function") throw new Error("Continuing is not available in this session.");
  if (target.kind === "failure") {
    if (!branchBeforeTrailingMessages(value, isAssistantFailureMessage) || !syncMessages(value)) while (target.messages.length && isAssistantFailureMessage(target.messages.at(-1))) target.messages.pop();
  } else if (target.kind === "aborted") {
    if (!branchBeforeTrailingMessages(value, isAssistantAbortedMessage) || !syncMessages(value)) if (isAssistantAbortedMessage(target.messages.at(-1))) target.messages.pop();
  }
  try {
    await internal.agent.continue();
    while (typeof internal._handlePostAgentRun === "function" && await internal._handlePostAgentRun()) await internal.agent.continue();
  } finally {
    internal._systemPromptOverride = undefined;
    internal._flushPendingBashMessages?.();
  }
  return { usedCompatibilityFallback: true };
}
