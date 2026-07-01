import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingsPatch, createSettingsStore, normalizeSettings } from "../server/settings.js";

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
      appearance: { density: "tiny", accentColor: "tomato" },
      composer: { queueMode: "bad", expanded: "yes" },
      defaults: { model: { provider: "", id: "model" }, thinkingLevel: "", sessionBucketColor: "orange" },
    })).toEqual({
      version: 1,
      appearance: { density: "comfortable", accentColor: "#e2b15f" },
      composer: { queueMode: "steer", expanded: false },
      defaults: {},
    });
  });

  it("applies partial patches without accepting unrelated keys", () => {
    const next = applySettingsPatch(normalizeSettings(undefined), {
      appearance: { density: "compact", accentColor: "#f0a" },
      composer: { queueMode: "followUp", expanded: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low", sessionBucketColor: "purple" },
      unknown: true,
    });

    expect(next).toEqual({
      version: 1,
      appearance: { density: "compact", accentColor: "#ff00aa" },
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
