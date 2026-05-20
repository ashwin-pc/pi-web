#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env };

env.PI_WEB_CWD ||= process.cwd();
env.PI_WEB_DEV = "0";
env.NODE_ENV = "production";

const child = spawn(process.execPath, ["--import", "tsx", "supervisor.ts"], {
  cwd: appDir,
  env,
  stdio: "inherit",
});

// Auto-start tunnel
const tunnelName = process.env.PI_WEB_TUNNEL_NAME || "piweb";
const tunnelPort = env.PORT || "8787";
const tunnel = spawn("tunnel", ["create", tunnelPort, "--name", tunnelName], {
  stdio: "inherit",
});
tunnel.on("error", (err) => {
  console.warn(`⚠️  Tunnel failed to start: ${err.message}`);
});

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwardedSignals) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
    if (!tunnel.killed) tunnel.kill(signal);
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
