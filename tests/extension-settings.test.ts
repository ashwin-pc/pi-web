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
});
