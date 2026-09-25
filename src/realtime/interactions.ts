import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import { activeSessionState, harnessName } from "../app/sessionState.js";
import type { InteractionRequestDto, InteractionResponseDto } from "../../server/session/dto.js";

/** A contextual request surface, not a permission policy editor. Native mappings stay server-side. */
export function createInteractions(options: { state: AppState; elements: AppElements; api: ApiClient; refreshState: () => Promise<void> }) {
  const { state, elements, api, refreshState } = options;
  const panel = document.createElement("section");
  panel.className = "pendingInteractions";
  panel.setAttribute("aria-label", "Pending agent requests");
  panel.hidden = true;
  elements.pendingMessagesEl.before(panel);
  const sending = new Set<string>();
  const errors = new Map<string, string>();
  const cards = new Map<string, { signature: string; form: HTMLFormElement }>();
  const cardKey = (request: InteractionRequestDto) => JSON.stringify([request.sessionId, request.id]);
  let renderedKey = "";
  let expiryTimer: number | undefined;

  function pending() {
    return (activeSessionState(state)?.pendingInteractions || []).filter((request) => request.source !== "extension");
  }

  function updateDisabled() {
    const requests = pending();
    for (const card of panel.querySelectorAll<HTMLFormElement>("[data-request-id]")) {
      const request = requests.find((value) => value.id === card.dataset.requestId);
      if (!request) continue;
      const expired = Boolean(request.expiresAt && Date.parse(request.expiresAt) <= Date.now());
      for (const button of card.querySelectorAll<HTMLButtonElement>("button")) button.disabled = state.wsDisconnected || expired || sending.has(request.id);
      const status = card.querySelector<HTMLElement>(".interactionStatus")!;
      status.textContent = errors.get(request.id) || (expired ? "Request expired. Waiting for the server to reconcile." : state.wsDisconnected ? "Reconnect to respond safely." : sending.has(request.id) ? "Response sent; waiting for confirmation…" : "");
    }
  }

  async function respond(request: InteractionRequestDto, response: InteractionResponseDto) {
    if (sending.has(request.id) || state.wsDisconnected) return;
    sending.add(request.id); errors.delete(request.id); updateDisabled();
    try {
      const res = await fetch("/api/interactions/respond", { method: "POST", headers: api.headers(), body: JSON.stringify(response) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `Response rejected (${res.status})`);
      // HTTP acceptance is not execution settlement. Reconcile the authoritative pending set.
      await refreshState();
    } catch (error) {
      errors.set(request.id, error instanceof Error ? error.message : String(error));
      await refreshState().catch(() => undefined);
    } finally {
      sending.delete(request.id); updateDisabled();
    }
  }

  function render() {
    const requests = pending();
    const key = JSON.stringify([state.currentSessionId, requests]);
    panel.hidden = requests.length === 0;
    if (!requests.length && expiryTimer !== undefined) { window.clearInterval(expiryTimer); expiryTimer = undefined; }
    if (requests.length && expiryTimer === undefined) expiryTimer = window.setInterval(updateDisabled, 1000);
    if (key === renderedKey) { updateDisabled(); return; }
    renderedKey = key;
    const wanted = new Set(requests.map(cardKey));
    for (const [id, card] of cards) {
      if (!wanted.has(id)) { card.form.remove(); cards.delete(id); }
    }
    for (const request of requests) {
      const id = cardKey(request);
      // Ignore wire-envelope fields: live requests and snapshot DTOs render identically.
      const signature = JSON.stringify([request.source, request.kind, request.title, request.body, request.questions, request.choices, request.payload, request.expiresAt]);
      const previous = cards.get(id);
      // A parallel request must not reset this request's answers, focus or disclosure.
      if (previous?.signature === signature) continue;
      const form = document.createElement("form");
      form.className = "interactionRequest"; form.dataset.requestId = request.id;
      form.addEventListener("submit", (event) => event.preventDefault());
      const title = document.createElement("h3");
      title.textContent = request.title || `${harnessName(activeSessionState(state))} needs a decision`;
      title.id = `request-${request.id}`;
      form.setAttribute("aria-labelledby", title.id);
      form.append(title);
      if (request.payload?.defaultToNo === true) {
        const caution = document.createElement("p"); caution.className = "interactionCaution";
        caution.textContent = "Native caution: review before allowing.";
        form.append(caution);
      }
      // Native tool input is display-only context, never a browser-editable policy.
      const input = request.questions?.length ? undefined : request.payload?.input;
      const bodyText = [
        request.body,
        input === undefined ? undefined : JSON.stringify(input, null, 2),
        typeof request.payload?.agentId === "string" ? `Native agent: ${request.payload.agentId}` : undefined,
        typeof request.payload?.blockedPath === "string" ? `Blocked path: ${request.payload.blockedPath}` : undefined,
        typeof request.payload?.permissionSuggestionSummary === "string" ? `Proposed permission changes: ${request.payload.permissionSuggestionSummary}` : undefined,
      ].filter(Boolean).join("\n");
      if (bodyText) {
        const preview = document.createElement("p"); preview.className = "interactionSummary";
        const firstLines = bodyText.split("\n").slice(0, 3).join("\n");
        preview.textContent = firstLines.length > 300 ? `${firstLines.slice(0, 300)}…` : firstLines;
        form.append(preview);
        const details = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = "Request details";
        const body = document.createElement("pre"); body.textContent = bodyText;
        details.append(summary, body); form.append(details);
      }
      const readers = new Map<string, () => string | string[]>();
      for (const question of request.questions || []) {
        const label = document.createElement("label"); label.className = "interactionQuestion";
        const name = document.createElement("span"); name.textContent = question.label; label.append(name);
        if (question.description) { const description = document.createElement("small"); description.textContent = question.description; label.append(description); }
        let select: HTMLSelectElement | undefined;
        let input: HTMLInputElement | undefined;
        if (question.options?.length) {
          select = document.createElement("select"); select.multiple = question.multiple === true;
          select.setAttribute("aria-label", question.label);
          if (!select.multiple) select.append(new Option("Choose an answer", ""));
          for (const option of question.options) select.append(new Option(option.label, option.id));
          label.append(select);
        }
        if (!select || question.allowFreeText) {
          input = document.createElement("input"); input.type = request.source === "secret" ? "password" : "text";
          input.autocomplete = "off"; input.setAttribute("aria-label", select ? `${question.label}: other answer` : question.label);
          if (select) input.placeholder = "Or enter another answer";
          label.append(input);
        }
        readers.set(question.id, () => {
          const values = Array.from(select?.selectedOptions || []).map((option) => option.value).filter(Boolean);
          if (input?.value.trim()) values.push(input.value.trim());
          return question.multiple ? values : values.at(-1) || "";
        });
        form.append(label);
      }
      const actions = document.createElement("div"); actions.className = "interactionChoices";
      for (const choice of request.choices || []) {
        const button = document.createElement("button"); button.type = "button";
        button.dataset.choiceId = choice.id; button.dataset.meaning = choice.meaning;
        button.textContent = choice.label;
        button.title = choice.meaning === "decline" ? "Decline without interrupting the execution" : choice.meaning === "cancel" ? "Cancel and interrupt the execution" : choice.scope ? `Scope: ${choice.scope}` : choice.label;
        if (choice.scope) { const scope = document.createElement("small"); scope.textContent = choice.scope; button.append(scope); }
        button.addEventListener("click", () => {
          const answers: NonNullable<InteractionResponseDto["answers"]> = {};
          if (choice.meaning === "submit" || choice.meaning === "accept") {
            for (const question of request.questions || []) {
              const answer = readers.get(question.id)!();
              if (question.required && answer.length === 0) { errors.set(request.id, `Answer required: ${question.label}`); updateDisabled(); return; }
              answers[question.id] = answer;
            }
          }
          void respond(request, { sessionId: request.sessionId, id: request.id, choiceID: choice.id, ...(Object.keys(answers).length ? { answers } : {}) });
        });
        actions.append(button);
      }
      if (!request.choices?.length) {
        const unsupported = document.createElement("p"); unsupported.textContent = "This request has no supported response here. Stop the execution to cancel safely."; form.append(unsupported);
      }
      const status = document.createElement("p"); status.className = "interactionStatus"; status.setAttribute("role", "status");
      form.append(actions, status);
      if (previous) previous.form.replaceWith(form);
      else panel.append(form);
      cards.set(id, { signature, form });
    }
    updateDisabled();
  }

  function request(value: InteractionRequestDto) {
    const view = state.sessionsById[value.sessionId] || { id: value.sessionId };
    view.pendingInteractions = [...(view.pendingInteractions || []).filter((item) => item.id !== value.id), value];
    state.sessionsById[value.sessionId] = view;
    render();
  }

  function resolved(sessionId: string, id: string) {
    const view = state.sessionsById[sessionId];
    if (view) view.pendingInteractions = view.pendingInteractions?.filter((request) => request.id !== id);
    sending.delete(id); errors.delete(id); render();
  }

  return { render, request, resolved };
}

export type Interactions = ReturnType<typeof createInteractions>;
