#!/usr/bin/env node
// Resolve tsx beside the extension, independent of the caller's cwd. All argv
// parsing, output, cancellation and execution remain in the shared CLI entry.
import { register } from "tsx/esm/api";

const unregister = register({ tsconfig: false });
try {
  const { main } = await import("./cad/cli.ts");
  process.exitCode = await main();
} finally {
  await unregister();
}
