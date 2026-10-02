import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { availableLoopbackPort, isRetryableBindFailure } from "../scripts/packed-test-port.mjs";

describe("packaged startup loopback port", () => {
  it("asks the OS for an available port and releases its probe listener", async () => {
    const port = await availableLoopbackPort();
    expect(port).toBeGreaterThan(0);
    const listener = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
    } finally {
      if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });

  it("retries only loopback bind conflicts, not other startup failures", () => {
    expect(isRetryableBindFailure("Error: listen EACCES: permission denied 127.0.0.1:49771")).toBe(true);
    expect(isRetryableBindFailure("Error: listen EADDRINUSE: address already in use 127.0.0.1:32000")).toBe(true);
    expect(isRetryableBindFailure("Error: listen EACCES: permission denied 0.0.0.0:49771")).toBe(false);
    expect(isRetryableBindFailure("Error: Cannot find module server.ts")).toBe(false);
  });
});
