import assert from "node:assert/strict";
import { test } from "node:test";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHunyuanTools, runOwned } from "./tools.js";

test("Hunyuan is opt-in, and an interpreter alone does not enable registration", async () => {
  const previous = { ...process.env };
  try {
    const names: string[] = [];
    const api = { registerTool: (tool: { name: string }) => { names.push(tool.name); } } as unknown as PiWebExtensionAPI;
    delete process.env.PI_HUNYUAN_COMFY_ROOT;
    process.env.PI_HUNYUAN_PYTHON = "/unused/python";
    registerHunyuanTools(api);
    assert.deepEqual(names, []);
    await assert.rejects(runOwned("unused"), /Set PI_HUNYUAN_COMFY_ROOT/);
    process.env.PI_HUNYUAN_COMFY_ROOT = "   ";
    registerHunyuanTools(api);
    assert.deepEqual(names, []);
    process.env.PI_HUNYUAN_COMFY_ROOT = "/installed/comfy";
    registerHunyuanTools(api);
    assert.deepEqual(names, ["comfy_image_to_3d"]);
  } finally {
    for (const name of ["PI_HUNYUAN_COMFY_ROOT", "PI_HUNYUAN_PYTHON"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("configured root supplies launcher and explicit interpreter overrides it", async () => {
  const rootBefore = process.env.PI_HUNYUAN_COMFY_ROOT;
  const pythonBefore = process.env.PI_HUNYUAN_PYTHON;
  const root = await mkdtemp(join(tmpdir(), "hunyuan-launcher-"));
  try {
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await writeFile(join(root, ".venv/bin/python"), '#!/bin/sh\nprintf \'{"launcher":"default"}\\n\'\n', { mode: 0o755 });
    process.env.PI_HUNYUAN_COMFY_ROOT = root;
    delete process.env.PI_HUNYUAN_PYTHON;
    assert.equal(JSON.parse(await runOwned("unused")).launcher, "default");
    const override = join(root, "override-python");
    await writeFile(override, '#!/bin/sh\nprintf \'{"launcher":"override"}\\n\'\n', { mode: 0o755 });
    process.env.PI_HUNYUAN_PYTHON = override;
    assert.equal(JSON.parse(await runOwned("unused")).launcher, "override");
  } finally {
    if (rootBefore === undefined) delete process.env.PI_HUNYUAN_COMFY_ROOT;
    else process.env.PI_HUNYUAN_COMFY_ROOT = rootBefore;
    if (pythonBefore === undefined) delete process.env.PI_HUNYUAN_PYTHON;
    else process.env.PI_HUNYUAN_PYTHON = pythonBefore;
    await rm(root, { recursive: true, force: true });
  }
});
