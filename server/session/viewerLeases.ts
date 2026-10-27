export type ViewerPrincipal = string;

export type ViewerSocketLike = {
  readyState: number;
  OPEN: number;
};

export type ViewerConnectionSocketLike = ViewerSocketLike & {
  once(event: "close", listener: () => void): unknown;
};

type ViewerLease = {
  principal: ViewerPrincipal;
  clientId: string;
  sessionId: string;
  sessionKey: string;
  lastAcceptedSeq?: number;
  sockets: Map<symbol, ViewerSocketLike | undefined>;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

type ViewerLeaseCallbacks = {
  sessionKey(sessionId: string): string | undefined;
  addViewer(sessionKey: string, leaseKey: string): void;
  removeViewer(sessionKey: string, leaseKey: string): void;
};

export const internalViewerPrincipal: ViewerPrincipal = "internal:trusted";

/**
 * Browser sessions use their unguessable server-side session hash. Credentials
 * without a browser session (notably API tokens) use the authenticated identity
 * id, which includes the token id. Open mode is deliberately one shared
 * anonymous authority because it has no credential boundary to preserve.
 */
export function viewerPrincipal(input: { sessionHash?: string; identity: { id: string } }): ViewerPrincipal {
  return input.sessionHash ? `session:${input.sessionHash}` : `identity:${input.identity.id}`;
}

function leaseMapKey(principal: ViewerPrincipal, clientId: string) {
  return `${principal.length}:${principal}${clientId}`;
}

export class ViewerLeaseController {
  private readonly leases = new Map<string, ViewerLease>();
  private readonly connections = new Map<symbol, string>();

  constructor(
    private readonly graceMs: number,
    private readonly callbacks: ViewerLeaseCallbacks,
  ) {}

  acquire(sessionId: string, clientId: string, principal: ViewerPrincipal, seq?: number) {
    if (!clientId || !principal) return false;
    const sessionKey = this.callbacks.sessionKey(sessionId);
    if (!sessionKey) return false;
    const key = leaseMapKey(principal, clientId);
    let lease = this.leases.get(key);
    const validSeq = seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
    if (validSeq !== undefined && lease?.lastAcceptedSeq !== undefined && validSeq < lease.lastAcceptedSeq) return false;

    this.clearTimer(lease?.releaseTimer);
    if (!lease) {
      lease = { principal, clientId, sessionId, sessionKey, sockets: new Map() };
      this.leases.set(key, lease);
    } else if (lease.sessionKey !== sessionKey) {
      this.callbacks.removeViewer(lease.sessionKey, key);
      lease.sessionId = sessionId;
      lease.sessionKey = sessionKey;
    }
    if (validSeq !== undefined) lease.lastAcceptedSeq = validSeq;
    this.callbacks.addViewer(sessionKey, key);
    if (lease.sockets.size === 0) this.scheduleRelease(key, lease);
    return true;
  }

  connect(clientId: string, principal: ViewerPrincipal, socket?: ViewerSocketLike) {
    if (socket && socket.readyState !== socket.OPEN) return undefined;
    const key = leaseMapKey(principal, clientId);
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = undefined;
    const connection = Symbol(clientId);
    lease.sockets.set(connection, socket);
    this.connections.set(connection, key);
    return connection;
  }

  disconnect(connection: symbol) {
    const key = this.connections.get(connection);
    if (!key) return;
    this.connections.delete(connection);
    const lease = this.leases.get(key);
    if (!lease || !lease.sockets.delete(connection) || lease.sockets.size > 0) return;
    this.releaseKey(key, lease);
  }

  release(clientId: string, principal: ViewerPrincipal) {
    const key = leaseMapKey(principal, clientId);
    const lease = this.leases.get(key);
    if (lease) this.releaseKey(key, lease);
  }

  dropSession(sessionKey: string) {
    for (const [key, lease] of this.leases) {
      if (lease.sessionKey === sessionKey) this.releaseKey(key, lease);
    }
  }

  clear() {
    for (const [key, lease] of this.leases) this.releaseKey(key, lease);
  }

  snapshot(principal?: ViewerPrincipal) {
    return Array.from(this.leases.values())
      .filter((lease) => principal === undefined || lease.principal === principal)
      .map((lease) => ({
        clientId: lease.clientId,
        sessionId: lease.sessionId,
        sockets: lease.sockets.size,
        hasReleaseTimer: Boolean(lease.releaseTimer),
      }));
  }

  private scheduleRelease(key: string, lease: ViewerLease) {
    if (lease.sockets.size > 0) return;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = setTimeout(() => {
      const current = this.leases.get(key);
      if (current === lease && current.sockets.size === 0) this.releaseKey(key, current);
    }, this.graceMs);
    lease.releaseTimer.unref?.();
  }

  private releaseKey(key: string, lease: ViewerLease) {
    if (this.leases.get(key) !== lease) return;
    this.clearTimer(lease.releaseTimer);
    this.leases.delete(key);
    for (const connection of lease.sockets.keys()) this.connections.delete(connection);
    lease.sockets.clear();
    this.callbacks.removeViewer(lease.sessionKey, key);
  }

  private clearTimer(timer?: ReturnType<typeof setTimeout>) {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveViewerLease<T extends { sessionId: string }>(input: {
  controller: ViewerLeaseController;
  socket: ViewerConnectionSocketLike;
  clientId: string;
  principal: ViewerPrincipal;
  fallback: T;
  seq?: number;
  resolve(): Promise<T | undefined>;
}): Promise<{ target?: T; closed: boolean }> {
  const { controller, socket, clientId, principal, fallback, seq } = input;
  const acquired = controller.acquire(fallback.sessionId, clientId, principal, seq);
  if (!acquired) {
    const target = await input.resolve();
    return socket.readyState === socket.OPEN ? { target, closed: false } : { closed: true };
  }
  const connection = controller.connect(clientId, principal, socket);
  if (!connection) {
    controller.release(clientId, principal);
    return { closed: true };
  }
  socket.once("close", () => controller.disconnect(connection));
  try {
    const target = await input.resolve();
    if (socket.readyState !== socket.OPEN) {
      controller.disconnect(connection);
      return { closed: true };
    }
    if (target && target.sessionId !== fallback.sessionId) {
      controller.acquire(target.sessionId, clientId, principal, seq);
    }
    return { target, closed: false };
  } catch (error) {
    controller.disconnect(connection);
    throw error;
  }
}
