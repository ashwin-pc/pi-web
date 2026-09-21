#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const root = resolve(import.meta.dirname, "..");
const entry = resolve(root, "examples/pi-web-extensions/wavy/player.ts");
const output = resolve(root, "examples/pi-web-extensions/wavy/browser.js");
const watching = process.argv.includes("--watch");
const checking = process.argv.includes("--check");
if (watching && checking) throw new Error("Use either --watch or --check, not both.");

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const options = {
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "none",
  sourcemap: false,
  write: false,
  outfile: output,
  logLevel: "info",
};

if (watching) {
  const writer = {
    name: "atomic-wavy-browser-output",
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length || !result.outputFiles?.length) return;
        const generated = result.outputFiles.find(file => file.path === output) ?? result.outputFiles[0];
        await atomicWrite(output, generated.contents);
        console.log(`Wavy browser bundle updated: ${output}`);
      });
    },
  };
  const context = await esbuild.context({ ...options, plugins: [writer] });
  const close = async () => { await context.dispose(); process.exit(0); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await context.watch();
} else {
  const result = await esbuild.build(options);
  const generated = result.outputFiles?.find(file => file.path === output) ?? result.outputFiles?.[0];
  if (!generated) throw new Error("esbuild produced no Wavy browser output.");
  if (checking) {
    let current;
    try { current = await readFile(output); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error("Wavy browser bundle is missing; run npm run build:wavy-browser first.");
      throw error;
    }
    if (!current.equals(Buffer.from(generated.contents))) throw new Error("Wavy browser bundle is stale or non-deterministic; run npm run build:wavy-browser.");
    console.log("Wavy browser bundle matches its canonical TypeScript sources.");
  } else {
    await atomicWrite(output, generated.contents);
  }
}
