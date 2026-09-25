import { approvalContext } from "../codex/approval-context.js";
import { redactCredentials } from "./transport.js";

/** Kiro rawInput is arbitrary JSON, unlike Codex's whitelisted permission fields.
 * Check the entire reversible rendering as well as each bounded value so a
 * credential-bearing JSON key cannot hide the meaning of its otherwise plain value. */
export function kiroContext(value: unknown): string | undefined {
  const text = approvalContext(value);
  return text !== undefined && redactCredentials(text) === text ? text : undefined;
}
