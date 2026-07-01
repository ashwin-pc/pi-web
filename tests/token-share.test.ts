import { describe, expect, it } from "vitest";
import { createTokenShareUrl, extractTokenFromScannedText } from "../src/token/tokenShare.js";

it("builds a token share URL without carrying existing query params", () => {
  expect(createTokenShareUrl("secret token", "https://pi.example.test/app?sessionId=abc#frag")).toBe("https://pi.example.test/app?token=secret+token");
});

describe("extractTokenFromScannedText", () => {
  it("extracts a token from a token link", () => {
    const result = extractTokenFromScannedText("https://pi.example.test/?token=test-secret&sessionId=s1");
    expect(result?.token).toBe("test-secret");
    expect(result?.url?.searchParams.get("sessionId")).toBe("s1");
  });

  it("accepts a raw token", () => {
    expect(extractTokenFromScannedText("test-secret")?.token).toBe("test-secret");
  });

  it("rejects unrelated QR text", () => {
    expect(extractTokenFromScannedText("not a token link with spaces")).toBeUndefined();
  });
});
