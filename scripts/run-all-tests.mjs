#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";
const bin = (name) => `node_modules/.bin/${name}${isWin ? ".cmd" : ""}`;

const e2eOnly = process.argv.includes("--e2e-only");
const skipBuild = process.argv.includes("--skip-build");
// One long-lived process per viewport avoids repeated browser/server startup and
// retry-trace contention. CI can still opt into shards when it has more capacity.
const e2eShards = Math.max(1, Number(process.env.PI_WEB_E2E_SHARDS || 1));
const e2eConcurrency = Math.max(1, Number(process.env.PI_WEB_E2E_CONCURRENCY || 4));
// Independent worktrees can run the whole matrix without sharing server ports.
const portOffset = Number(process.env.PI_WEB_E2E_PORT_OFFSET || 0);
if (!Number.isInteger(portOffset) || portOffset < 0 || Math.max(11_076 + portOffset, 10_776 + portOffset + (e2eShards - 1) * 10) > 65_535) {
  throw new Error("PI_WEB_E2E_PORT_OFFSET must keep all E2E ports between 1024 and 65535");
}

const e2eProjects = [
  { name: "mobile", basePort: 9876 },
  { name: "tablet", basePort: 10_176 },
  { name: "desktop", basePort: 10_476 },
  { name: "auth", basePort: 10_776 },
];

const e2eTasks = e2eProjects.flatMap((project) =>
  Array.from({ length: project.name === "auth" ? 1 : e2eShards }, (_, index) => {
    const shard = index + 1;
    return {
      name: project.name === "auth" || e2eShards === 1 ? `e2e:${project.name}` : `e2e:${project.name}:${shard}/${e2eShards}`,
      command: bin("playwright"),
      args: ["test", `--project=${project.name}`, ...(project.name === "auth" ? [] : [`--shard=${shard}/${e2eShards}`])],
      env: { PLAYWRIGHT_PORT: String(project.basePort + portOffset + index * 10), PI_WEB_E2E_AUTH: project.name === "auth" ? "1" : "0", PI_WEB_E2E_ISOLATED: "0" },
      kind: "e2e",
    };
  }),
);

// These regressions spawn additional servers themselves. Do not compete with
// the matrix's two (or more) browser/server pairs for startup CPU and memory.
const isolatedE2eTask = {
  name: "e2e:isolated", command: bin("playwright"), args: ["test", "--project=isolated"],
  env: { PLAYWRIGHT_PORT: String(11_076 + portOffset), PI_WEB_E2E_ISOLATED: "1", PI_WEB_E2E_AUTH: "0" }, kind: "e2e",
};

// Packaging requires completed dist assets. Running this beside Vite in the
// preflight phase can pack a half-built tree (or no dist on a clean CI runner).
const packedStartupTask = { name: "package-startup", command: isWin ? "npm.cmd" : "npm", args: ["run", "test:package"], kind: "static" };

const preflightTasks = [
  { name: "typecheck", command: bin("tsc"), args: ["--noEmit"], kind: "static" },
  { name: "unit", command: bin("vitest"), args: ["run"], kind: "unit" },
  // Match the production server even when the caller is a development shell.
  // NODE_ENV=development would otherwise compile out SW activation reloads.
  // Include the public extension runtime, not just browser assets: examples
  // import it at runtime and the package-startup check needs dist/extensions.js.
  { name: "build", command: isWin ? "npm.cmd" : "npm", args: ["run", "build"], env: { NODE_ENV: "production", PI_WEB_DEV: "0" }, kind: "static" },
];

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[33m", "\x1b[95m"];
const reset = "\x1b[0m";

const started = Date.now();
const results = [];
// Tests may be launched from a running instance. Do not pass its persistent
// home or per-file overrides to child test processes; individual server fixtures
// allocate their own temporary home (see tests/auth-isolation.ts).
const testEnv = { ...process.env, PI_WEB_HOME: "" };
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("PI_WEB_") && key.endsWith("_FILE")) testEnv[key] = "";
}

function prefixLines(stream, taskName, color) {
  let pending = "";
  let flushed = false;
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length) process.stdout.write(`${color}[${taskName}]${reset} ${line}\n`);
      else process.stdout.write("\n");
    }
  });
  const flush = () => {
    if (flushed) return;
    flushed = true;
    if (pending.length) process.stdout.write(`${color}[${taskName}]${reset} ${pending}\n`);
  };
  stream.on("end", flush);
  stream.on("close", flush);
}

async function runPhase(tasks, colorOffset = 0) {
  const phaseResultStart = results.length;
  const children = new Map();
  let stopping = false;
  const stopOthers = (failedName) => {
    if (stopping) return;
    stopping = true;
    for (const [name, child] of children) {
      if (name !== failedName && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  };

  await Promise.all(tasks.map((task, index) => new Promise((resolve) => {
    const taskStarted = Date.now();
    const color = colors[(index + colorOffset) % colors.length];
    const child = spawn(task.command, task.args, {
      cwd: process.cwd(),
      env: { ...testEnv, ...task.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });
    children.set(task.name, child);
    prefixLines(child.stdout, task.name, color);
    prefixLines(child.stderr, task.name, color);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      results.push({ name: task.name, durationMs: Date.now() - taskStarted, ...result });
      if (result.code !== 0) stopOthers(task.name);
      resolve();
    };
    child.on("error", (error) => finish({ code: 1, error }));
    child.on("exit", (code, signal) => finish({ code: code ?? (signal ? 1 : 0), signal }));
  })));
  return !results.slice(phaseResultStart).some((result) => result.code !== 0);
}

async function runE2eTasks() {
  // Pull from a shared queue instead of waiting for every task in a rigid batch.
  // A fast shard can immediately start the next project while a slow shard
  // finishes, substantially reducing the matrix's wall-clock tail.
  let nextTask = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(e2eConcurrency, e2eTasks.length) }, async (_, workerIndex) => {
    while (!failed) {
      const index = nextTask++;
      const task = e2eTasks[index];
      if (!task) return;
      if (!await runPhase([task], preflightTasks.length + workerIndex)) failed = true;
    }
  });
  await Promise.all(workers);
  if (failed) return false;
  return runPhase([isolatedE2eTask], preflightTasks.length);

}

if (e2eOnly) {
  const buildTask = skipBuild ? [] : preflightTasks.filter((task) => task.name === "build");
  if (buildTask.length === 0 || await runPhase(buildTask)) await runE2eTasks();
} else {
  // Vite and tsc can starve mock API server startup in the unit suite: under
  // concurrent preflight the server took >18s against a 15s readiness budget.
  // Keep the static checks parallel, then run unit tests without that contention.
  const staticTasks = preflightTasks.filter((task) => task.kind === "static");
  const unitTasks = preflightTasks.filter((task) => task.kind === "unit");
  if (await runPhase(staticTasks) && await runPhase(unitTasks) && await runPhase([packedStartupTask])) await runE2eTasks();
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const failed = results.filter((result) => result.code !== 0);

console.log(`\nTest tasks finished in ${elapsed}s`);
for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
  const status = result.code === 0 ? "passed" : `failed${result.signal ? ` (${result.signal})` : ""}`;
  console.log(`- ${result.name}: ${status} (${(result.durationMs / 1000).toFixed(1)}s)`);
}

process.exit(failed.length ? 1 : 0);
