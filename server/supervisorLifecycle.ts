import type { ChildProcess } from "node:child_process";

/** Ask a child to stop, escalating after graceMs, and settle only on its exit event. */
export function stopChildProcess(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.removeListener("exit", onExit);
      reject(error);
    };
    const onExit = () => finish();
    child.once("exit", onExit);

    // Recheck after attaching to avoid missing an exit between the initial check and listener.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }

    timeout = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch (error) { fail(error); }
    }, graceMs);
    try { child.kill("SIGTERM"); } catch (error) { fail(error); }
  });
}
