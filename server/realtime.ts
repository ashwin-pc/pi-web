import type { WebSocket } from "ws";
import type { SessionActivity } from "./session/activity.js";

type RealtimeSocket = WebSocket & { missedPongs?: number };
export type RealtimeEnvelope = Record<string, unknown> & { seq: number };

export class RealtimeHub {
  private readonly clients = new Set<RealtimeSocket>();
  private readonly eventLog: RealtimeEnvelope[] = [];
  private nextSeq = 1;

  constructor(
    heartbeatMs: number,
    private readonly maxMissedHeartbeats: number,
    private readonly onBroadcast: (value: unknown) => void,
    private readonly maxEventLogSize = 1000,
    private readonly onClientCountChanged?: (count: number) => void,
  ) {
    if (heartbeatMs > 0) {
      const timer = setInterval(() => this.checkHeartbeats(), heartbeatMs);
      timer.unref?.();
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  private record(value: unknown): RealtimeEnvelope {
    const envelope = { ...(typeof value === "object" && value !== null ? value as Record<string, unknown> : { value }), seq: this.nextSeq++ };
    this.eventLog.push(envelope);
    if (this.eventLog.length > this.maxEventLogSize) this.eventLog.splice(0, this.eventLog.length - this.maxEventLogSize);
    return envelope;
  }

  broadcast(value: unknown): void {
    const data = JSON.stringify(this.record(value));
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
    this.onBroadcast(value);
  }

  attach(ws: WebSocket, lastSeq: number): number {
    const client = ws as RealtimeSocket;
    client.missedPongs = 0;
    client.on("pong", () => { client.missedPongs = 0; });
    this.clients.add(client);
    this.onClientCountChanged?.(this.clients.size);

    const latestSeq = this.latestSeq;
    const oldestSeq = this.eventLog[0]?.seq || this.nextSeq;
    if (Number.isFinite(lastSeq) && lastSeq > 0) {
      if (lastSeq > latestSeq || lastSeq < oldestSeq - 1) {
        client.send(JSON.stringify({ type: "sync_required", latestSeq }));
      } else {
        for (const event of this.eventLog) {
          if (event.seq > lastSeq) client.send(JSON.stringify({ ...event, replay: true }));
        }
      }
    }
    client.on("close", () => this.deleteClient(client));
    return latestSeq;
  }

  private deleteClient(client: RealtimeSocket): void {
    if (this.clients.delete(client)) this.onClientCountChanged?.(this.clients.size);
  }

  private checkHeartbeats(): void {
    for (const client of this.clients) {
      if (client.readyState === client.CLOSED || client.readyState === client.CLOSING) {
        this.deleteClient(client);
        continue;
      }
      if (client.readyState !== client.OPEN) continue;
      const missedPongs = client.missedPongs || 0;
      if (missedPongs >= this.maxMissedHeartbeats) {
        client.terminate();
        continue;
      }
      client.missedPongs = missedPongs + 1;
      try { client.ping(); } catch { client.terminate(); }
    }
  }
}

interface SessionUnreadStateStore {
  markUnread(sessionId: string, unreadAt: string): Promise<unknown>;
  markRead(sessionId: string): Promise<unknown>;
}

export class SessionUnreadTracker {
  private readonly abortedRuns = new Map<string, boolean>();

  constructor(
    private readonly store: SessionUnreadStateStore,
    private readonly activity: SessionActivity,
    private readonly emit: (value: unknown) => void,
  ) {}

  handle(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const data = value as Record<string, any>;
    if (data.type !== "agent_event") return;
    const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile.trim() : "";
    if (sessionFile) this.activity.noteEvent(sessionFile, data.event);
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return;
    if (data.event?.type === "agent_start") this.abortedRuns.set(sessionId, false);
    if (data.event?.type === "agent_end") this.abortedRuns.set(sessionId, Boolean(data.event.aborted));
    if (data.event?.type === "agent_start" || data.event?.type === "compaction_start") {
      this.update(this.store.markRead(sessionId), "Could not clear session unread state:");
      return;
    }
    if (!this.shouldMark(data.event, sessionId)) return;
    this.update(this.store.markUnread(sessionId, this.timestamp(data.event)), "Could not mark session unread:");
  }

  markCompleted(sessionId: string, unreadAt = new Date().toISOString()): void {
    this.update(this.store.markUnread(sessionId, unreadAt), "Could not mark session unread:");
  }

  clear(sessionId: string): void {
    this.update(this.store.markRead(sessionId), "Could not clear session unread state:");
  }

  private update(operation: Promise<unknown>, warning: string): void {
    void operation.then((sessionUiState) => this.emit({ type: "session_ui_state_changed", sessionUiState })).catch((error) => console.warn(warning, error));
  }

  private shouldMark(event: any, sessionId: string): boolean {
    if (!event || event.aborted || event.willRetry) return false;
    if (event.type === "agent_settled") {
      const aborted = this.abortedRuns.get(sessionId);
      this.abortedRuns.delete(sessionId);
      return !aborted;
    }
    return event.type === "compaction_end";
  }

  private timestamp(event: any): string {
    for (const value of [event?.timestamp, event?.endedAt, event?.startedAt]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return new Date().toISOString();
  }
}
