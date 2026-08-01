import type { ApiClient } from "../app/api.js";
import type {
  AppState,
  WebFieldDescriptor,
  WebSelectOption,
  WebSettingsSchema,
  WebSettingsValidationError,
} from "../app/types.js";

type ModelOption = { provider: string; id: string; name?: string };

type Values = Record<string, unknown>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props as Record<string, unknown>;
  if (className) node.className = String(className);
  Object.assign(node, rest);
  for (const child of children) node.append(typeof child === "string" ? document.createTextNode(child) : child);
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldDefault(field: WebFieldDescriptor): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "toggle": return false;
    case "number": return field.min ?? 0;
    case "list": return [];
    default: return "";
  }
}

function defaultsFor(schema: WebSettingsSchema): Values {
  const out: Values = {};
  for (const f of schema.fields) out[f.key] = fieldDefault(f);
  return out;
}

let rowSeq = 0;
function newRowId(): string {
  rowSeq += 1;
  return `r${Date.now().toString(36)}${rowSeq.toString(36)}`;
}

function newRow(itemFields: WebFieldDescriptor[]): Values {
  const row: Values = { __id: newRowId() };
  for (const f of itemFields) row[f.key] = fieldDefault(f);
  return row;
}

export type ExtensionSettingsController = {
  render: () => void;
};

