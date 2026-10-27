import type { WebSocket } from "ws";
import type { AuthKernel, AuthState, AuthStore, WsTicket } from "./kernel.js";

const UNBACKED_SOCKET_LIFETIME_MS = 30 * 60_000;

function isActive(
  ticket: WsTicket,
  state: AuthState,
  kernel: AuthKernel,
  now: number,
): boolean {
  if (ticket.revocationEpoch !== (state.revocationEpoch || 0)) return false;
  if (ticket.sessionHash)
    return state.sessions.some(
      (session) =>
        session.hash === ticket.sessionHash &&
        !session.revokedAt &&
        session.expiresAt > now,
    );
  if (ticket.via === "token")
    return state.apiTokens.some(
      (token) =>
        `token:${token.id}` === ticket.identity.id &&
        !token.revokedAt &&
        token.expiresAt > now,
    );
  const methods = new Set(state.config?.methods || kernel.methods);
  if (ticket.via === "legacy")
    return methods.has("legacy") && !!kernel.legacyToken;
  if (ticket.via === "external")
    return methods.has("external") && !!kernel.trustedHeader;
  if (ticket.via === "extension") return true;
  return ticket.via === "open" && kernel.effectivePolicy(state.config?.policy) === "open";
}

export class WebSocketRevocation {
  private readonly sockets = new Map<
    WebSocket,
    { ticket: WsTicket; absoluteExpiry?: number }
  >();
  private readonly listener = (state: AuthState) => this.enforce(state);
  private readonly sweep: NodeJS.Timeout;

  constructor(
    private readonly store: AuthStore,
    private readonly kernel: AuthKernel,
  ) {
    store.listeners.add(this.listener);
    this.sweep = setInterval(() => {
      if (!this.sockets.size) return;
      void store.read().then((state) => this.enforce(state)).catch(() => {
        for (const socket of this.sockets.keys())
          socket.close(1011, "Session validation unavailable");
      });
    }, 15_000);
    this.sweep.unref();
  }

  async validForUpgrade(ticket: WsTicket): Promise<boolean> {
    return isActive(ticket, await this.store.read(), this.kernel, Date.now());
  }

  enroll(socket: WebSocket, ticket: WsTicket): void {
    this.sockets.set(socket, {
      ticket,
      ...(ticket.via === "external" || ticket.via === "extension"
        ? { absoluteExpiry: Date.now() + UNBACKED_SOCKET_LIFETIME_MS }
        : {}),
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private enforce(state: AuthState): void {
    const now = Date.now();
    for (const [socket, record] of this.sockets)
      if (
        (record.absoluteExpiry !== undefined && record.absoluteExpiry <= now) ||
        !isActive(record.ticket, state, this.kernel, now)
      )
        socket.close(1008, "Browser session revoked");
  }
}
