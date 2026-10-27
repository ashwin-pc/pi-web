import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  AuthKernel,
  AuthStore,
  bumpRevocationEpoch,
  hashSecret,
  type AuthVia,
  type WsTicket,
} from "../../server/auth/kernel.js";
import { WebSocketRevocation } from "../../server/auth/webSocketRevocation.js";

class TestSocket extends EventEmitter {
  close = vi.fn((code: number, reason: string) => {
    this.emit("close", code, reason);
  });
}

async function fixture() {
  const store = new AuthStore(
    join(await mkdtemp(join(tmpdir(), "pi-ws-revocation-")), "auth.json"),
  );
  const kernel = new AuthKernel(
    "legacy",
    store,
    "legacy-secret",
    false,
    "x-amzn-tunnel-user",
    "authenticated",
    ["legacy", "external"],
  );
  const now = Date.now();
  await store.update((state) => {
    state.config = {
      policy: "authenticated",
      methods: ["legacy", "external"],
    };
    state.sessions.push({
      hash: "session-hash",
      identity: { id: "owner" },
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60_000,
    });
    state.apiTokens.push({
      id: "machine",
      name: "Machine",
      hash: hashSecret("machine-secret"),
      createdAt: now,
      expiresAt: now + 60_000,
    });
  });
  return { store, kernel, revocation: new WebSocketRevocation(store, kernel) };
}

function ticket(via: AuthVia): WsTicket {
  return {
    via,
    identity: {
      id:
        via === "token"
          ? "token:machine"
          : via === "external"
            ? "external:owner"
            : via === "legacy"
              ? "legacy:token"
              : via === "open"
                ? "none"
                : "owner",
    },
    ...(via === "session" ? { sessionHash: "session-hash" } : {}),
    expiresAt: Date.now() + 30_000,
    revocationEpoch: 0,
  };
}

describe("WebSocket revocation", () => {
  it.each(["session", "token", "legacy", "external", "extension"] as const)(
    "closes a %s-authenticated socket when sign-out-all advances the revocation epoch",
    async (via) => {
      const { store, revocation } = await fixture();
      const socket = new TestSocket();
      revocation.enroll(socket as unknown as WebSocket, ticket(via));
      await store.update((state) => bumpRevocationEpoch(state));
      expect(socket.close).toHaveBeenCalledWith(1008, "Browser session revoked");
    },
  );

  it.each(["session", "token", "legacy", "external", "extension"] as const)(
    "keeps live %s credentials connected and accepts a fresh reconnect ticket",
    async (via) => {
      const { revocation } = await fixture();
      const live = ticket(via);
      expect(await revocation.validForUpgrade(live)).toBe(true);
      const socket = new TestSocket();
      revocation.enroll(socket as unknown as WebSocket, live);
      expect(socket.close).not.toHaveBeenCalled();
      expect(
        await revocation.validForUpgrade({ ...live, revocationEpoch: 1 }),
      ).toBe(false);
    },
  );

  it("applies an absolute lifetime to extension-authenticated sockets", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
      const { store, revocation } = await fixture();
      const socket = new TestSocket();
      revocation.enroll(socket as unknown as WebSocket, ticket("extension"));

      vi.setSystemTime(Date.now() + 30 * 60_000);
      await store.update(() => undefined);
      expect(socket.close).toHaveBeenCalledWith(1008, "Browser session revoked");
    } finally {
      vi.useRealTimers();
    }
  });
});