export function createExtensionSettings(options: {
  container: HTMLElement;
  api: ApiClient;
  state: AppState;
  fetchModels: () => Promise<ModelOption[]>;
  setStatus: (message: string, isError?: boolean) => void;
  notifyError: (message: string) => void;
}): ExtensionSettingsController {
  const { container, api, state, fetchModels, setStatus, notifyError } = options;

  // Per-owner editable draft + last-seen errors, keyed by owner id.
  const drafts = new Map<string, Values>();
  const errors = new Map<string, WebSettingsValidationError[]>();
  const openRows = new Set<string>();
  let modelOptions: WebSelectOption[] | undefined;
  let modelsLoading = false;

  function storedFor(id: string) {
    return state.settings.extensions?.[id];
  }

  function ensureDraft(schema: WebSettingsSchema): Values {
    let draft = drafts.get(schema.id);
    if (!draft) {
      const stored = storedFor(schema.id)?.values;
      draft = isRecord(stored) ? structuredClone(stored) : defaultsFor(schema);
      drafts.set(schema.id, draft);
    }
    return draft;
  }

  function ensureModels() {
    if (modelOptions || modelsLoading) return;
    modelsLoading = true;
    fetchModels().then((models) => {
      modelOptions = models.map((m) => ({ value: `${m.provider}:${m.id}`, label: m.name ? `${m.name}` : `${m.provider}/${m.id}` }));
      modelsLoading = false;
      render();
    }).catch(() => { modelsLoading = false; });
  }

  function optionsForSelect(field: WebFieldDescriptor, ownerDraft: Values): WebSelectOption[] {
    if (field.options) return field.options;
    if (field.optionsSource === "models") { ensureModels(); return modelOptions ?? []; }
    if (field.optionsFromField) {
      const [listKey, itemKey] = field.optionsFromField.split(".");
      const list = ownerDraft[listKey];
      if (!Array.isArray(list) || !itemKey) return [];
      return list
        .filter((r): r is Values => isRecord(r) && typeof r[itemKey] === "string" && Boolean((r[itemKey] as string).trim()))
        .map((r) => ({ value: r[itemKey] as string }));
    }
    return [];
  }

  function errorAt(id: string, path: string): string | undefined {
    return errors.get(id)?.find((e) => e.path === path)?.message;
  }

  function fieldRow(labelText: string, control: HTMLElement, descr: string | undefined, errText: string | undefined): HTMLElement {
    const label = el("label", { class: "settingsField extSettingsField" });
    label.append(el("span", {}, [labelText]));
    label.append(control);
    if (descr) label.append(el("span", { class: "settingsHint extSettingsHint" }, [descr]));
    if (errText) {
      const err = el("span", { class: "extSettingsError" }, [errText]);
      err.setAttribute("role", "alert");
      const ctrlId = control.id || `ext-${Math.random().toString(36).slice(2)}`;
      control.id = ctrlId;
      err.id = `${ctrlId}-err`;
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", err.id);
      label.append(err);
    }
    return label;
  }

  // Render one scalar/select control bound to obj[field.key].
  function scalarControl(id: string, field: WebFieldDescriptor, obj: Values, ownerDraft: Values, onStructural: () => void): HTMLElement {
    const value = obj[field.key];
    if (field.type === "toggle") {
      const input = el("input", { type: "checkbox", checked: Boolean(value) });
      input.addEventListener("change", () => { obj[field.key] = input.checked; });
      const wrap = el("span", { class: "extSettingsToggle" }, [input]);
      return wrap;
    }
    if (field.type === "select") {
      const select = el("select");
      const opts = optionsForSelect(field, ownerDraft);
      select.append(el("option", { value: "" }, [field.required ? "Select…" : "— none —"]));
      for (const o of opts) select.append(el("option", { value: o.value }, [o.label ?? o.value]));
      select.value = typeof value === "string" ? value : "";
      // keep an unavailable stored value visible
      if (typeof value === "string" && value && select.value !== value) {
        select.append(el("option", { value }, [`${value} (unavailable)`]));
        select.value = value;
      }
      select.addEventListener("change", () => { obj[field.key] = select.value; });
      return select;
    }
    if (field.type === "textarea") {
      const ta = el("textarea", { value: typeof value === "string" ? value : "", rows: 3 });
      if (field.maxLength) ta.maxLength = field.maxLength;
      ta.addEventListener("input", () => { obj[field.key] = ta.value; });
      return ta;
    }
    if (field.type === "number") {
      const input = el("input", { type: "number", value: value === undefined ? "" : String(value) });
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      input.addEventListener("input", () => { obj[field.key] = input.value === "" ? undefined : Number(input.value); });
      return input;
    }
    // text
    const input = el("input", { type: "text", value: typeof value === "string" ? value : "" });
    if (field.maxLength) input.maxLength = field.maxLength;
    // a text field may feed a select's optionsFromField → re-render on commit
    input.addEventListener("input", () => { obj[field.key] = input.value; });
    input.addEventListener("change", () => { obj[field.key] = input.value; onStructural(); });
    return input;
  }

  // A default-ref is a top-level select whose options come from a list column
  // (optionsFromField). We render it as a per-row star toggle instead of a
  // separate dropdown, and skip the standalone select.
  type DefaultRef = { selectKey: string; itemKey: string };

  function listControl(schema: WebSettingsSchema, field: WebFieldDescriptor, ownerDraft: Values, defaultRef?: DefaultRef): HTMLElement {
    const wrap = el("div", { class: "extSettingsList" });
    const rows = (Array.isArray(ownerDraft[field.key]) ? ownerDraft[field.key] : []) as Values[];
    const itemFields = field.itemFields ?? [];
    const rerender = () => render();
    const titleField = itemFields.find((f) => f.type === "text");
    const metaField = itemFields.find((f) => f.type === "select");
    const defaultRowId = defaultRef
      ? rows.find((r) => isRecord(r) && r[defaultRef.itemKey] === ownerDraft[defaultRef.selectKey] && r[defaultRef.itemKey] !== "")?.__id
      : undefined;

    rows.forEach((row, i) => {
      if (!isRecord(row)) return;
      if (typeof row.__id !== "string") row.__id = newRowId();
      const rid = row.__id as string;
      const open = openRows.has(rid);
      const hasError = itemFields.some((f) => errorAt(schema.id, `${field.key}[${i}].${f.key}`));
      const isDefault = Boolean(defaultRef) && ownerDraft[defaultRef!.selectKey] === row[defaultRef!.itemKey] && row[defaultRef!.itemKey] !== "";
      const rowEl = el("div", { class: `extAccRow${open ? " open" : ""}${hasError ? " hasError" : ""}` });

      const head = el("div", { class: "extAccHead" });
      head.setAttribute("role", "button");
      head.setAttribute("aria-expanded", String(open));
      if (defaultRef) {
        const star = el("button", { type: "button", class: `extAccStar${isDefault ? " on" : ""}`, title: isDefault ? "Default category" : "Make default" }, [isDefault ? "★" : "☆"]);
        star.setAttribute("aria-pressed", String(isDefault));
        star.addEventListener("click", (e) => { e.stopPropagation(); ownerDraft[defaultRef.selectKey] = row[defaultRef.itemKey]; rerender(); });
        head.append(star);
      }
      const titleText = String((titleField && row[titleField.key]) || "").trim() || "(unnamed)";
      head.append(el("span", { class: "extAccName" }, [titleText]));
      if (metaField) {
        const val = row[metaField.key];
        const opts = optionsForSelect(metaField, ownerDraft);
        const label = typeof val === "string" && val ? (opts.find((o) => o.value === val)?.label ?? val) : "—";
        head.append(el("span", { class: "extAccMeta" }, [label]));
      }
      head.append(el("span", { class: "extAccChev" }, ["⌄"]));
      head.addEventListener("click", () => { if (open) openRows.delete(rid); else openRows.add(rid); rerender(); });
      rowEl.append(head);

      if (open) {
        const body = el("div", { class: "extAccBody" });
        for (const item of itemFields) {
          const ctrl = scalarControl(schema.id, item, row, ownerDraft, rerender);
          // rename-follows-default: if this row is the default, keep the ref in sync live.
          if (defaultRef && item.key === defaultRef.itemKey && rid === defaultRowId) {
            ctrl.addEventListener("input", () => { ownerDraft[defaultRef.selectKey] = row[item.key]; });
          }
          body.append(fieldRow(item.label, ctrl, item.description, errorAt(schema.id, `${field.key}[${i}].${item.key}`)));
        }
        const actions = el("div", { class: "extAccRowActions" });
        if (defaultRef) {
          const mk = el("button", { type: "button", class: "extSettingsLink", disabled: isDefault }, [isDefault ? "★ Default" : "☆ Make default"]);
          mk.addEventListener("click", () => { ownerDraft[defaultRef.selectKey] = row[defaultRef.itemKey]; rerender(); });
          actions.append(mk);
        }
        const remove = el("button", { type: "button", class: "extSettingsLink danger" }, ["Delete"]);
        remove.addEventListener("click", () => {
          if (defaultRef && ownerDraft[defaultRef.selectKey] === row[defaultRef.itemKey]) ownerDraft[defaultRef.selectKey] = "";
          rows.splice(i, 1); openRows.delete(rid); rerender();
        });
        actions.append(remove);
        body.append(actions);
        rowEl.append(body);
      }
      wrap.append(rowEl);
    });

    const listErr = errorAt(schema.id, field.key);
    if (listErr) {
      const e = el("span", { class: "extSettingsError" }, [listErr]);
      e.setAttribute("role", "alert");
      wrap.append(e);
    }

    const atMax = field.maxItems !== undefined && rows.length >= field.maxItems;
    const singular = field.label.replace(/ies$/i, "y").replace(/s$/i, "");
    const add = el("button", { type: "button", class: "extSettingsAdd", disabled: atMax }, [`+ Add ${singular.toLowerCase()}`]);
    add.addEventListener("click", () => {
      const r = newRow(itemFields);
      rows.push(r);
      ownerDraft[field.key] = rows;
      openRows.add(r.__id as string); // open the new row for immediate editing
      rerender();
    });
    wrap.append(add);
    return wrap;
  }

  async function save(schema: WebSettingsSchema) {
    const draft = ensureDraft(schema);
    const expectedRevision = storedFor(schema.id)?.revision;
    setStatus("Saving…");
    try {
      const res = await fetch(`/api/settings/extensions/${encodeURIComponent(schema.id)}`, {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify({ values: draft, expectedRevision }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && Array.isArray(data.errors)) {
        errors.set(schema.id, data.errors);
        render();
        setStatus(`Fix ${data.errors.length} field${data.errors.length === 1 ? "" : "s"}`, true);
        return;
      }
      if (res.status === 409) {
        errors.delete(schema.id);
        drafts.delete(schema.id); // re-sync from server on next render
        setStatus("Changed elsewhere — reloaded latest", true);
        return;
      }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      errors.delete(schema.id);
      setStatus("Saved");
      // state.settings gets refreshed via the settings_updated broadcast → applySettings
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(msg, true);
      notifyError(msg);
    }
  }

  async function reset(schema: WebSettingsSchema) {
    setStatus("Resetting…");
    try {
      const res = await fetch(`/api/settings/extensions/${encodeURIComponent(schema.id)}/reset`, { method: "POST", headers: api.headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      drafts.delete(schema.id);
      errors.delete(schema.id);
      setStatus("Reset");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(msg, true);
      notifyError(msg);
    }
  }

  function renderSchema(schema: WebSettingsSchema): HTMLElement {
    const draft = ensureDraft(schema);
    const section = el("section", { class: "settingsSection extSettingsSection" });
    section.append(el("h3", {}, [schema.title]));

    // Detect default-ref selects (rendered as per-row stars on their list).
    const defaultRefByList = new Map<string, DefaultRef>();
    const skipSelectKeys = new Set<string>();
    for (const f of schema.fields) {
      if (f.type === "select" && f.optionsFromField) {
        const [lk, ik] = f.optionsFromField.split(".");
        if (lk && ik) { defaultRefByList.set(lk, { selectKey: f.key, itemKey: ik }); skipSelectKeys.add(f.key); }
      }
    }

    for (const field of schema.fields) {
      if (field.type === "select" && skipSelectKeys.has(field.key)) continue; // shown as row stars
      if (field.type === "list") {
        const group = el("div", { class: "extSettingsFieldGroup" });
        group.append(el("span", { class: "extSettingsGroupLabel" }, [field.label]));
        if (field.description) group.append(el("span", { class: "settingsHint extSettingsHint" }, [field.description]));
        group.append(listControl(schema, field, draft, defaultRefByList.get(field.key)));
        section.append(group);
      } else {
        const ctrl = scalarControl(schema.id, field, draft, draft, () => render());
        section.append(fieldRow(field.label, ctrl, field.description, errorAt(schema.id, field.key)));
      }
    }
    const actions = el("div", { class: "settingsActions" });
    const saveBtn = el("button", { type: "button" }, ["Save"]);
    saveBtn.addEventListener("click", () => void save(schema));
    const resetBtn = el("button", { type: "button" }, ["Reset"]);
    resetBtn.addEventListener("click", () => void reset(schema));
    actions.append(saveBtn, resetBtn);
    section.append(actions);
    return section;
  }

  // "Data retained" card for owners with stored values but no live schema.
  function renderRetained(id: string, valueCount: number): HTMLElement {
    const section = el("section", { class: "settingsSection extSettingsSection extSettingsRetained" });
    section.append(el("h3", {}, [id]));
    section.append(el("p", { class: "settingsHint" }, [`Extension not loaded — ${valueCount} value${valueCount === 1 ? "" : "s"} retained. Load the extension to edit.`]));
    return section;
  }

  function render() {
    const schemas = state.webSettingsSchemas ?? [];
    const registeredIds = new Set(schemas.map((s) => s.id));
    container.replaceChildren();

    for (const schema of schemas) container.append(renderSchema(schema));

    const stored = state.settings.extensions ?? {};
    for (const [id, rec] of Object.entries(stored)) {
      if (registeredIds.has(id)) continue;
      container.append(renderRetained(id, Object.keys(rec?.values ?? {}).length));
    }

    // Drop drafts for owners no longer present so a fresh open re-syncs.
    for (const id of Array.from(drafts.keys())) {
      if (!registeredIds.has(id)) drafts.delete(id);
    }
  }

  return { render };
}
