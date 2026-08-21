// Telemetry for the event-loop starvation class (#24/#110/#112).
//
// Three cheap, always-on diagnostics that are safe to run on the main thread:
//  1. Event-loop stall detection (monitorEventLoopDelay histogram)
//  2. Request access log with timing, bounded so it cannot grow unbounded
//  3. WebSocket open/close timing
//
// All output goes to stdout, which the supervisor forwards to its own stdout.

import { performance } from "node:perf_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";

// ── Event-loop stall telemetry ──────────────────────────────────────────────
//
// monitorEventLoopDelay() samples the event loop from within the process, so it
// can only report AFTER a stall has ended — in-process code cannot run mid-stall.
// Permanent-hang detection is explicitly out of scope (a supervisor liveness
// probe was considered and rejected in #112). We log a single line whenever the
// max event-loop delay over the last window exceeds a threshold.

const STALL_THRESHOLD_MS = 100;
const STALL_CHECK_MS = 10_000;
let stallMonitor: ReturnType<typeof createStallMonitor> | undefined;

/** Pure window-check: converts a histogram `.max` (NANOSECONDS) to ms and applies
 *  the threshold. Exported separately so the unit test can hit it directly. */
export function stallLine(maxNs: number): string | undefined {
  const maxMs = maxNs / 1e6;
  return maxMs >= STALL_THRESHOLD_MS
    ? `[event-loop] max delay ${Math.round(maxMs)}ms in last ${STALL_CHECK_MS / 1000}s`
    : undefined;
}

/** Factory for the production stall monitor. `.enable()` here is REQUIRED: the
 *  histogram starts disabled and records nothing (max stays 0) without it.
 *  Exported so the regression test exercises the real wiring rather than a
 *  manually-enabled histogram. */
export function createStallMonitor() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const check = () => {
    const line = stallLine(histogram.max);
    histogram.reset();
    if (line) console.log(line);
    return line;
  };
  return { histogram, check };
}

export function startEventLoopTelemetry() {
  if (stallMonitor) return;
  stallMonitor = createStallMonitor();
  const timer = setInterval(() => stallMonitor?.check(), STALL_CHECK_MS);
  timer.unref?.();
}

// ── Bounded request access log ──────────────────────────────────────────────
//
// One line per request: `[access] <iso> <method> <path> <status> <durMs>ms <bytes>`.
// Query strings are deliberately NOT logged: `?token=` appears in WS/page URLs
// (#85), and the pathname alone is enough to reproduce incidents like #112
// (`GET /api/sessions 200 2900ms 2.4MB` twice a second).
//
// The log goes to stdout (supervisor captures it). Without a bound it grows
// unbounded over long uptime even at modest request rates, so we cap aggregate
// output with a rolling window budget: once a window exceeds its line/byte cap
// we stop emitting per-request lines and emit a single aggregate line per window
// instead. Slow requests (>= ACCESS_SLOW_MS) and aborted requests are always
// emitted individually — they are the diagnostic signal (e.g. the /api/sessions
// scan stalls and the timeouts it causes), and they are inherently rare, so they
// cannot dominate.
//
// Worst-case steady output is therefore bounded to ~ACCESS_MAX_BYTES per window
// (plus rare slow/aborted outliers), independent of request rate. That is the
// bound that prevents "blows up over time" — normal cumulative growth no longer
// scales linearly with request count.

const ACCESS_WINDOW_MS = 60_000;
const ACCESS_MAX_LINES = 1_000;
const ACCESS_MAX_BYTES = 64 * 1024;
const ACCESS_SLOW_MS = 250;

let accessWindowStart = performance.now();
let accessWindowLines = 0;
let accessWindowBytes = 0;
let accessCoalesced = false;
let accessAgg = { requests: 0, bytes: 0, slow: 0 };
let accessFlushTimer: ReturnType<typeof setInterval> | undefined;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function accessRollWindow(now: number) {
  if (accessCoalesced) {
    console.log(`[access] aggregate ${ACCESS_WINDOW_MS / 1000}s: requests=${accessAgg.requests} bytes=${fmtBytes(accessAgg.bytes)} slow=${accessAgg.slow}`);
  }
  accessWindowStart = now;
  accessWindowLines = 0;
  accessWindowBytes = 0;
  accessCoalesced = false;
  accessAgg = { requests: 0, bytes: 0, slow: 0 };
}

// Roll the window on a wall-clock timer so an aggregate line flushes even if a
// request storm is followed by silence (a later-request-only roll would delay it
// indefinitely). unref()'d so it never keeps the process alive.
function ensureAccessFlushTimer() {
  if (accessFlushTimer) return;
  accessFlushTimer = setInterval(() => accessRollWindow(performance.now()), ACCESS_WINDOW_MS);
  accessFlushTimer.unref?.();
}

export function logRequest(method: string, pathname: string, status: number, durationMs: number, bytes: number, aborted = false) {
  ensureAccessFlushTimer();
  const line = `[access] ${new Date().toISOString()} ${method} ${pathname} ${status} ${Math.round(durationMs)}ms ${fmtBytes(bytes)}${aborted ? " aborted" : ""}`;
  const lineBytes = Buffer.byteLength(line) + 1;
  const now = performance.now();
  if (now - accessWindowStart >= ACCESS_WINDOW_MS) accessRollWindow(now);

  accessWindowLines += 1;
  accessWindowBytes += lineBytes;
  accessAgg.requests += 1;
  accessAgg.bytes += bytes;
  if (durationMs >= ACCESS_SLOW_MS) accessAgg.slow += 1;

  const overBudget = accessWindowLines > ACCESS_MAX_LINES || accessWindowBytes > ACCESS_MAX_BYTES;
  if (overBudget) accessCoalesced = true;
  // Slow/aborted outliers are always emitted; everything else only while under budget.
  if (durationMs >= ACCESS_SLOW_MS || aborted || !overBudget) console.log(line);
}

export function logWebSocket(pathname: string, event: "open" | "close", durationMs?: number) {
  const suffix = durationMs === undefined ? "" : ` ${Math.round(durationMs)}ms`;
  console.log(`[ws] ${new Date().toISOString()} ${pathname} ${event}${suffix}`);
}

// (The wrapper in server.ts computes response bytes from `socket.bytesWritten`
//  deltas, so no per-request write/end patching is needed.)
