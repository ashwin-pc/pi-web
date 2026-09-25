import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { InteractionQuestionDto, InteractionRequestDto, InteractionResponseDto, JsonValue, SessionServiceEvent } from "../../dto.js";

type Context = Parameters<CanUseTool>[2];
type Answer = Exclude<Awaited<ReturnType<CanUseTool>>, null>;
type Pending = { request: InteractionRequestDto; context: Context; input: Record<string, unknown>; fingerprint: string; suggestions?: PermissionUpdate[];
  questions?: Array<{ id: string; native: string; multiple: boolean; options: Map<string, string> }>;
  promise: Promise<Answer>; resolve: (answer: Answer) => void; timer: ReturnType<typeof setTimeout>; abort: () => void };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const denial = (message: string): Answer => ({ behavior: "deny", message });
function validUpdate(value: unknown): value is PermissionUpdate {
  const update = object(value);
  if (!["userSettings", "projectSettings", "localSettings", "session", "cliArg"].includes(string(update.destination))) return false;
  if (["addRules", "replaceRules", "removeRules"].includes(string(update.type))) return ["allow", "deny", "ask"].includes(string(update.behavior)) && Array.isArray(update.rules) && update.rules.length <= 64 && update.rules.every((value) => {
    const rule = object(value); return Boolean(string(rule.toolName)) && (rule.ruleContent === undefined || typeof rule.ruleContent === "string");
  });
  if (update.type === "setMode") return ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(string(update.mode));
  if (update.type === "addDirectories" || update.type === "removeDirectories") return Array.isArray(update.directories) && update.directories.length <= 64 && update.directories.every((path) => typeof path === "string" && Boolean(path));
  return false;
}

