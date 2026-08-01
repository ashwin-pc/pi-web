import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExtensionValues,
  applySettingsPatch,
  createSettingsStore,
  ExtensionRevisionConflictError,
  ExtensionSettingsBoundsError,
  normalizeSettings,
  resetExtensionValues,
} from "../server/settings.js";

let tempDirs: string[] = [];

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
  tempDirs.push(dir);
  return join(dir, "settings.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("pi-web settings", () => {
  it("normalizes missing and invalid values to safe defaults", () => {
    expect(normalizeSettings({
      version: 999,
      appearance: { density: "tiny", accentColor: "tomato", loadingAnimation: "spin" },
      composer: { queueMode: "bad", expanded: "yes" },
      defaults: { model: { provider: "", id: "model" }, thinkingLevel: "", sessionBucketColor: "orange" },
    })).toEqual({
      version: 1,
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
      composer: { queueMode: "steer", expanded: false },
      defaults: {},
    });
  });

  it("applies partial patches without accepting unrelated keys", () => {
    const next = applySettingsPatch(normalizeSettings(undefined), {
      appearance: { density: "compact", accentColor: "#f0a", loadingAnimation: "pulse" },
      composer: { queueMode: "followUp", expanded: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low", sessionBucketColor: "purple" },
      unknown: true,
    });

    expect(next).toEqual({
      version: 1,
      appearance: { density: "compact", accentColor: "#ff00aa", loadingAnimation: "pulse" },
      composer: { queueMode: "followUp", expanded: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low", sessionBucketColor: "purple" },
    });
  });

  it("persists settings atomically as JSON", async () => {
    const file = await tempFile();
    const store = createSettingsStore(file);

    expect(await store.read()).toEqual(normalizeSettings(undefined));
    const saved = await store.patch({ composer: { queueMode: "followUp" } });
    expect(saved.composer.queueMode).toBe("followUp");

    const fromDisk = JSON.parse(await readFile(file, "utf-8"));
    expect(fromDisk.composer.queueMode).toBe("followUp");

    const reloaded = createSettingsStore(file);
    expect((await reloaded.read()).composer.queueMode).toBe("followUp");
  });
});

describe("extension-contributed settings", () => {
  const OWNER = "demo-ext.prefs";

  it("preserves extension values when unrelated settings are patched", async () => {
    // Regression: normalizeSettings rebuilds known fields only, so an owner's
    // values must be carried through verbatim even while its extension is absent.
    const withValues = applyExtensionValues(normalizeSettings({}), OWNER, { tier: "fast" }, { schemaVersion: 3, expectedRevision: 0 });
    const patched = applySettingsPatch(withValues, { appearance: { density: "compact" } });

    expect(patched.appearance.density).toBe("compact");
    expect(patched.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });
    expect(patched.extensions?.[OWNER]?.schemaVersion).toBe(3);
  });

  it("ignores extension values supplied through the generic patch path", () => {
    const injected = applySettingsPatch(normalizeSettings({}), {
      extensions: { "evil.owner": { schemaVersion: 1, revision: 1, values: { nope: true } } },
    });
    expect(injected.extensions?.["evil.owner"]).toBeUndefined();
  });

  it("persists nothing until an owner actually writes", () => {
    expect(normalizeSettings({}).extensions).toBeUndefined();
  });

  it("requires revision zero for a guarded first write and rejects stale revisions", () => {
    const first = applyExtensionValues(normalizeSettings({}), OWNER, { n: 1 }, { expectedRevision: 0 });
    expect(first.extensions?.[OWNER]?.revision).toBe(1);

    expect(() => applyExtensionValues(normalizeSettings({}), OWNER, { n: 1 }, { expectedRevision: 1 }))
      .toThrow(ExtensionRevisionConflictError);

    const second = applyExtensionValues(first, OWNER, { n: 2 }, { expectedRevision: 1 });
    expect(second.extensions?.[OWNER]?.revision).toBe(2);

    expect(() => applyExtensionValues(second, OWNER, { n: 3 }, { expectedRevision: 1 }))
      .toThrow(ExtensionRevisionConflictError);
    expect(() => resetExtensionValues(second, OWNER, 1))
      .toThrow(ExtensionRevisionConflictError);
    expect(() => resetExtensionValues(second, OWNER, undefined as unknown as number))
      .toThrow(ExtensionRevisionConflictError);
  });

  it("enforces bounds and namespaced owner ids", () => {
    expect(() => applyExtensionValues(normalizeSettings({}), OWNER, { blob: "x".repeat(70 * 1024) }, { expectedRevision: 0 }))
      .toThrow(ExtensionSettingsBoundsError);
    expect(() => applyExtensionValues(normalizeSettings({}), "nodots", { a: 1 }, { expectedRevision: 0 }))
      .toThrow(ExtensionSettingsBoundsError);
  });

  it("keeps the migration backup outside user values across a round trip", () => {
    const withBackup = applyExtensionValues(normalizeSettings({}), OWNER, { fresh: true }, {
      expectedRevision: 0,
      backup: { schemaVersion: 1, values: { legacy: true } },
    });
    const roundTripped = normalizeSettings(JSON.parse(JSON.stringify(withBackup)));

    expect(roundTripped.extensions?.[OWNER]?.backup?.values).toEqual({ legacy: true });
    expect(roundTripped.extensions?.[OWNER]?.values).toEqual({ fresh: true });
  });

  it("resets an owner without touching the rest of the settings", () => {
    const withValues = applyExtensionValues(normalizeSettings({}), OWNER, { tier: "fast" }, { expectedRevision: 0 });
    const reset = resetExtensionValues(withValues, OWNER, 1);
    expect(reset.extensions).toBeUndefined();
    expect(reset.appearance.accentColor).toBe(withValues.appearance.accentColor);
  });

  it("allows exactly one of two concurrent writes with the same expected revision", async () => {
    const store = createSettingsStore(await tempFile());
    await store.patchExtension(OWNER, { n: 1 }, { expectedRevision: 0 });

    const results = await Promise.allSettled([
      store.patchExtension(OWNER, { n: 2 }, { expectedRevision: 1 }),
      store.patchExtension(OWNER, { n: 3 }, { expectedRevision: 1 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(ExtensionRevisionConflictError) });
    expect((await store.read()).extensions?.[OWNER]?.revision).toBe(2);
  });

  it("preserves both effects when a generic patch races an extension patch", async () => {
    const store = createSettingsStore(await tempFile());

    await Promise.all([
      store.patch({ composer: { expanded: true } }),
      store.patchExtension(OWNER, { tier: "fast" }, { schemaVersion: 1, expectedRevision: 0 }),
    ]);

    const stored = await store.read();
    expect(stored.composer.expanded).toBe(true);
    expect(stored.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });
    expect(stored.extensions?.[OWNER]?.revision).toBe(1);
  });

  it("keeps a coherent parseable record when reset races an extension patch", async () => {
    const file = await tempFile();
    const store = createSettingsStore(file);
    await store.patchExtension(OWNER, { n: 1 }, { schemaVersion: 2, expectedRevision: 0 });

    const results = await Promise.allSettled([
      store.resetExtension(OWNER, 1),
      store.patchExtension(OWNER, { n: 2 }, { schemaVersion: 2, expectedRevision: 1 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ status: "rejected", reason: expect.any(ExtensionRevisionConflictError) });
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    const record = parsed.extensions?.[OWNER];
    expect(record === undefined || (
      record.schemaVersion === 2 &&
      record.revision === 2 &&
      JSON.stringify(record.values) === JSON.stringify({ n: 2 })
    )).toBe(true);
  });

  it("lands many rapid writes with gapless revisions and valid JSON", async () => {
    const file = await tempFile();
    const store = createSettingsStore(file);

    for (let revision = 0; revision < 25; revision += 1) {
      const saved = await store.patchExtension(OWNER, { n: revision + 1 }, { expectedRevision: revision });
      expect(saved.extensions?.[OWNER]?.revision).toBe(revision + 1);
    }

    const parsed = JSON.parse(await readFile(file, "utf-8"));
    expect(parsed.extensions[OWNER]).toMatchObject({ revision: 25, values: { n: 25 } });
  });

  it("round-trips owner values through the store on disk", async () => {
    const store = createSettingsStore(await tempFile());
    await store.patchExtension(OWNER, { tier: "fast" }, { schemaVersion: 1, expectedRevision: 0 });

    const reread = await store.read();
    expect(reread.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });

    await store.patch({ composer: { queueMode: "followUp" } });
    const afterUnrelated = await store.read();
    expect(afterUnrelated.composer.queueMode).toBe("followUp");
    expect(afterUnrelated.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });

    await store.resetExtension(OWNER, 1);
    expect((await store.read()).extensions?.[OWNER]).toBeUndefined();
  });
});
