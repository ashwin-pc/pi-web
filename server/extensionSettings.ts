/**
 * Extension settings — canonical descriptor model + pure validation.
 *
 * Shared backbone for the generic pi-web extension-settings platform. Kept pure
 * (no node/browser deps) so both the server (validation before persist) and the
 * client (form rendering) can rely on the same contract. See
 * `.pi/web/artifacts/worker-model-selection-plan.md` (Amendment 3).
 */

import type { JsonObject } from "./settings.js";

export type FieldType = "toggle" | "text" | "textarea" | "number" | "select" | "list";

export type SelectOption = { value: string; label?: string };

export type FieldDescriptor = {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  // number
  min?: number;
  max?: number;
  // text / textarea
  minLength?: number;
  maxLength?: number;
  pattern?: string; // regex source, anchored implicitly by test()
  // select
  options?: SelectOption[];
  optionsSource?: "models"; // dynamic; allowed set supplied at validation time
  optionsFromField?: string; // "<listFieldKey>.<itemFieldKey>" cross-field reference
  // list (repeater)
  itemFields?: FieldDescriptor[];
  minItems?: number;
  maxItems?: number;
  // per-column case-insensitive uniqueness inside a list
  uniqueCaseInsensitive?: boolean;
};

export type SettingsSchema = {
  id: string; // namespaced owner id
  title: string;
  schemaVersion: number;
  fields: FieldDescriptor[];
};

export type ValidationError = { path: string; message: string };

export type ValidateContext = {
  /** Allowed values for `optionsSource: "models"` fields (canonical model tokens). */
  modelOptions?: ReadonlySet<string>;
};

export type ValidateResult = { values: JsonObject; errors: ValidationError[] };

/** Stable, function-free serialization for schema identity (R2.4). */
export function canonicalSchemaKey(schema: SettingsSchema): string {
  return stableStringify({
    id: schema.id,
    schemaVersion: schema.schemaVersion,
    title: schema.title,
    fields: schema.fields,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

let rowSeq = 0;
function newRowId(): string {
  rowSeq = (rowSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `r${Date.now().toString(36)}${rowSeq.toString(36)}`;
}

/** Default value for a single field. */
function fieldDefault(field: FieldDescriptor): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "toggle":
      return false;
    case "number":
      return field.min ?? 0;
    case "list":
      return [];
    default:
      return "";
  }
}

/** Fully-defaulted values object for a schema (used for empty state / reset). */
export function defaultSettingsValues(schema: SettingsSchema): JsonObject {
  const out: JsonObject = {};
  for (const field of schema.fields) out[field.key] = fieldDefault(field);
  return out;
}

function coerceScalar(field: FieldDescriptor, raw: unknown, path: string, errors: ValidationError[]): unknown {
  switch (field.type) {
    case "toggle":
      return typeof raw === "boolean" ? raw : Boolean(raw);
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        errors.push({ path, message: `${field.label} must be a number` });
        return typeof field.default === "number" ? field.default : (field.min ?? 0);
      }
      if (field.min !== undefined && n < field.min) errors.push({ path, message: `${field.label} must be ≥ ${field.min}` });
      if (field.max !== undefined && n > field.max) errors.push({ path, message: `${field.label} must be ≤ ${field.max}` });
      return n;
    }
    case "text":
    case "textarea":
    case "select": {
      const s = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
      const trimmed = field.type === "select" ? s.trim() : s;
      if (field.required && !trimmed.trim()) errors.push({ path, message: `${field.label} is required` });
      if (field.minLength !== undefined && trimmed.length < field.minLength) {
        errors.push({ path, message: `${field.label} must be ≥ ${field.minLength} chars` });
      }
      if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
        errors.push({ path, message: `${field.label} must be ≤ ${field.maxLength} chars` });
      }
      if (field.pattern && trimmed) {
        try {
          if (!new RegExp(field.pattern).test(trimmed)) errors.push({ path, message: `${field.label} is invalid` });
        } catch {
          /* invalid pattern in descriptor — ignore */
        }
      }
      return trimmed;
    }
    default:
      return raw;
  }
}

