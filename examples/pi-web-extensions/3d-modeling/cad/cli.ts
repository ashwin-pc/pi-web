#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { CadError, runCad } from "./core.js";
import { redact } from "./process.js";

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const result = await runCad(args, { cwd: process.cwd(), signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch (error) {
    const exitCode = error instanceof CadError ? error.exitCode : 1;
    process.stderr.write(`${JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : String(error)), exitCode, ...(error instanceof CadError && error.result ? { result: error.result } : {}) })}\n`);
    return exitCode;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => "") : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) process.exitCode = await main();
