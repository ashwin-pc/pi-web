import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

// Retain the fixture's existing startup/readiness allowance for every child.
export const CLI_PROCESS_TIMEOUT_MS = 15_000;
// A CLI cancellation awaits its nested runtime's 250ms owned cleanup before
// writing JSON. Its outer test owner must allow that cleanup to finish.
const TERMINATION_GRACE_MS = 1_000;
const CLOSE_DEADLINE_MS = 1_000;
const ASSERTION_BUDGET_MS = 1_000;
export const cliTestTimeout = (invocations = 1) => invocations * (CLI_PROCESS_TIMEOUT_MS + TERMINATION_GRACE_MS + CLOSE_DEADLINE_MS) + ASSERTION_BUDGET_MS;

/** Own test-only CLI groups independently of the CLI's nested runtime owner.
 * Deadlines and test teardown both await termination before deleting fixtures. */
export function createCliProcessHarness(timeoutMs = CLI_PROCESS_TIMEOUT_MS) {
  const active = new Set<{ stop: () => void; settled: Promise<unknown> }>();
  return {
    run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signalWhenReady?: string; onSpawn?: (pid: number) => void } = {}) {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (child.pid) options.onSpawn?.(child.pid);
      let stop!: () => void;
      const settled = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "", stderr = "", finished = false, stopping = false;
        let closed = false, closedCode: number | null = null, cleanupComplete = false;
        let failure: Error | undefined;
        let readinessTimer: ReturnType<typeof setInterval> | undefined;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let closeDeadline: ReturnType<typeof setTimeout> | undefined;
        const signalGroup = (signal: NodeJS.Signals) => {
          if (!child.pid) return;
          try { process.kill(-child.pid, signal); }
          catch (error: any) {
            if (error.code !== "ESRCH") failure = new Error(`${failure ? `${failure.message}; ` : ""}Could not signal owned CLI group (${signal}): ${error.message}`);
          }
        };
        const finish = (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline); clearTimeout(escalation); clearTimeout(closeDeadline); clearInterval(readinessTimer);
          child.stdout.destroy(); child.stderr.destroy();
          if (failure) reject(failure); else resolve({ code, stdout, stderr });
        };
        stop = () => {
          if (finished || stopping) return;
          stopping = true;
          clearInterval(readinessTimer);
          signalGroup("SIGTERM");
          escalation = setTimeout(() => {
            signalGroup("SIGKILL");
            // Drain the full graceful-cleanup phase even if the leader closes
            // first; do not race a final group kill against that close event.
            cleanupComplete = true;
            if (closed) { finish(closedCode); return; }
            closeDeadline = setTimeout(() => {
              failure = new Error(`${failure ? `${failure.message}; ` : ""}CLI process group did not close after SIGKILL`);
              finish(null);
            }, CLOSE_DEADLINE_MS);
          }, TERMINATION_GRACE_MS);
        };
        const deadline = setTimeout(() => {
          failure ??= new Error(`CLI exceeded ${timeoutMs}ms; terminating owned process group. stderr: ${stderr}`);
          stop();
        }, timeoutMs);
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", error => { failure = error; finish(null); });
        child.once("exit", () => { stop(); });
        child.once("close", code => {
          closed = true; closedCode = code;
          stop();
          if (cleanupComplete) finish(code);
        });
        if (options.signalWhenReady) {
          readinessTimer = setInterval(() => {
            void access(options.signalWhenReady!).then(() => {
              if (finished || stopping) return;
              clearInterval(readinessTimer);
              // Let the CLI own cancellation and finish its nested cleanup.
              child.kill("SIGTERM");
            }, () => {});
          }, 10);
        }
      }).finally(() => active.delete(owned));
      const owned = { stop, settled };
      active.add(owned);
      return settled;
    },
    async dispose() {
      const owned = [...active];
      for (const child of owned) child.stop();
      const results = await Promise.allSettled(owned.map(child => child.settled));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
