#!/usr/bin/env node
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyWavyPackage } from "./verify-package.mjs";

const root = resolve(import.meta.dirname, "..");
const destination = await mkdtemp(join(tmpdir(), "wavy-pack-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${String(result.stderr || result.stdout)}`);
  return result.stdout;
}

async function verifyCleanConsumer(archive) {
  const consumer = join(destination, "clean-consumer");
  await mkdir(consumer);
  run("tar", ["-xzf", archive], { cwd: consumer });
  const packageRoot = join(consumer, "package");

  // Fail rather than accidentally proving discovery through a checkout or shared
  // ancestor installation. Only the extracted package may supply node_modules.
  for (let current = dirname(packageRoot); current !== parse(current).root; current = dirname(current)) {
    try {
      await access(join(current, "node_modules"));
      throw new Error(`clean consumer has an ancestor node_modules: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const env = { ...process.env, HOME: join(consumer, "home") };
  delete env.NODE_PATH;
  run("npm", [
    "install", "--omit=dev", "--ignore-scripts", "--no-save",
    "@ashwin-pc/pi-web@0.6.0",
    "@earendil-works/pi-ai@0.84.1",
    "@earendil-works/pi-coding-agent@0.84.1",
    "typebox@1.0.64",
  ], { cwd: packageRoot, env });
  const runner = join(packageRoot, "verify-discovery.mjs");
  await writeFile(runner, `
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
const workspace = join(import.meta.dirname, "consumer-workspace");
await mkdir(workspace, { recursive: true });
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir: join(workspace, ".agent"),
  additionalExtensionPaths: [join(import.meta.dirname, "index.ts")],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
if (result.errors.length) throw new Error(JSON.stringify(result.errors));
const extension = result.extensions.find(item => item.path.endsWith("/index.ts"));
const tools = extension ? [...extension.tools.keys()] : [];
for (const expected of ["wavy", "wavy_status", "wavy_compose", "wavy_render", "wavy_transcribe"]) {
  if (!tools.includes(expected)) throw new Error("clean discovery missing " + expected + ": " + tools.join(", "));
}
console.log("Clean packed Wavy install discovered all runtime tools.");
`);
  run(process.execPath, [runner], { cwd: packageRoot, env });
  console.log("Verified clean extracted install with production dependencies and SDK discovery.");
}

try {
  const stdout = run("npm", ["pack", "--pack-destination", destination, "--json"], { cwd: root });
  const jsonMarker = stdout.indexOf("\n[");
  const jsonStart = stdout.startsWith("[") ? 0 : jsonMarker >= 0 ? jsonMarker + 1 : -1;
  if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${stdout}`);
  const [{ filename }] = JSON.parse(stdout.slice(jsonStart));
  const archive = join(destination, filename);
  await verifyWavyPackage(archive);
  await verifyCleanConsumer(archive);
} finally {
  await rm(destination, { recursive: true, force: true });
}
