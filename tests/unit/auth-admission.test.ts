import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { browserMutationFailure } from "../../server/auth/admission.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([]), {
    headers: { host: "pi.example.test", ...headers },
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/settings",
  }) as unknown as IncomingMessage;
}

const origin = "https://pi.example.test";

describe("browser mutation admission", () => {
  it("requires configured-origin intent for ambient credential classes", () => {
    for (const via of ["session", "external", "open"] as const) {
      expect(browserMutationFailure(request({ "x-pi-web-client-id": "browser" }), via, origin)).toBe("origin");
      expect(browserMutationFailure(request({ origin: "https://other.example.test", "x-pi-web-client-id": "browser" }), via, origin)).toBe("origin");
      expect(browserMutationFailure(request({ host: "other.example.test", origin: "https://other.example.test", "x-pi-web-client-id": "browser" }), via, origin)).toBe("origin");
      expect(browserMutationFailure(request({ origin }), via, origin)).toBe("intent");
      expect(browserMutationFailure(request({ origin, "x-pi-web-client-id": "browser" }), via, origin)).toBeUndefined();
      expect(browserMutationFailure(request({ "sec-fetch-site": "same-origin", "x-pi-web-client-id": "browser" }), via, origin)).toBeUndefined();
    }
  });

  it("keeps originless Authorization callers compatible and gates browser-signaled Bearer mutations", () => {
    expect(browserMutationFailure(request(), "token", origin)).toBeUndefined();
    expect(browserMutationFailure(request(), "extension", origin)).toBeUndefined();
    expect(browserMutationFailure(request({ origin: "https://other.example.test", "x-pi-web-client-id": "browser" }), "token", origin)).toBe("origin");
    expect(browserMutationFailure(request({ origin }), "token", origin)).toBe("intent");
    expect(browserMutationFailure(request({ origin, "x-pi-web-client-id": "browser" }), "token", origin)).toBeUndefined();
  });

  it("accepts synthetic intent only in mock mode and never over a hostile browser signal", () => {
    const synthetic = { "x-pi-web-test-client-intent": "playwright-test" };
    expect(browserMutationFailure(request(synthetic), "open", origin)).toBe("origin");
    expect(browserMutationFailure(request(synthetic), "open", origin, true)).toBeUndefined();
    expect(browserMutationFailure(request({ ...synthetic, origin }), "open", origin)).toBe("intent");
    expect(browserMutationFailure(request({ ...synthetic, origin }), "open", origin, true)).toBe("intent");
    expect(browserMutationFailure(request({ ...synthetic, origin, "x-pi-web-client-id": "browser" }), "open", origin, true)).toBeUndefined();
    expect(browserMutationFailure(request({ ...synthetic, "sec-fetch-site": "same-origin" }), "open", origin, true)).toBe("intent");
    expect(browserMutationFailure(request({ ...synthetic, "sec-fetch-site": "cross-site" }), "open", origin, true)).toBe("origin");
    expect(browserMutationFailure(request({ ...synthetic, origin: "https://other.example.test" }), "open", origin, true)).toBe("origin");
  });
});
