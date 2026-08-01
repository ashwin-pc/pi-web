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
    const withValues = applyExtensionValues(normalizeSettings({}), OWNER, { tier: "fast" }, { schemaVersion: 3 });
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

  it("bumps revision and rejects stale writes", () => {
    const first = applyExtensionValues(normalizeSettings({}), OWNER, { n: 1 });
    expect(first.extensions?.[OWNER]?.revision).toBe(1);

    const second = applyExtensionValues(first, OWNER, { n: 2 }, { expectedRevision: 1 });
    expect(second.extensions?.[OWNER]?.revision).toBe(2);

    expect(() => applyExtensionValues(second, OWNER, { n: 3 }, { expectedRevision: 1 }))
      .toThrow(ExtensionRevisionConflictError);
  });

  it("enforces bounds and namespaced owner ids", () => {
    expect(() => applyExtensionValues(normalizeSettings({}), OWNER, { blob: "x".repeat(70 * 1024) }))
      .toThrow(ExtensionSettingsBoundsError);
    expect(() => applyExtensionValues(normalizeSettings({}), "nodots", { a: 1 }))
      .toThrow(ExtensionSettingsBoundsError);
  });

  it("keeps the migration backup outside user values across a round trip", () => {
    const withBackup = applyExtensionValues(normalizeSettings({}), OWNER, { fresh: true }, {
      backup: { schemaVersion: 1, values: { legacy: true } },
    });
    const roundTripped = normalizeSettings(JSON.parse(JSON.stringify(withBackup)));

    expect(roundTripped.extensions?.[OWNER]?.backup?.values).toEqual({ legacy: true });
    expect(roundTripped.extensions?.[OWNER]?.values).toEqual({ fresh: true });
  });

  it("resets an owner without touching the rest of the settings", () => {
    const withValues = applyExtensionValues(normalizeSettings({}), OWNER, { tier: "fast" });
    const reset = resetExtensionValues(withValues, OWNER);
    expect(reset.extensions).toBeUndefined();
    expect(reset.appearance.accentColor).toBe(withValues.appearance.accentColor);
  });

  it("round-trips owner values through the store on disk", async () => {
    const store = createSettingsStore(await tempFile());
    await store.patchExtension(OWNER, { tier: "fast" }, { schemaVersion: 1 });

    const reread = await store.read();
    expect(reread.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });

    await store.patch({ composer: { queueMode: "followUp" } });
    const afterUnrelated = await store.read();
    expect(afterUnrelated.composer.queueMode).toBe("followUp");
    expect(afterUnrelated.extensions?.[OWNER]?.values).toEqual({ tier: "fast" });

    await store.resetExtension(OWNER);
    expect((await store.read()).extensions?.[OWNER]).toBeUndefined();
  });
});
