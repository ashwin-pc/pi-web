#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";
const bin = (name) => `node_modules/.bin/${name}${isWin ? ".cmd" : ""}`;

const e2eOnly = process.argv.includes("--e2e-only");
const e2eShards = Math.max(1, Number(process.env.PI_WEB_E2E_SHARDS || 3));
const e2eConcurrency = Math.max(1, Number(process.env.PI_WEB_E2E_CONCURRENCY || 3));

const requestedProjects = new Set(String(process.env.PI_WEB_E2E_PROJECTS || "mobile,tablet,desktop,auth").split(",").map((name) => name.trim()).filter(Boolean));
const e2eProjects = [
  { name: "mobile", basePort: 9876 },
  { name: "tablet", basePort: 10_176 },
  { name: "desktop", basePort: 10_476 },
  { name: "auth", basePort: 10_776 },
].filter((project) => requestedProjects.has(project.name));

const e2eTasks = e2eProjects.flatMap((project) =>
  Array.from({ length: project.name === "auth" ? 1 : e2eShards }, (_, index) => {
    const shard = index + 1;
    return {
      name: project.name === "auth" || e2eShards === 1 ? `e2e:${project.name}` : `e2e:${project.name}:${shard}/${e2eShards}`,
      command: bin("playwright"),
      args: ["test", `--project=${project.name}`, ...(project.name === "auth" ? [] : [`--shard=${shard}/${e2eShards}`])],
      env: { PLAYWRIGHT_PORT: String(project.basePort + index * 10), PI_WEB_E2E_AUTH: project.name === "auth" ? "1" : "0" },
      kind: "e2e",
    };
  }),
);

const preflightTasks = [
  { name: "typecheck", command: bin("tsc"), args: ["--noEmit"], kind: "static" },
  { name: "unit", command: bin("vitest"), args: ["run"], kind: "unit" },
  { name: "build", command: bin("vite"), args: ["build"], kind: "static" },
];

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[33m", "\x1b[95m"];
const reset = "\x1b[0m";

const started = Date.now();
const results = [];

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
    const color = colors[(index + colorOffset) % colors.length];
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
  return !results.slice(phaseResultStart).some((result) => result.code !== 0);
}

async function runE2eTasks() {
  for (let index = 0; index < e2eTasks.length; index += e2eConcurrency) {
    const batch = e2eTasks.slice(index, index + e2eConcurrency);
    if (!await runPhase(batch, preflightTasks.length + index)) return false;
  }
  return true;
}

if (e2eOnly) {
  const buildTask = preflightTasks.filter((task) => task.name === "build");
  if (await runPhase(buildTask)) await runE2eTasks();
} else if (await runPhase(preflightTasks)) await runE2eTasks();

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const failed = results.filter((result) => result.code !== 0);

console.log(`\nTest tasks finished in ${elapsed}s`);
for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
  const status = result.code === 0 ? "passed" : `failed${result.signal ? ` (${result.signal})` : ""}`;
  console.log(`- ${result.name}: ${status}`);
}

process.exit(failed.length ? 1 : 0);
