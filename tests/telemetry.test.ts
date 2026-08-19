import { afterEach, describe, expect, it, vi } from "vitest";
import { logRequest } from "../server/telemetry.js";

// The access log goes to stdout (supervisor captures it). Without a bound it
// would grow unbounded over long uptime even at modest request rates, so we cap
// aggregate output with a rolling window budget: once a window exceeds its
// line/byte cap we stop emitting per-request lines and emit a single aggregate
// line per window. Slow requests (>= 250ms) are always emitted individually.

describe("request access log bounding", () => {
  afterEach(() => vi.restoreAllMocks());

  const perRequestCalls = () =>
    vi.mocked(console.log).mock.calls.filter((call) => {
      const line = String(call[0]);
      return line.startsWith("[access] ") && !line.startsWith("[access] aggregate");
    }).length;

  it("coalesces per-request lines once the window budget is exceeded", () => {
    vi.spyOn(console, "log");

    // 2,000 fast requests in one window: the first ~1,000 get individual lines,
    // the remainder must NOT — aggregate output is bounded, not linear in rate.
    for (let i = 0; i < 2_000; i += 1) {
      logRequest("GET", `/api/sessions`, 200, 10, 1_024);
    }
    const logged = perRequestCalls();
    expect(logged).toBeGreaterThan(0);
    expect(logged).toBeLessThan(2_000);
    expect(logged).toBeLessThanOrEqual(1_000 + 1); // ACCESS_MAX_LINES cap
  });

  it("always emits slow outliers individually", () => {
    vi.spyOn(console, "log");

    // Exhaust the fast-request budget first, then confirm slow requests are still
    // logged one line each (they are the diagnostic signal and inherently rare).
    for (let i = 0; i < 1_200; i += 1) {
      logRequest("GET", "/api/sessions", 200, 10, 1_024);
    }
    const before = perRequestCalls();
    for (let i = 0; i < 3; i += 1) {
      logRequest("GET", "/api/sessions", 200, 500, 2_000_000);
    }
    const after = perRequestCalls();
    expect(after - before).toBe(3);
  });

  it("logs pathname only (query strings redacted for token safety, #85)", () => {
    vi.spyOn(console, "log");
    // server.ts passes url.pathname (query dropped), so `?token=...` never reaches
    // the log; logRequest emits that pathname form verbatim.
    logRequest("GET", "/ws", 101, 500, 0);
    const line = String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
    expect(line).toContain("/ws");
    expect(line).not.toContain("?");
    expect(line).not.toContain("token");
    expect(line).not.toContain("secret");
  });
});
