#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env };

const providerEnvVars = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "HF_TOKEN",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
];

function hasProviderEnv() {
  return providerEnvVars.some((name) => Boolean(env[name]?.trim()));
}

function agentDir() {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function hasAuthFile() {
  const authPath = join(agentDir(), "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    return Boolean(auth && typeof auth === "object" && Object.keys(auth).length > 0);
  } catch {
    return false;
  }
}

function hasCustomModelsFile() {
  const modelsPath = join(agentDir(), "models.json");
  if (!existsSync(modelsPath)) return false;
  try {
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    return Boolean(models?.providers && typeof models.providers === "object" && Object.keys(models.providers).length > 0);
  } catch {
    return false;
  }
}

function hasProviderConfiguration() {
  return hasProviderEnv() || hasAuthFile() || hasCustomModelsFile();
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", reject);
  });
}

async function maybeRunPiLogin() {
  if (env.PI_WEB_SKIP_PROVIDER_ONBOARDING === "1" || env.CI === "1" || hasProviderConfiguration()) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn("pi-web: no Pi provider credentials found. Run `pi` and use `/login`, or set an API key env var, to connect an LLM provider.");
    return;
  }

  console.log("\nNo Pi LLM provider configuration was found.");
  console.log("pi-web uses the same provider login as the Pi CLI.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Open Pi now so you can run /login? [Y/n] ")).trim().toLowerCase();
  rl.close();
  if (answer === "n" || answer === "no") return;

  console.log("\nStarting Pi. Run /login, complete provider setup, then exit Pi to continue starting pi-web.\n");
  const piCli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  const result = await waitForExit(spawn(process.execPath, [piCli], { cwd: env.PI_WEB_CWD || process.cwd(), env, stdio: "inherit" }));
  if (result.code && result.code !== 0) console.warn(`pi-web: Pi exited with code ${result.code}; starting pi-web anyway.`);
}

env.PI_WEB_CWD ||= process.cwd();
env.PI_WEB_DEV = "0";
env.NODE_ENV = "production";

await maybeRunPiLogin();

const child = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
  cwd: appDir,
  env,
  stdio: "inherit",
});

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwardedSignals) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  for (const forwardedSignal of forwardedSignals) process.removeAllListeners(forwardedSignal);
  const signalNumber = signal ? osConstants.signals[signal] : undefined;
  process.exit(code ?? (signalNumber ? 128 + signalNumber : 0));
});

child.on("error", (error) => {
  console.error(`pi-web failed to start: ${error.message}`);
  process.exit(1);
});
