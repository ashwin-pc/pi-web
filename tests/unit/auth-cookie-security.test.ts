import { describe, expect, it } from "vitest";
import { secureSessionCookies } from "../../server/auth/cookieSecurity.js";

describe("session cookie security", () => {
  it("defaults to Secure when the public origin is omitted", () => {
    expect(secureSessionCookies(undefined, "127.0.0.1")).toBe(true);
    expect(secureSessionCookies(undefined, "0.0.0.0")).toBe(true);
  });

  it("permits non-Secure cookies only for explicit loopback HTTP", () => {
    expect(secureSessionCookies("http://localhost:9960", "127.0.0.1")).toBe(
      false,
    );
    expect(secureSessionCookies("http://[::1]:9960", "::1")).toBe(false);
    expect(secureSessionCookies("http://public.example.test", "127.0.0.1")).toBe(true);
  });

  it("keeps HTTPS Secure regardless of listener or forwarding claims", () => {
    expect(secureSessionCookies("https://public.example.test", "0.0.0.0")).toBe(true);
    expect(
      (
        secureSessionCookies as (
          origin: string | undefined,
          host: string,
          ignoredHeaders: Record<string, string>,
        ) => boolean
      )("https://public.example.test", "127.0.0.1", {
        "forwarded": "proto=http",
        "x-forwarded-host": "localhost:9960",
        "x-forwarded-proto": "http",
      }),
    ).toBe(true);
  });
});
