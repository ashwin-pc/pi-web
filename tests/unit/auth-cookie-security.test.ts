import { describe, expect, it } from "vitest";
import { secureSessionCookies } from "../../server/auth/cookieSecurity.js";

describe("session cookie security", () => {
  it("uses the request Host to distinguish local HTTP from a public tunnel", () => {
    expect(secureSessionCookies(undefined, "127.0.0.1", undefined, "localhost:9960")).toBe(false);
    expect(secureSessionCookies(undefined, "::1", undefined, "[::1]:9960")).toBe(false);
    expect(secureSessionCookies(undefined, "127.0.0.1", undefined, "pi.example.test")).toBe(true);
    expect(secureSessionCookies(undefined, "0.0.0.0", undefined, "localhost:9960")).toBe(true);
    expect(secureSessionCookies(undefined, "127.0.0.1", "127.0.0.1", "localhost:9960")).toBe(true);
    expect(secureSessionCookies(undefined, "127.0.0.1", undefined)).toBe(true);
  });

  it("honors an explicitly declared HTTP origin as plaintext", () => {
    expect(secureSessionCookies("http://localhost:9960", "127.0.0.1", undefined)).toBe(false);
    expect(secureSessionCookies("http://[::1]:9960", "::1", undefined)).toBe(false);
    expect(secureSessionCookies("http://devbox:9960", "0.0.0.0", undefined)).toBe(false);
  });

  it("keeps HTTPS Secure regardless of listener or forwarding claims", () => {
    expect(secureSessionCookies("https://public.example.test", "0.0.0.0", undefined)).toBe(true);
    expect(secureSessionCookies("https://public.example.test", "127.0.0.1", "127.0.0.1", "localhost")).toBe(true);
  });
});
