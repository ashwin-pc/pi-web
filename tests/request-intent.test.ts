import type { IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthKernel, AuthStore, hashSecret, type AuthVia } from "../server/auth/kernel.js";
import { createOriginRejectionReporter, originFailureHint, unconfiguredOriginWarning } from "../server/auth/origin.js";
import { requestIntentFailure } from "../server/auth/requestIntent.js";

const origin = "https://pi.example.test";
const tempDirs: string[] = [];

function message(headers: IncomingMessage["headers"] = {}) {
  return { method: "GET", url: "/api/git/status?fetch=1", headers: { host: "pi.example.test", ...headers } } as IncomingMessage;
}

function request(via: AuthVia, headers: IncomingMessage["headers"] = {}, path = "/api/git/status?fetch=1") {
  const req = message(headers);
  return requestIntentFailure(req, new URL(path, origin), via, origin);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("request intent gate", () => {
  it("logs one actionable warning when hostname access has no declared origin", () => {
    const messages: string[] = [];
    const report = createOriginRejectionReporter(undefined, (value) => messages.push(value));
    report(message());
    report(message());
    expect(messages).toEqual([unconfiguredOriginWarning]);

    createOriginRejectionReporter(origin, (value) => messages.push(value))(message());
    expect(messages).toHaveLength(1);
  });

  it.each(["session", "external", "open"] as const)("requires same-origin browser intent for %s Git fetches", (via) => {
    expect(request(via, { origin, "sec-fetch-site": "same-origin", "x-pi-web-client-id": "browser" })).toBeUndefined();
    expect(request(via, { origin, "sec-fetch-site": "same-origin" })).toBe("CSRF validation failed");
    expect(request(via, { "sec-fetch-site": "cross-site", "x-pi-web-client-id": "browser" })).toBe(originFailureHint);
    expect(request(via, { origin: "https://evil.example", "x-pi-web-client-id": "browser" })).toBe(originFailureHint);
  });

  it("preserves non-browser Bearer API-token fetches without Origin or fetch metadata", () => {
    expect(request("token", { authorization: "Bearer synthetic-token" })).toBeUndefined();
    expect(request("token", { authorization: "Bearer synthetic-token", "sec-fetch-site": "cross-site" })).toBe(originFailureHint);
  });

  it("does not gate read-only Git status requests", () => {
    expect(request("session", {}, "/api/git/status")).toBeUndefined();
  });

  it("uses real synthetic auth classifications for external, session, open, and API-token callers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-request-intent-"));
    tempDirs.push(dir);
    const storePath = join(dir, "auth.json");
    const sessionSecret = "session-secret";
    const apiSecret = "api-secret";
    await writeFile(storePath, JSON.stringify({
      version: 1,
      credentials: [],
      sessions: [{
        hash: hashSecret(sessionSecret),
        identity: { id: "external:owner" },
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }],
      apiTokens: [{
        id: "machine",
        name: "machine",
        hash: hashSecret(apiSecret),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }],
    }));
    const authenticated = new AuthKernel("external", new AuthStore(storePath), true, "x-test-user");
    const open = new AuthKernel("none", new AuthStore(join(dir, "open.json")));
    const sameOrigin = { origin, "sec-fetch-site": "same-origin", "x-pi-web-client-id": "browser" };
    const cases = [
      { kernel: authenticated, req: message({ ...sameOrigin, "x-test-user": "owner" }), via: "external" },
      { kernel: authenticated, req: message({ ...sameOrigin, cookie: `pi_web_session=${sessionSecret}` }), via: "session" },
      { kernel: open, req: message(sameOrigin), via: "open" },
      { kernel: authenticated, req: message({ authorization: `Bearer ${apiSecret}` }), via: "token" },
    ] as const;

    for (const entry of cases) {
      const auth = await entry.kernel.gate(entry.req);
      expect(auth).toMatchObject({ ok: true, via: entry.via });
      if (auth.ok) expect(requestIntentFailure(entry.req, new URL(entry.req.url!, origin), auth.via, origin)).toBeUndefined();
    }
  });
});