/** Claude owns permission meaning; the shared service only routes opaque choices. */
export class ClaudeApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly answered = new Map<string, { fingerprint: string; answer: Answer }>();
  private readonly instanceId = randomUUID();
  constructor(private readonly sessionId: string, private readonly timeout: number,
    private readonly publish: (event: SessionServiceEvent) => void, private readonly changed: () => void) {}

  requests(): InteractionRequestDto[] { return structuredClone([...this.pending.values()].map((entry) => entry.request)); }

  request(generation: number, toolName: string, input: Record<string, unknown>, context: Context): Promise<Answer> {
    const id = `claude:${this.instanceId}:${generation}:${context.requestId}`;
    if (context.signal.aborted) return Promise.resolve(denial("Native request cancelled"));
    if (!context.requestId || !context.toolUseID || !input || typeof input !== "object" || Array.isArray(input)) return Promise.resolve(denial("Invalid native approval request"));
    const fingerprint = JSON.stringify([toolName, context.toolUseID, context.agentID, input, context.suggestions, context.suppressAlwaysAllowRule]);
    const answered = this.answered.get(id);
    if (answered) return Promise.resolve(answered.fingerprint === fingerprint ? structuredClone(answered.answer) : denial("Native request identity changed"));
    const pending = this.pending.get(id);
    if (pending) return pending.fingerprint === fingerprint ? pending.promise : Promise.resolve(denial("Native request identity changed"));
    const request: InteractionRequestDto = {
      id, sessionId: this.sessionId, source: toolName === "AskUserQuestion" ? "clarify" : "approval", kind: toolName === "AskUserQuestion" ? "questions" : "tool-permission",
      title: context.title || (toolName === "AskUserQuestion" ? "Claude asks a question" : `Allow ${toolName}?`),
      body: context.description || context.decisionReason,
      timeout: this.timeout, expiresAt: new Date(Date.now() + this.timeout).toISOString(),
      payload: { toolName, toolUseID: context.toolUseID, input: JSON.parse(JSON.stringify(input)) as JsonValue,
        defaultToNo: context.defaultToNo === true, suppressAlwaysAllowRule: context.suppressAlwaysAllowRule === true,
        ...(context.agentID ? { agentId: context.agentID } : {}), ...(context.blockedPath ? { blockedPath: context.blockedPath } : {}) },
      choices: [
        { id: "deny", label: "Deny", meaning: "decline" },
        { id: "allow-once", label: "Allow once", meaning: "accept", scope: "this tool call" },
        { id: "stop", label: "Deny and stop response", meaning: "cancel", scope: "current response" },
      ],
    };
    let questions: Pending["questions"];
    if (toolName === "AskUserQuestion") {
      if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return Promise.resolve(denial("Unsupported native question form"));
      questions = [];
      const dto: InteractionQuestionDto[] = [];
      for (const [index, raw] of input.questions.entries()) {
        const question = object(raw);
        const native = string(question.question);
        if (!native || native.length > 8000 || questions.some((entry) => entry.native === native) || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return Promise.resolve(denial("Unsupported native question form"));
        const id = `question-${index}`;
        const options = new Map<string, string>();
        const displays: Array<{ id: string; label: string }> = [];
        for (const [n, rawOption] of question.options.entries()) {
          const option = object(rawOption);
          const label = string(option.label);
          if (!label || label.length > 2000) return Promise.resolve(denial("Invalid native question option"));
          const optionId = `option-${n}`;
          options.set(optionId, label);
          displays.push({ id: optionId, label: `${label}${option.description ? ` — ${string(option.description)}` : ""}` });
        }
        questions.push({ id, native, multiple: question.multiSelect === true, options });
        dto.push({ id, label: native, description: string(question.header) || undefined, options: displays, multiple: question.multiSelect === true, required: true, allowFreeText: true });
      }
      request.questions = dto;
      request.choices = [{ id: "submit", label: "Submit answers", meaning: "submit" }, { id: "deny", label: "Decline", meaning: "decline" }];
    }
    const suggestions = !questions && !context.suppressAlwaysAllowRule && Array.isArray(context.suggestions) && context.suggestions.length > 0 && context.suggestions.length <= 32 && context.suggestions.every(validUpdate) ? structuredClone(context.suggestions) : undefined;
    if (suggestions) {
      const scope = [...new Set(suggestions.map((update) => update.destination))].join(", ");
      const summary = suggestions.map((update) => `${update.type}: ${"rules" in update ? update.rules.map((rule) => `${rule.toolName}${rule.ruleContent === undefined ? "" : `(${rule.ruleContent})`}`).join(", ") : "mode" in update ? update.mode : update.directories.join(", ")} [${update.destination}]`).join("; ");
      request.payload.permissionSuggestionSummary = summary;
      request.choices!.push({ id: "allow-suggested", label: `Allow and remember (${scope}): ${summary.slice(0, 240)}`, meaning: "accept", scope });
    }
    let resolve!: (answer: Answer) => void;
    const promise = new Promise<Answer>((done) => { resolve = done; });
    const abort = () => this.finish(id, denial("Native request cancelled"), "native");
    const timer = setTimeout(() => this.finish(id, denial("Approval timed out"), "expired"), this.timeout);
    timer.unref?.();
    this.pending.set(id, { request, context, input, fingerprint, questions, suggestions, promise, resolve, timer, abort });
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    else { this.publish({ type: "interaction", request: structuredClone(request) }); this.changed(); }
    return promise;
  }

  respond(response: InteractionResponseDto): boolean {
    if (response.sessionId !== this.sessionId) return false;
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    const choice = response.cancelled === true ? "deny" : response.choiceID;
    if (!choice || !entry.request.choices?.some((option) => option.id === choice)) return false;
    let answer: PermissionResult;
    if (choice === "deny") answer = denial("User declined this request");
    else if (choice === "stop") answer = { behavior: "deny", message: "User denied and stopped the response", interrupt: true };
    else if (choice === "allow-once") answer = { behavior: "allow", updatedInput: entry.input };
    else if (choice === "allow-suggested" && entry.suggestions) answer = { behavior: "allow", updatedInput: entry.input, updatedPermissions: entry.suggestions };
    else if (choice === "submit" && entry.questions && response.answers) {
      if (Object.keys(response.answers).some((id) => !entry.questions!.some((question) => question.id === id))) return false;
      const answers = Object.create(null) as Record<string, string | string[]>;
      for (const question of entry.questions) {
        const responseValue = response.answers[question.id];
        const values = Array.isArray(responseValue) ? responseValue : [responseValue];
        if (!values.length || (!question.multiple && values.length !== 1) || values.length > 5 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 8000)) return false;
        const labels = (values as string[]).map((value) => question.options.get(value) ?? value);
        answers[question.native] = question.multiple ? labels : labels[0]!;
      }
      answer = { behavior: "allow", updatedInput: { ...entry.input, answers } };
    } else return false;
    this.finish(response.id, answer, "responded");
    return true;
  }

  cancel(reason: "timeout" | "disconnect" | "disposed"): void {
    for (const id of [...this.pending.keys()]) this.finish(id, denial(`Approval ${reason}`), reason === "disposed" ? "disposed" : reason === "timeout" ? "expired" : "cancelled");
  }

  private finish(id: string, answer: Answer, reason: "responded" | "expired" | "cancelled" | "native" | "disposed"): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.context.signal.removeEventListener("abort", entry.abort);
    this.answered.set(id, { fingerprint: entry.fingerprint, answer });
    if (this.answered.size > 256) this.answered.delete(this.answered.keys().next().value!);
    this.publish({ type: "interaction_resolved", sessionId: this.sessionId, id, reason });
    this.changed();
    entry.resolve(answer);
  }
}
