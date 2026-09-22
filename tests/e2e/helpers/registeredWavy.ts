import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const SCORE = `X:1\nT:Registered fixture\nM:4/4\nL:1/8\nQ:1/4=100\nV:Lead\nK:C\n[V:Lead] C2 D2 \\\nE2 F2|G4 E4|`;

export interface RegisteredWavyServer {
  origin: string;
  token: string;
  workspace: string;
  score: string;
  scoreSha256: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a loopback port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off("exit", exited); resolve(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", exited);
  });
}

function signalOwnedChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  signalOwnedChild(child, "SIGTERM");
  if (await waitForExit(child, 3_000)) return;
  signalOwnedChild(child, "SIGKILL");
  if (!await waitForExit(child, 3_000)) throw new Error(`owned registered Wavy server ${child.pid ?? "unknown"} did not exit`);
}

async function waitForServer(origin: string, token: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`registered Wavy server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) {
        const state = await response.json() as { webContributions?: Array<{ key?: string }> };
        if (state.webContributions?.some(item => item.key === "wavy.preview")) return;
      }
    } catch { /* startup race */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("registered Wavy server did not become ready");
}

/** Starts a real SDK extension runtime in an owned workspace. It never invokes a model or Wavy tool. */
export async function startRegisteredWavyServer(port?: number): Promise<RegisteredWavyServer> {
  const repo = process.cwd();
  port ??= await freePort();
  const root = await mkdtemp(join(tmpdir(), "pi-web-wavy-registered-"));
  const workspace = join(root, "workspace");
  const extensionDir = join(workspace, ".pi", "web", "extensions");
  await mkdir(extensionDir, { recursive: true });
  const extension = `import wavy from ${JSON.stringify(join(repo, "examples/pi-web-extensions/wavy/index.ts"))};\n` +
    `import { createProject } from ${JSON.stringify(join(repo, "examples/pi-web-extensions/wavy/store.ts"))};\n` +
    `const score=${JSON.stringify(SCORE)};\n` +
    `export default function(pi){wavy(pi);pi.on("session_start",async(_event,ctx)=>{` +
    `await createProject(ctx.cwd,{path:"fixtures/registered.wavy",title:"Registered Wavy fixture",lyrics:"Small fixture",style:"quiet piano",score});` +
    `pi.sendMessage({customType:"wavy-registered-fixture",content:"[Registered Wavy fixture](/api/artifacts/fixtures/registered.wavy)",display:true});` +
    `});}\n`;
  await writeFile(join(extensionDir, "registered-wavy.ts"), extension, { mode: 0o600 });

  const token = randomBytes(24).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  const logPath = join(root, "server.log");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_WEB_AUTH_") || key === "PI_WEB_TOKEN") env[key] = "";
  Object.assign(env, {
    HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), NODE_ENV: "test",
    PI_WEB_DEV: "0", PI_WEB_MOCK: "0", HOST: "127.0.0.1", PORT: String(port), PI_WEB_CWD: workspace,
    PI_WEB_SETTINGS_FILE: join(root, "settings.json"), PI_WEB_SESSION_UI_STATE_FILE: join(root, "session-ui.json"),
    PI_WEB_AUTH_STORE: join(root, "auth.json"), PI_WEB_AUTH_MODE: "legacy", PI_WEB_AUTH_ORIGIN: origin,
    PI_WEB_TOKEN: token,
  });
  await Promise.all([mkdir(env.HOME!, { recursive: true }), mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true })]);
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: repo, env, detached: true, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024);
    void writeFile(logPath, stderr.replaceAll(token, "[redacted]"), { mode: 0o600 }).catch(() => {});
  });
  try {
    await waitForServer(origin, token, child);
  } catch (error) {
    let cleanupError: unknown;
    try { await terminateOwnedChild(child); } catch (caught) { cleanupError = caught; }
    finally { await rm(root, { recursive: true, force: true }); }
    const detail = `${String(error)}\n${stderr}`.replaceAll(token, "[redacted]");
    throw new Error(cleanupError ? `${detail}\nCleanup failed: ${String(cleanupError)}` : detail);
  }
  let stopped = false;
  return {
    origin, token, workspace, score: SCORE,
    scoreSha256: createHash("sha256").update(SCORE).digest("hex"),
    async stop() {
      if (stopped) return;
      stopped = true;
      try { await terminateOwnedChild(child); }
      finally { await rm(root, { recursive: true, force: true }); }
    },
  };
}

export async function readFixtureIndex(server: RegisteredWavyServer): Promise<unknown> {
  return JSON.parse(await readFile(join(server.workspace, ".pi/web/artifacts/fixtures/registered.wavy"), "utf8"));
}
