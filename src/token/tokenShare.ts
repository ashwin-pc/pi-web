export type ScannedTokenPayload = {
  token: string;
  url?: URL;
};

export function createTokenShareUrl(token: string, href = defaultLocationHref()) {
  const current = new URL(href);
  const url = new URL(current.pathname || "/", current.origin);
  url.searchParams.set("token", token);
  return url.toString();
}

export function extractTokenFromScannedText(text: string): ScannedTokenPayload | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const absoluteUrl = parseAbsoluteUrl(trimmed);
  if (absoluteUrl) {
    const token = absoluteUrl.searchParams.get("token")?.trim();
    return token ? { token, url: absoluteUrl } : undefined;
  }

  const tokenParam = trimmed.match(/(?:^|[?&])token=([^&\s]+)/i);
  if (tokenParam?.[1]) return { token: decodeURIComponent(tokenParam[1].replace(/\+/g, " ")).trim() };

  if (!/\s/.test(trimmed)) return { token: trimmed };
  return undefined;
}

function defaultLocationHref() {
  return typeof location === "undefined" ? "http://localhost/" : location.href;
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
