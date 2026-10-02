import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, selections, parameters, run } from "./index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

 test("four selector mappings and default", () => {
  assert.deepEqual(selections, { quick: "viggle-4step", quality: "official-bf16", "uc-quick": "uc-viggle", "uc-quality": "uc-q4" });
  assert.equal(selections.quick, "viggle-4step");
  assert.deepEqual((parameters.properties.mode as { anyOf: unknown[] }).anyOf.length, 4);
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
