import type { MessageDto, MessagePartDto, TranscriptEventDto, TranscriptMessageDto } from "../../server/session/dto.js";
import type { MarkdownRenderer } from "../markdown/render.js";
import type { MessageList } from "./messageList.js";

/** One keyed rendering path for live native events and authoritative resumed history. */
export function createNativeTranscript(addMessage: MessageList["addMessage"], markdown: MarkdownRenderer, follow: () => void) {
  const messages = new Map<string, TranscriptMessageDto>();
  const cards = new Map<string, HTMLDivElement>();
  const nodes = new Map<string, HTMLElement>();
  function renderPart(part: MessagePartDto, node: HTMLElement, final: boolean) {
    node.dataset.partId = part.id;
    if (part.type === "text") {
      if (final) markdown.renderAssistantMarkdown(node, part.text);
      else node.textContent = part.text;
    } else if (part.type === "thinking") {
      const details = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "Thinking";
      const text = document.createElement("pre"); text.textContent = part.text;
      details.append(summary, text); node.replaceChildren(details);
    } else if (part.type === "toolCall") {
      const details = document.createElement("details"); details.open = part.status === "running";
      const summary = document.createElement("summary"); summary.textContent = `${part.toolName} · ${part.status}`;
      const args = document.createElement("pre"); args.textContent = JSON.stringify(part.args, null, 2);
      details.append(summary, args);
      for (const result of part.result?.parts || []) {
        const child = document.createElement("div"); renderPart(result, child, final); details.append(child);
      }
      node.replaceChildren(details);
    } else if (part.type === "image") {
      // Do not fetch arbitrary native paths or remote URLs. Only already-projected inline images.
      if (part.data && /^image\/(png|jpeg|gif|webp)$/.test(part.mediaType)) {
        const image = document.createElement("img"); image.src = `data:${part.mediaType};base64,${part.data}`;
        image.alt = part.alt || "Native image"; image.style.maxWidth = "100%"; node.replaceChildren(image);
      } else node.textContent = "[Native image reference]";
    } else node.textContent = "[Native content is not displayed]";
  }
  function render(message: TranscriptMessageDto) {
    let card = cards.get(message.id);
    if (!card?.isConnected) {
      const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
      card = addMessage(role, "", "nativeTranscript", [], { entryId: message.entryId || message.id, timestamp: message.timestamp ?? null });
      cards.set(message.id, card);
    }
    card.dataset.messageId = message.id;
    card.dataset.status = message.status;
    const body = card.querySelector<HTMLElement>(":scope > .body")!;
    const final = message.status !== "streaming";
    const children = message.parts.map((part) => {
      const key = `${message.id}:${part.id}`;
      let node = nodes.get(key);
      if (!node) { node = document.createElement("div"); nodes.set(key, node); }
      renderPart(part, node, final); return node;
    });
    if (body.children.length !== children.length || children.some((node, index) => body.children[index] !== node)) body.replaceChildren(...children);
    if (message.errorMessage) {
      const error = document.createElement("p"); error.className = "error"; error.textContent = message.errorMessage; body.append(error);
    }
    follow();
  }
  function append(message: MessageDto): boolean {
    if (!message.id || !message.parts || !message.status) return false;
    const canonical = structuredClone(message) as TranscriptMessageDto;
    messages.set(canonical.id, canonical); render(canonical); return true;
  }
  function event(event: TranscriptEventDto): boolean {
    if (event.type === "message_start" || event.type === "message_replace") return append(event.message);
    const message = messages.get(event.messageId);
    if (!message) return false;
    if (event.type === "message_part") message.parts[event.index] = structuredClone(event.part);
    else if (event.type === "message_delta") {
      let found = false;
      for (const part of message.parts) {
        if (part.id === event.partId && (part.type === "text" || part.type === "thinking")) { part.text += event.delta; found = true; break; }
        if (part.type === "toolCall") {
          const result = part.result?.parts.find((item) => item.id === event.partId && item.type === "text");
          if (result?.type === "text") { result.text += event.delta; found = true; break; }
        }
      }
      if (!found) return false;
    }
    render(message); return true;
  }
  return { append, event, clear() { messages.clear(); cards.clear(); nodes.clear(); } };
}
