import { describe, expect, it } from "vitest";
import {
  canonicalSchemaKey,
  defaultSettingsValues,
  validateSettingsValues,
  type SettingsSchema,
} from "../server/extensionSettings.js";

const models = new Set(["anthropic:fast-1", "anthropic:smart-1"]);

const schema: SettingsSchema = {
  id: "demo-ext.categories",
  title: "Categories",
  schemaVersion: 1,
  fields: [
    {
      key: "categories",
      type: "list",
      label: "Categories",
      minItems: 0,
      maxItems: 3,
      itemFields: [
        { key: "name", type: "text", label: "Name", required: true, maxLength: 24, uniqueCaseInsensitive: true },
        { key: "model", type: "select", label: "Model", optionsSource: "models", required: true },
        { key: "description", type: "textarea", label: "When to use", maxLength: 400 },
      ],
    },
    { key: "defaultCategory", type: "select", label: "Default", optionsFromField: "categories.name" },
  ],
};

function withCategories(names: Array<{ name: string; model?: string }>, defaultCategory = "") {
  return {
    categories: names.map(({ name, model }) => ({ name, model: model ?? "anthropic:fast-1", description: "" })),
    defaultCategory,
  };
}

describe("extension settings descriptors", () => {
  it("produces a stable canonical key that ignores callbacks", () => {
    const key = canonicalSchemaKey(schema);
    expect(canonicalSchemaKey(JSON.parse(JSON.stringify(schema)))).toBe(key);
    // Functions are not part of schema identity (R2.4).
    expect(canonicalSchemaKey({ ...schema, migrate: () => ({}), onChange: () => undefined } as SettingsSchema)).toBe(key);
    expect(canonicalSchemaKey({ ...schema, schemaVersion: 2 })).not.toBe(key);
  });

  it("derives defaults per field type", () => {
    expect(defaultSettingsValues(schema)).toEqual({ categories: [], defaultCategory: "" });
  });
});

