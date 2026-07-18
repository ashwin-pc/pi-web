export interface RealtimeSocket {
  readonly OPEN: number;
  readonly CLOSED: number;
  readonly CLOSING: number;
  readyState: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): unknown;
}

export interface RealtimeEnvelope extends Record<string, unknown> {
  seq: number;
}

function envelopeFor(value: unknown, seq: number): RealtimeEnvelope {
  return {
    ...(value && typeof value === "object" ? value as Record<string, unknown> : { value }),
    seq,
  };
}

export class RealtimeHub {
  private readonly clients = new Set<RealtimeSocket>();
  private readonly eventLog: RealtimeEnvelope[] = [];
  private nextSeq = 1;

  constructor(
    private readonly maxLogSize: number,
    private readonly onBroadcast?: (value: unknown) => void,
  ) {}

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(client: RealtimeSocket) {
    client.on("pong", () => this.missedPongs.delete(client));
    this.clients.add(client);
  }

  detach(client: RealtimeSocket) {
    this.clients.delete(client);
    this.missedPongs.delete(client);
  }

  broadcast(value: unknown): RealtimeEnvelope {
    const envelope = envelopeFor(value, this.nextSeq++);
    this.eventLog.push(envelope);
    if (this.eventLog.length > this.maxLogSize) this.eventLog.splice(0, this.eventLog.length - this.maxLogSize);
    const data = JSON.stringify(envelope);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
    this.onBroadcast?.(value);
    return envelope;
  }

  replaySince(lastSeq: number): { syncRequired: boolean; latestSeq: number; events: Array<RealtimeEnvelope & { replay: true }> } {
    const latestSeq = this.latestSeq;
    const oldestSeq = this.eventLog[0]?.seq || this.nextSeq;
    if (!Number.isFinite(lastSeq) || lastSeq <= 0) return { syncRequired: false, latestSeq, events: [] };
    if (lastSeq > latestSeq || lastSeq < oldestSeq - 1) return { syncRequired: true, latestSeq, events: [] };
    return {
      syncRequired: false,
      latestSeq,
      events: this.eventLog.filter((event) => event.seq > lastSeq).map((event) => ({ ...event, replay: true })),
    };
  }

  checkHeartbeats(maxMissedHeartbeats: number) {
    for (const client of this.clients) {
      if (client.readyState === client.CLOSED || client.readyState === client.CLOSING) {
        this.detach(client);
        continue;
      }
      if (client.readyState !== client.OPEN) continue;
      const missedPongs = this.missedPongs.get(client) || 0;
      if (missedPongs >= maxMissedHeartbeats) {
        client.terminate();
        continue;
      }
      this.missedPongs.set(client, missedPongs + 1);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }

  private readonly missedPongs = new Map<RealtimeSocket, number>();
}

export interface ViewerLeaseSnapshot {
  clientId: string;
  sessionKey: string;
  sockets: number;
  hasReleaseTimer: boolean;
}

interface ViewerLease {
  sessionKey: string;
  sockets: Set<RealtimeSocket>;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export class ViewerLeaseBookkeeper {
  private readonly leases = new Map<string, ViewerLease>();

  constructor(
    private readonly graceMs: number,
    private readonly onAcquire: (sessionKey: string, clientId: string) => void,
    private readonly onRelease: (sessionKey: string, clientId: string) => void,
  ) {}

  acquire(clientId: string, sessionKey: string): ViewerLeaseSnapshot {
    let lease = this.leases.get(clientId);
    const sockets = lease?.sockets || new Set<RealtimeSocket>();
    this.clearTimer(lease?.releaseTimer);
    if (lease && lease.sessionKey !== sessionKey) this.onRelease(lease.sessionKey, clientId);

    lease = { sessionKey, sockets };
    this.leases.set(clientId, lease);
    this.onAcquire(sessionKey, clientId);
    if (sockets.size === 0) this.scheduleRelease(clientId);
    return { clientId, sessionKey, sockets: sockets.size, hasReleaseTimer: Boolean(lease.releaseTimer) };
  }

  bindSocket(clientId: string, socket: RealtimeSocket) {
    const lease = this.leases.get(clientId);
    if (!lease) return;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = undefined;
    lease.sockets.add(socket);
    socket.on("close", () => {
      const current = this.leases.get(clientId);
      current?.sockets.delete(socket);
      if (!current || current.sockets.size > 0) return;
      this.release(clientId);
    });
  }

  release(clientId: string) {
    const lease = this.leases.get(clientId);
    if (!lease) return;
    this.clearTimer(lease.releaseTimer);
    this.leases.delete(clientId);
    this.onRelease(lease.sessionKey, clientId);
  }

  releaseSession(sessionKey: string) {
    for (const [clientId, lease] of this.leases) {
      if (lease.sessionKey !== sessionKey) continue;
      this.clearTimer(lease.releaseTimer);
      this.leases.delete(clientId);
    }
  }

  snapshots(): ViewerLeaseSnapshot[] {
    return Array.from(this.leases, ([clientId, lease]) => ({ clientId, sessionKey: lease.sessionKey, sockets: lease.sockets.size, hasReleaseTimer: Boolean(lease.releaseTimer) }));
  }

  private scheduleRelease(clientId: string) {
    const lease = this.leases.get(clientId);
    if (!lease || lease.sockets.size > 0) return;
    this.clearTimer(lease.releaseTimer);
    lease.releaseTimer = setTimeout(() => this.release(clientId), this.graceMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) clearTimeout(timer);
  }
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function shouldClearUnread(event: unknown): boolean {
  switch (eventRecord(event)?.type) {
    case "agent_start":
    case "compaction_start":
      return true;
    default:
      return false;
  }
}

function shouldMarkUnread(event: unknown): boolean {
  const value = eventRecord(event);
  if (!value || value.aborted || value.willRetry) return false;
  return value.type === "agent_end" || value.type === "compaction_end";
}

function unreadTimestamp(event: unknown): string {
  const value = eventRecord(event);
  for (const candidate of [value?.timestamp, value?.endedAt, value?.startedAt]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return new Date().toISOString();
}

export class UnreadEventBookkeeper {
  constructor(
    private readonly callbacks: {
      notePiEvent: (sessionFile: string, event: unknown) => void;
      clearUnread: (sessionId: string) => void;
      markUnread: (sessionId: string, unreadAt: string) => void;
    },
  ) {}

  handleBroadcast(value: unknown) {
    const data = eventRecord(value);
    if (data?.type !== "pi_event") return;
    const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile.trim() : "";
    if (sessionFile) this.callbacks.notePiEvent(sessionFile, data.event);
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return;
    if (shouldClearUnread(data.event)) {
      this.callbacks.clearUnread(sessionId);
      return;
    }
    if (shouldMarkUnread(data.event)) this.callbacks.markUnread(sessionId, unreadTimestamp(data.event));
  }
}
