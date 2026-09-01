import { access, lstat, rename, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveArtifactRead, resolveArtifactWrite } from "../shared.js";

const MAC_PATHS = [
  "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
  "/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
];
const MAX_STL_BYTES = 64 * 1024 * 1024;
const MAX_GCODE_BYTES = 256 * 1024 * 1024;
const MAX_DIAGNOSTICS = 64 * 1024;

export type SliceOptions = { input: string; output: string; printerProfile: string; printProfile: string; materialProfile: string; datadir?: string };

function validateProfile(value: string, label: string) {
  if (!value || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error(`${label} profile name is invalid.`);
  return value;
}

export async function findPrusaSlicer() {
  const configured = process.env.PRUSA_SLICER_PATH;
  const candidates = configured ? [configured] : [...MAC_PATHS];
  if (!configured) for (const directory of (process.env.PATH || "").split(delimiter)) if (directory) candidates.push(join(directory, "prusa-slicer"), join(directory, "PrusaSlicer"));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error("PrusaSlicer was not found. Set PRUSA_SLICER_PATH or install it in a known macOS/PATH location.");
}

export async function sliceStl(pi: PiWebExtensionAPI, cwd: string, options: SliceOptions, signal?: AbortSignal) {
  const input = await resolveArtifactRead(cwd, options.input, ".stl", MAX_STL_BYTES, "STL");
  const output = await resolveArtifactWrite(cwd, options.output, ".gcode");
  return withFileMutationQueue(output.path, async () => {
    const executable = await findPrusaSlicer();
    const temporary = `${output.path}.tmp-${process.pid}-${Date.now()}.gcode`;
    const args = ["--slice", "--no-binary-gcode", "--printer-profile", validateProfile(options.printerProfile, "Printer"), "--print-profile", validateProfile(options.printProfile, "Print"), "--material-profile", validateProfile(options.materialProfile, "Material")];
    if (options.datadir) {
      const stat = await lstat(options.datadir);
      if (!stat.isDirectory()) throw new Error("PrusaSlicer datadir is not a directory.");
      args.push("--datadir", options.datadir);
    }
    args.push("--output", temporary, input.path);
    try {
      const result = await pi.exec(executable, args, { cwd, timeout: 180_000, signal });
      const diagnostics = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.slice(-MAX_DIAGNOSTICS);
      if (result.code !== 0) throw new Error(`PrusaSlicer exited with code ${result.code}.\n${diagnostics}`);
      const stat = await lstat(temporary);
      if (!stat.isFile() || !stat.size) throw new Error("PrusaSlicer did not create G-code.");
      if (stat.size > MAX_GCODE_BYTES) throw new Error("Generated G-code exceeds the 256 MB limit.");
      await rename(temporary, output.path);
      return { ...output, bytes: stat.size, diagnostics };
    } finally { await rm(temporary, { force: true }); }
  });
}
