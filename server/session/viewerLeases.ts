export type ViewerPrincipal = string;

type ViewerLease = {
  principal: ViewerPrincipal;
  clientId: string;
  sessionId: string;
  sessionKey: string;
  lastAcceptedSeq?: number;
  sockets: Set<symbol>;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

type ViewerLeaseCallbacks = {
  sessionKey(sessionId: string): string | undefined;
  addViewer(sessionKey: string, leaseKey: string): void;
  removeViewer(sessionKey: string, leaseKey: string): void;
};

export const internalViewerPrincipal: ViewerPrincipal = "internal:trusted";

/**
 * The authenticated identity is stable across an external or legacy browser's
 * initial ticket request and the browser session cookie issued alongside state.
 * API token identity ids include the token id, so distinct tokens stay isolated.
 */
export function viewerPrincipal(input: { identity: { id: string } }): ViewerPrincipal {
  return `identity:${input.identity.id}`;
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
      lease = { principal, clientId, sessionId, sessionKey, sockets: new Set() };
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

  connect(clientId: string, principal: ViewerPrincipal) {
    const key = leaseMapKey(principal, clientId);
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = undefined;
    const connection = Symbol(clientId);
    lease.sockets.add(connection);
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
