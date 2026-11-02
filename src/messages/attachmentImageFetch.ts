import type { ApiHeaders } from "../app/api.js";

export function fetchSameOriginAttachmentImage(
  contentUrl: string,
  apiHeaders?: ApiHeaders,
  pageUrl: string | URL = location.href,
  fetchImage: typeof fetch = fetch,
): Promise<Response> | undefined {
  try {
    const page = new URL(pageUrl);
    const resolved = new URL(contentUrl, page);
    if (resolved.origin !== page.origin) return undefined;
    return fetchImage(resolved, { headers: apiHeaders?.(), redirect: "error" });
  } catch {
    return undefined;
  }
}