/** Resolve the allowed option set for a select field, if constrained. */
function selectAllowed(
  field: FieldDescriptor,
  values: JsonObject,
  ctx: ValidateContext | undefined,
): ReadonlySet<string> | undefined {
  if (field.options) return new Set(field.options.map((o) => o.value));
  if (field.optionsSource === "models") return ctx?.modelOptions;
  if (field.optionsFromField) {
    const [listKey, itemKey] = field.optionsFromField.split(".");
    const list = values[listKey];
    if (!Array.isArray(list) || !itemKey) return new Set();
    const set = new Set<string>();
    for (const row of list) {
      if (isRecord(row) && typeof row[itemKey] === "string") set.add(row[itemKey] as string);
    }
    return set;
  }
  return undefined;
}

/**
 * Validate + coerce raw input against a schema. Never throws; returns coerced
 * `values` (safe to persist even if `errors` is non-empty — the UI decides
 * whether to block) plus accessible `{ path, message }` errors.
 *
 * Two-pass for lists: coerce all fields first (so `optionsFromField` can see the
 * list), then validate cross-field references.
 */
export function validateSettingsValues(
  schema: SettingsSchema,
  input: unknown,
  ctx?: ValidateContext,
): ValidateResult {
  const errors: ValidationError[] = [];
  const src = isRecord(input) ? input : {};
  const values: JsonObject = {};

  // Pass 1: coerce every field to its shape.
  for (const field of schema.fields) {
    const raw = src[field.key];
    if (field.type === "list") {
      values[field.key] = coerceList(field, raw, field.key, errors);
    } else if (field.type === "select") {
      values[field.key] = coerceScalar(field, raw, field.key, errors); // option membership checked in pass 2
    } else {
      values[field.key] = coerceScalar(field, raw, field.key, errors);
    }
  }

  // Pass 2: option membership (incl. cross-field), now that lists exist.
  for (const field of schema.fields) {
    if (field.type === "select") {
      const allowed = selectAllowed(field, values, ctx);
      const v = values[field.key];
      if (allowed && typeof v === "string" && v && !allowed.has(v)) {
        errors.push({ path: field.key, message: `${field.label} references an unavailable value` });
      }
    } else if (field.type === "list" && field.itemFields) {
      const list = values[field.key] as JsonObject[];
      list.forEach((row, i) => {
        for (const item of field.itemFields!) {
          if (item.type !== "select") continue;
          const allowed = selectAllowed(item, values, ctx);
          const v = row[item.key];
          if (allowed && typeof v === "string" && v && !allowed.has(v)) {
            errors.push({ path: `${field.key}[${i}].${item.key}`, message: `${item.label} references an unavailable value` });
          }
        }
      });
    }
  }

  return { values, errors };
}

function coerceList(field: FieldDescriptor, raw: unknown, path: string, errors: ValidationError[]): JsonObject[] {
  const arr = Array.isArray(raw) ? raw : [];
  const itemFields = field.itemFields ?? [];
  const rows: JsonObject[] = arr.map((rawRow, i) => {
    const row: JsonObject = {};
    const rowSrc = isRecord(rawRow) ? rawRow : {};
    // preserve/generate stable __id
    row.__id = typeof rowSrc.__id === "string" && rowSrc.__id ? rowSrc.__id : newRowId();
    for (const item of itemFields) {
      row[item.key] = item.type === "list"
        ? coerceList(item, rowSrc[item.key], `${path}[${i}].${item.key}`, errors)
        : coerceScalar(item, rowSrc[item.key], `${path}[${i}].${item.key}`, errors);
    }
    return row;
  });

  if (field.minItems !== undefined && rows.length < field.minItems) {
    errors.push({ path, message: `${field.label} needs at least ${field.minItems}` });
  }
  if (field.maxItems !== undefined && rows.length > field.maxItems) {
    errors.push({ path, message: `${field.label} allows at most ${field.maxItems}` });
  }

  // per-column case-insensitive uniqueness
  for (const item of itemFields) {
    if (!item.uniqueCaseInsensitive) continue;
    const seen = new Map<string, number>();
    rows.forEach((row, i) => {
      const v = row[item.key];
      if (typeof v !== "string" || !v.trim()) return;
      const norm = v.trim().toLowerCase();
      if (seen.has(norm)) {
        errors.push({ path: `${path}[${i}].${item.key}`, message: `${item.label} must be unique` });
      } else {
        seen.set(norm, i);
      }
    });
  }

  return rows;
}
