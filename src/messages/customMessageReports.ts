import { createSessionRefChip, sessionRefsFromDetails, type SessionRef } from "../app/sessionRefs.js";
import type { MarkdownRenderer } from "../markdown/render.js";

export type CustomMessageReportInput = {
  text?: string;
  customType?: string;
  details?: unknown;
  isError?: boolean;
  raw?: unknown;
};

export type CustomMessageReportTone = "neutral" | "accent" | "warning" | "danger";
export type CustomMessageReportData = {
  text: string;
  customType: string;
  label: string;
  preview: string;
  tone: CustomMessageReportTone;
  refs: SessionRef[];
};

const maxLabelLength = 80;
const maxPreviewLength = 320;
const tones = new Set<CustomMessageReportTone>(["neutral", "accent", "warning", "danger"]);
let reportId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanPreview(value: string): string {
  return value
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/!?(?:\[([^\]]+)\])\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/(`{1,3}|\*\*|__|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxPreviewLength);
}

function typeLabel(type: string): string {
  const label = (type || "notification").replace(/[-_]+/g, " ").trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Optional, bounded presentation metadata supplied by any custom-message owner.
 * Core owns rendering; extensions own the meaning of labels, summaries and tone.
 */
export function customMessageReportData(message: CustomMessageReportInput): CustomMessageReportData | undefined {
  const text = String(message.text || "").trim();
  const raw = isRecord(message.raw) ? message.raw : {};
  const customType = message.customType || (typeof raw.customType === "string" ? raw.customType : "");
  const details = message.details ?? raw.details;
  const refs = sessionRefsFromDetails(details);
  if (!text && !refs.length) return undefined;

  const candidate = isRecord(details) && isRecord(details.presentation) ? details.presentation : undefined;
  const presentation = candidate?.kind === "expandable-report" ? candidate : undefined;
  const label = cleanText(presentation?.label, maxLabelLength) || typeLabel(customType);
  const preview = cleanText(presentation?.preview, maxPreviewLength) || cleanPreview(text);
  const requestedTone = presentation?.tone;
  const tone = typeof requestedTone === "string" && tones.has(requestedTone as CustomMessageReportTone)
    ? requestedTone as CustomMessageReportTone
    : "neutral";

  return { text, customType, label, preview, tone, refs };
}

export type RenderCustomMessageReportOptions = {
  markdown: Pick<MarkdownRenderer, "renderAssistantMarkdown">;
  openSession?: (sessionId: string) => void;
  entryId?: string;
  expanded?: boolean;
  onExpandedChange?: (entryId: string | undefined, expanded: boolean) => void;
};

/** Minimal-mode compact rendering for every displayable custom message. */
export function renderCustomMessageReport(
  message: CustomMessageReportInput,
  options: RenderCustomMessageReportOptions,
): HTMLDivElement | undefined {
  const data = customMessageReportData(message);
  if (!data) return undefined;
  const expanded = Boolean(options.expanded);
  const card = document.createElement("div");
  const typeClass = data.customType.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const error = message.isError || data.tone === "danger" || data.refs.some(ref => ref.status === "error");
  card.className = `message custom customCard customMessageReport customMessageReport--${data.tone}${expanded ? "" : " collapsed"}${typeClass ? ` custom--${typeClass}` : ""}${error ? " error" : ""}`;
  card.dataset.sessionRefs = data.refs.map(ref => ref.sessionId).join(",");
  if (options.entryId) card.dataset.notificationKey = options.entryId;

  const header = document.createElement("div");
  header.className = "customMessageReportHeader";
  const bodyId = `custom-message-report-${++reportId}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "customMessageReportToggle";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-controls", bodyId);
  toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} full ${data.label} report`);
  const label = document.createElement("strong");
  label.className = "customMessageReportLabel";
  label.textContent = data.label;
  label.title = data.label;
  const preview = document.createElement("span");
  preview.className = "customMessageReportPreview";
  preview.textContent = data.preview || "No report summary";
  toggle.append(label, preview);
  toggle.addEventListener("click", () => {
    const nowExpanded = !card.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(nowExpanded));
    toggle.setAttribute("aria-label", `${nowExpanded ? "Hide" : "Show"} full ${data.label} report`);
    options.onExpandedChange?.(options.entryId, nowExpanded);
  });
  header.append(toggle);
  card.append(header);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "body customMessageReportBody";
  if (data.text) options.markdown.renderAssistantMarkdown(body, data.text);
  if (data.refs.length) {
    const links = document.createElement("nav");
    links.className = "customMessageReportLinks";
    links.setAttribute("aria-label", "Referenced sessions");
    data.refs.forEach(ref => {
      const link = createSessionRefChip(ref, { className: `customMessageReportSessionLink${ref.status === "error" ? " status-error" : ref.status === "aborted" ? " status-aborted" : ""}`, openSession: options.openSession });
      link.textContent = data.refs.length === 1 ? "Open session ↗" : `Open ${ref.name || ref.sessionId.slice(-8)} ↗`;
      links.append(link);
    });
    body.prepend(links);
  }
  card.append(body);
  return card;
}
