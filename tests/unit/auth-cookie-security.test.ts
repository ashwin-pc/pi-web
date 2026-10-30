import { describe, expect, it } from "vitest";
import { secureSessionCookies } from "../../server/auth/cookieSecurity.js";

describe("session cookie security", () => {
  it("uses the request Host to distinguish local HTTP from a public tunnel", () => {
    expect(secureSessionCookies(undefined, "127.0.0.1", "localhost:9960")).toBe(false);
    expect(secureSessionCookies(undefined, "::1", "[::1]:9960")).toBe(false);
    expect(secureSessionCookies(undefined, "127.0.0.1", "pi.example.test")).toBe(true);
    expect(secureSessionCookies(undefined, "0.0.0.0", "localhost:9960")).toBe(true);
    expect(secureSessionCookies(undefined, "127.0.0.1")).toBe(true);
  });

  it("permits non-Secure cookies only for explicit loopback HTTP", () => {
    expect(secureSessionCookies("http://localhost:9960", "127.0.0.1")).toBe(false);
    expect(secureSessionCookies("http://[::1]:9960", "::1")).toBe(false);
    expect(() => secureSessionCookies("http://public.example.test", "127.0.0.1")).toThrow(/must use HTTPS/);
  });

  it("keeps HTTPS Secure regardless of listener or forwarding claims", () => {
    expect(secureSessionCookies("https://public.example.test", "0.0.0.0")).toBe(true);
    expect(secureSessionCookies("https://public.example.test", "127.0.0.1", "localhost")).toBe(true);
  });
});
