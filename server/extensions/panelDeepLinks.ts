import type { PiWebPanel } from "../../src/extensions.js";
import { HttpError } from "../shared/httpError.js";

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

export function cleanPanelDeepLinks(value: PiWebPanel["deepLinks"]) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !Array.isArray(value.allowedKeys)
    || value.allowedKeys.length === 0 || value.allowedKeys.length > 32) {
    throw new TypeError("panel.deepLinks.allowedKeys must contain between 1 and 32 keys");
  }
  const allowedKeys = [...new Set(value.allowedKeys.map((key) => {
    const cleaned = cleanText(key, 64);
    if (!cleaned || !/^[A-Za-z0-9_-]+$/.test(cleaned)) {
      throw new TypeError("panel.deepLinks keys must use letters, numbers, _ or -");
    }
    return cleaned;
  }))];
  const allowed = new Set(allowedKeys);
  if (value.requiredKeys !== undefined && !Array.isArray(value.requiredKeys)) {
    throw new TypeError("panel.deepLinks.requiredKeys must be an array");
  }
  const requiredKeys = [...new Set((value.requiredKeys || []).map((key) => {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("panel.deepLinks.requiredKeys must be declared in allowedKeys");
    }
    return key;
  }))];
  return {
    allowedKeys,
    ...(requiredKeys.length ? { requiredKeys } : {}),
    hasDescribe: typeof value.describe === "function",
  };
}

export function cleanPanelDeepLinkPayload(panel: PiWebPanel, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("Invalid panel deep-link payload", 400);
  }
  const raw = Object.entries(value as Record<string, unknown>);
  if (raw.length > 64) throw new HttpError("Invalid panel deep-link payload", 400);
  const schema = cleanPanelDeepLinks(panel.deepLinks);
  const allowed = schema ? new Set(schema.allowedKeys) : undefined;
  const payload: Record<string, string> = {};
  for (const [key, item] of raw) {
    if (allowed && !allowed.has(key)) continue;
    if (key.length > 64 || typeof item !== "string" || item.length > 2_000) {
      throw new HttpError("Invalid panel deep-link payload", 400);
    }
    payload[key] = item;
  }
  if (schema?.requiredKeys?.some((key) => !payload[key])) {
    throw new HttpError("Invalid panel deep-link payload", 400);
  }
  return payload;
}
