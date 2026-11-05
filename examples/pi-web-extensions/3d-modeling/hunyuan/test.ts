import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwned } from "./tools.js";
import { runCad } from "../cad/core.js";

test("Hunyuan execution is opt-in, and an interpreter alone does not configure discovery", async () => {
  const previous = { ...process.env };
  try {
    delete process.env.PI_HUNYUAN_COMFY_ROOT;
    process.env.PI_HUNYUAN_PYTHON = "/unused/python";
    const context = { cwd: tmpdir() };
    assert.equal((await runCad(["discover"], context) as any).hunyuan.configured, false);
    await assert.rejects(runOwned("unused"), /Set PI_HUNYUAN_COMFY_ROOT/);
    await assert.rejects(runCad(["hunyuan", "generate", "--json", '{"image":"unused.png"}'], context), /Set PI_HUNYUAN_COMFY_ROOT/);
    process.env.PI_HUNYUAN_COMFY_ROOT = "   ";
    assert.equal((await runCad(["discover"], context) as any).hunyuan.configured, false);
    process.env.PI_HUNYUAN_COMFY_ROOT = "/installed/comfy";
    assert.equal((await runCad(["discover"], context) as any).hunyuan.configured, true);
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
