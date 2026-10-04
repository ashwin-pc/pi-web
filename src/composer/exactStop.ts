/** A rejected exact Stop must never be retried or retargeted to newer work. */
export async function exactStop(stop: () => Promise<Response>, report: (message: string) => void, reconcile: () => Promise<void>): Promise<void> {
  try {
    const response = await stop();
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  } catch (error) {
    const message = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
    try { await reconcile(); }
    catch (error) { report(`Could not refresh session state: ${error instanceof Error ? error.message : String(error)}`); }
    // Snapshot hydration may replace the transcript; report after reconciliation.
    report(message);
  }
}
