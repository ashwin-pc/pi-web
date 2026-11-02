import { describe, expect, it, vi } from "vitest";
import { fetchSameOriginAttachmentImage } from "../src/messages/attachmentImageFetch.js";

const pageUrl = "https://pi.example.test/messages";

describe("authenticated attachment image fetches", () => {
  it.each([
    "https://attacker.invalid/image.png",
    "//attacker.invalid/image.png",
    "/\\attacker.invalid/image.png",
    "\\\\attacker.invalid/image.png",
    "https:\\\\attacker.invalid/image.png",
    "http://[::1",
  ])("does not fetch an untrusted transcript URL: %s", (contentUrl) => {
    const headers = vi.fn(() => ({ authorization: "Bearer owner-api-token" }));
    const fetchImage = vi.fn();

    expect(fetchSameOriginAttachmentImage(contentUrl, headers, pageUrl, fetchImage as typeof fetch)).toBeUndefined();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/messages/image?id=relative", "https://pi.example.test/api/messages/image?id=relative"],
    ["https://pi.example.test/api/messages/image?id=absolute", "https://pi.example.test/api/messages/image?id=absolute"],
  ])("fetches a same-origin URL with authentication and redirects disabled", (contentUrl, expectedUrl) => {
    const request = Promise.resolve(new Response());
    const headers = vi.fn(() => ({ authorization: "Bearer owner-api-token" }));
    const fetchImage = vi.fn(() => request);

    expect(fetchSameOriginAttachmentImage(contentUrl, headers, pageUrl, fetchImage as typeof fetch)).toBe(request);
    expect(fetchImage).toHaveBeenCalledWith(new URL(expectedUrl), {
      headers: { authorization: "Bearer owner-api-token" },
      redirect: "error",
    });
    expect(headers).toHaveBeenCalledOnce();
  });
});
