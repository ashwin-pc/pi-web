#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";
const bin = (name) => `node_modules/.bin/${name}${isWin ? ".cmd" : ""}`;

const e2eOnly = process.argv.includes("--e2e-only");
const e2eShards = Math.max(1, Number(process.env.PI_WEB_E2E_SHARDS || 3));

const e2eProjects = [
  { name: "mobile", basePort: 9876 },
  { name: "tablet", basePort: 10_176 },
  { name: "desktop", basePort: 10_476 },
  { name: "auth", basePort: 10_776 },
];

const e2eTasks = e2eProjects.flatMap((project) =>
  Array.from({ length: e2eShards }, (_, index) => {
    const shard = index + 1;
    return {
      name: e2eShards === 1 ? `e2e:${project.name}` : `e2e:${project.name}:${shard}/${e2eShards}`,
      command: bin("playwright"),
      args: ["test", `--project=${project.name}`, `--shard=${shard}/${e2eShards}`],
      env: { PLAYWRIGHT_PORT: String(project.basePort + index * 10) },
      kind: "e2e",
    };
  }),
);

const allTasks = [
  { name: "typecheck", command: bin("tsc"), args: ["--noEmit"], kind: "static" },
  { name: "unit", command: bin("vitest"), args: ["run"], kind: "unit" },
  ...e2eTasks,
];

const tasks = e2eOnly ? e2eTasks : allTasks;

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[33m", "\x1b[95m"];
const reset = "\x1b[0m";

const started = Date.now();
const children = new Map();
const results = [];
let stopping = false;

function prefixLines(stream, taskName, color) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length) process.stdout.write(`${color}[${taskName}]${reset} ${line}\n`);
      else process.stdout.write("\n");
    }
  });
  stream.on("end", () => {
    if (pending.length) process.stdout.write(`${color}[${taskName}]${reset} ${pending}\n`);
  });
}

function stopOthers(failedName) {
  if (stopping) return;
  stopping = true;
  for (const [name, child] of children) {
    if (name !== failedName && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

await Promise.all(tasks.map((task, index) => new Promise((resolve) => {
  const color = colors[index % colors.length];
  const child = spawn(task.command, task.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...task.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
  });
  children.set(task.name, child);
  prefixLines(child.stdout, task.name, color);
  prefixLines(child.stderr, task.name, color);
  child.on("error", (error) => {
    results.push({ name: task.name, code: 1, error });
    stopOthers(task.name);
    resolve();
  });
  child.on("exit", (code, signal) => {
    results.push({ name: task.name, code: code ?? (signal ? 1 : 0), signal });
    if ((code ?? 1) !== 0) stopOthers(task.name);
    resolve();
  });
})));

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const failed = results.filter((result) => result.code !== 0);

console.log(`\nTest tasks finished in ${elapsed}s`);
for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
  const status = result.code === 0 ? "passed" : `failed${result.signal ? ` (${result.signal})` : ""}`;
  console.log(`- ${result.name}: ${status}`);
}

process.exit(failed.length ? 1 : 0);
