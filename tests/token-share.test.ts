import { describe, expect, it } from "vitest";
import { extractTokenFromScannedText } from "../src/token/tokenShare.js";

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