describe("extension settings validation", () => {
  it("accepts a valid reference with zero errors and assigns stable row ids", () => {
    const first = validateSettingsValues(schema, withCategories([{ name: "Fast" }, { name: "Smart", model: "anthropic:smart-1" }], "Fast"), { modelOptions: models });
    expect(first.errors).toEqual([]);

    const rowId = (first.values.categories as Array<Record<string, unknown>>)[0].__id;
    expect(typeof rowId).toBe("string");

    // Re-validating preserves row identity so cross-field references survive edits.
    const again = validateSettingsValues(schema, first.values, { modelOptions: models });
    expect((again.values.categories as Array<Record<string, unknown>>)[0].__id).toBe(rowId);
  });

  it("flags a model that the registry does not offer", () => {
    const result = validateSettingsValues(schema, withCategories([{ name: "Ghost", model: "openai:missing" }], "Ghost"), { modelOptions: models });
    expect(result.errors.map((error) => error.path)).toContain("categories[0].model");
  });

  it("flags a default that references a missing category", () => {
    const result = validateSettingsValues(schema, withCategories([{ name: "Fast" }], "Nope"), { modelOptions: models });
    expect(result.errors.map((error) => error.path)).toContain("defaultCategory");
  });

  it("reports a dangling reference when the referenced row is renamed without updating it", () => {
    const initial = validateSettingsValues(schema, withCategories([{ name: "Fast" }], "Fast"), { modelOptions: models });
    expect(initial.errors).toEqual([]);

    const renamed = structuredClone(initial.values);
    (renamed.categories as Array<Record<string, unknown>>)[0].name = "Quick";
    const result = validateSettingsValues(schema, renamed, { modelOptions: models });

    expect(result.values.defaultCategory).toBe("Fast");
    expect(result.errors).toContainEqual({
      path: "defaultCategory",
      message: "Default references an unavailable value",
    });
  });

  it("reports a dangling reference when the referenced row is deleted without clearing it", () => {
    const initial = validateSettingsValues(schema, withCategories([{ name: "Fast" }, { name: "Smart" }], "Fast"), { modelOptions: models });
    expect(initial.errors).toEqual([]);

    const deleted = structuredClone(initial.values);
    (deleted.categories as Array<Record<string, unknown>>).splice(0, 1);
    const result = validateSettingsValues(schema, deleted, { modelOptions: models });

    expect(result.values.defaultCategory).toBe("Fast");
    expect(result.errors).toContainEqual({
      path: "defaultCategory",
      message: "Default references an unavailable value",
    });
  });

  it("rejects referenced-column values that differ only in case", () => {
    const result = validateSettingsValues(schema, withCategories([{ name: "Fast" }, { name: "fast" }], "Fast"), { modelOptions: models });
    expect(result.errors).toContainEqual({ path: "categories[1].name", message: "Name must be unique" });
  });

  it("requires non-empty required text and honours item bounds", () => {
    const blank = validateSettingsValues(schema, withCategories([{ name: "   " }]), { modelOptions: models });
    expect(blank.errors.map((error) => error.path)).toContain("categories[0].name");

    const tooMany = validateSettingsValues(
      schema,
      withCategories([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }], "a"),
      { modelOptions: models },
    );
    expect(tooMany.errors.map((error) => error.path)).toContain("categories");
  });

  it("skips patterns for values rejected by a declared scalar bound", () => {
    let patternReads = 0;
    const field = {
      key: "value", type: "text", label: "Value", maxLength: 4,
      get pattern() { patternReads += 1; return "^(a+)+$"; },
    } as SettingsSchema["fields"][number];
    const boundedSchema: SettingsSchema = {
      id: "demo-ext.bounded-pattern",
      title: "Bounded pattern",
      schemaVersion: 1,
      fields: [field],
    };

    const declared = validateSettingsValues(boundedSchema, { value: "aaaaa!" });
    expect(declared.errors).toContainEqual({ path: "value", message: "Value must be ≤ 4 chars" });
    expect(declared.values.value).toBe("aaaaa!");
    expect(patternReads).toBe(0);
  });

  it("preserves values allowed by declared bounds and the owner persistence budget", () => {
    const declaredSchema: SettingsSchema = {
      id: "demo-ext.long-declared",
      title: "Long declared value",
      schemaVersion: 1,
      fields: [{ key: "value", type: "text", label: "Value", maxLength: 20_000 }],
    };
    const declaredValue = "a".repeat(10_000);
    expect(validateSettingsValues(declaredSchema, { value: declaredValue })).toEqual({
      values: { value: declaredValue },
      errors: [],
    });

    const uncappedSchema: SettingsSchema = {
      id: "demo-ext.long-uncapped",
      title: "Long uncapped value",
      schemaVersion: 1,
      fields: [{ key: "value", type: "textarea", label: "Value" }],
    };
    const uncappedValue = "b".repeat(32_000);
    expect(validateSettingsValues(uncappedSchema, { value: uncappedValue })).toEqual({
      values: { value: uncappedValue },
      errors: [],
    });
  });

  it("checks patterns normally for inputs within scalar bounds", () => {
    const patternSchema: SettingsSchema = {
      id: "demo-ext.pattern",
      title: "Pattern",
      schemaVersion: 1,
      fields: [{ key: "value", type: "text", label: "Value", maxLength: 8, pattern: "^a+$" }],
    };
    expect(validateSettingsValues(patternSchema, { value: "aaaa" }).errors).toEqual([]);
    expect(validateSettingsValues(patternSchema, { value: "aaab" }).errors).toContainEqual({
      path: "value",
      message: "Value is invalid",
    });
  });

  it("preserves uncapped lists and skips row patterns after a declared list bound fails", () => {
    let patternReads = 0;
    const listSchema: SettingsSchema = {
      id: "demo-ext.bounded-list",
      title: "Bounded list",
      schemaVersion: 1,
      fields: [{
        key: "rows", type: "list", label: "Rows",
        itemFields: [{
          key: "value", type: "text", label: "Value",
          get pattern() { patternReads += 1; return "^(o+)+$"; },
        }],
      }],
    };
    const input = Array.from({ length: 1025 }, () => ({ value: "ooo" }));
    const uncapped = validateSettingsValues(listSchema, { rows: input });
    expect(uncapped.errors).toEqual([]);
    expect((uncapped.values.rows as unknown[])).toHaveLength(1025);
    expect(patternReads).toBe(1025);

    listSchema.fields[0].maxItems = 2;
    patternReads = 0;
    const declared = validateSettingsValues(listSchema, { rows: input.slice(0, 3) });
    expect(declared.errors).toContainEqual({ path: "rows", message: "Rows allows at most 2" });
    expect((declared.values.rows as unknown[])).toHaveLength(3);
    expect(patternReads).toBe(0);
  });

  it("accepts cleared optional numbers and keeps their persisted round trip stable", () => {
    const numberSchema: SettingsSchema = {
      id: "demo-ext.numbers",
      title: "Numbers",
      schemaVersion: 1,
      fields: [
        { key: "optional", type: "number", label: "Optional" },
        { key: "withDefault", type: "number", label: "With default", default: 7 },
      ],
    };

    for (const empty of [undefined, ""]) {
      const first = validateSettingsValues(numberSchema, { optional: empty, withDefault: empty });
      expect(first.errors).toEqual([]);
      expect(first.values).toEqual({ optional: undefined, withDefault: 7 });

      // Simulate JSON persistence, which omits the unset optional key.
      const persisted = JSON.parse(JSON.stringify(first.values));
      const again = validateSettingsValues(numberSchema, persisted);
      expect(again.errors).toEqual([]);
      expect(again.values).toEqual(first.values);
    }
  });

  it("rejects empty and non-numeric required numbers", () => {
    const numberSchema: SettingsSchema = {
      id: "demo-ext.required-number",
      title: "Required number",
      schemaVersion: 1,
      fields: [{ key: "count", type: "number", label: "Count", required: true }],
    };

    for (const value of [undefined, null, "", "not-a-number"]) {
      const result = validateSettingsValues(numberSchema, { count: value });
      expect(result.errors).toContainEqual({ path: "count", message: "Count must be a number" });
    }
  });

  it("enforces number minimum and maximum for real numbers", () => {
    const numberSchema: SettingsSchema = {
      id: "demo-ext.bounded-number",
      title: "Bounded number",
      schemaVersion: 1,
      fields: [{ key: "count", type: "number", label: "Count", min: 2, max: 5 }],
    };

    expect(validateSettingsValues(numberSchema, { count: 1 }).errors).toContainEqual({
      path: "count",
      message: "Count must be ≥ 2",
    });
    expect(validateSettingsValues(numberSchema, { count: 6 }).errors).toContainEqual({
      path: "count",
      message: "Count must be ≤ 5",
    });
    expect(validateSettingsValues(numberSchema, { count: 3 }).errors).toEqual([]);
  });

  it("rejects a present list value that is not an array", () => {
    const result = validateSettingsValues(schema, { categories: "not-an-array", defaultCategory: "" }, { modelOptions: models });

    expect(result.errors).toContainEqual({ path: "categories", message: "Categories must be a list" });
    expect(result.values.categories).toEqual([]);
  });

  it("rejects a present list item that is not an object", () => {
    const result = validateSettingsValues(schema, { categories: ["not-an-object"], defaultCategory: "" }, { modelOptions: models });

    expect(result.errors).toContainEqual({ path: "categories[0]", message: "Categories item must be an object" });
  });
});
