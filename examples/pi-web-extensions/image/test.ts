import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, parameters, run } from "./index.js";
import { parseConfig, selectProfile, loadConfig } from "./config.js";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("arbitrary local Qwen names, options and default selection", async () => {
  const sample = JSON.parse(await readFile(new URL("./config.example.json", import.meta.url), "utf8"));
  const config = parseConfig(sample);
  assert.equal(selectProfile(config).name, "my-fast-qwen");
  assert.equal(selectProfile(config, "my-detailed-qwen").profile.sampling.steps, 40);
  assert.equal(Object.keys(config.models).length, 2);
  assert.deepEqual(Object.keys(config.models), ["my-fast-qwen", "my-detailed-qwen"]);
  const synthetic = parseConfig({ defaultModel: "personal-gguf", models: { "personal-gguf": { ...sample.models["my-fast-qwen"], model: { loader: "UnetLoaderGGUF", file: "private-qwen.gguf" } } } });
  assert.equal(selectProfile(synthetic).profile.model.loader, "UnetLoaderGGUF");
  assert.equal(selectProfile(synthetic).profile.lora?.strength, 1);
  const renamed = parseConfig({ defaultModel: "personal-variant", models: { "personal-variant": { ...sample.models["my-detailed-qwen"], model: { loader: "UNETLoader", file: "another-qwen.safetensors" }, sampling: { kind: "standard", steps: 28, cfg: 2, sampler: "heun", scheduler: "normal", denoise: .7 } } } });
  assert.equal(selectProfile(renamed).profile.model.file, "another-qwen.safetensors");
  assert.equal(selectProfile(renamed).profile.sampling.sampler, "heun");
  assert.equal(selectProfile(renamed).profile.sampling.steps, 28);
  assert.ok(parameters.properties.model);
  assert.ok(!Object.hasOwn(parameters.properties, "mode"));
  assert.throws(() => selectProfile(renamed, "quick"), /Unknown image model/);
  assert.throws(() => parseConfig({ ...sample, defaultModel: "missing" }), /Unknown defaultModel/);
  assert.throws(() => parseConfig({ defaultModel: "bad", models: { bad: { ...sample.models["my-fast-qwen"], sampling: { ...sample.models["my-fast-qwen"].sampling, steps: 6 } } } }), /requires 4 steps/);
  assert.throws(() => parseConfig({ defaultModel: "bad", models: { bad: { ...sample.models["my-fast-qwen"], model: { loader: "UNETLoader", file: "../secret" } } } }), /filename/);
  const prior = process.env.PI_IMAGE_CONFIG;
  delete process.env.PI_IMAGE_CONFIG;
  try { await assert.rejects(loadConfig(), /PI_IMAGE_CONFIG/); }
  finally { if (prior !== undefined) process.env.PI_IMAGE_CONFIG = prior; }
});
test("generate, edit, batch and validation", () => {
  assert.deepEqual(normalize({ prompt: "scene", seed: 1 })[0], { prompt: "scene", images: [], seed: 1, width: 1024, height: 1024 });
  assert.deepEqual(normalize({ prompt: "modify", image_path: "a.png", reference_image_paths: ["b.png"], seed: 2 })[0].images, ["a.png", "b.png"]);
  assert.deepEqual(normalize({ prompt: "shared", jobs: [{ seed: 1 }, { prompt: "other", image_path: "a.png", seed: 2 }] }).map(j => [j.prompt, j.images]), [["shared", []], ["other", ["a.png"]]]);
  assert.throws(() => normalize({ prompt: "x", reference_image_paths: ["a.png"] }), /requires image_path/);
  assert.throws(() => normalize({ jobs: [{ seed: 1 }] }), /prompt/);
  assert.throws(() => normalize({ prompt: "x", jobs: [{}], image_path: "a.png" }), /jobs or top-level/);
  assert.deepEqual(normalize({ jobs: [{ prompt: "a", seed: 1 }, { prompt: "b", seed: 2 }] }).map(j => j.seed), [1, 2]);
});
test("runner cancellation terminates child and missing configuration fails before spawn", async () => {
  const prior = process.env.PI_IMAGE_RUNTIME_ROOT;
  delete process.env.PI_IMAGE_RUNTIME_ROOT;
  await assert.rejects(run("unused"), /PI_IMAGE_RUNTIME_ROOT/);
  const root = await mkdtemp(join(tmpdir(), "pi-image-test-"));
  try {
    await mkdir(join(root, "venv/bin"), { recursive: true });
    const fake = join(root, "venv/bin/python");
    await writeFile(fake, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    process.env.PI_IMAGE_RUNTIME_ROOT = root;
    const controller = new AbortController();
    const pending = run("unused", controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    if (prior === undefined) delete process.env.PI_IMAGE_RUNTIME_ROOT;
    else process.env.PI_IMAGE_RUNTIME_ROOT = prior;
    await rm(root, { recursive: true, force: true });
  }
});
