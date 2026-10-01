// Keep a close promise created immediately after spawn. `exitCode` is set at
// exit, before stdio and the working-directory handles are necessarily closed.
export async function stopPackedServer(child, closed) {
  if (!child) return;
  let graceTimer;
  let forceTimer;
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        graceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          forceTimer = setTimeout(() => reject(new Error("Packed server did not close")), 5_000);
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(graceTimer);
    clearTimeout(forceTimer);
  }
}
