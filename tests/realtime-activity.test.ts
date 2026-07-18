import { describe, expect, it } from "vitest";
import { RealtimeHub, type RealtimeSocket } from "../server/realtime.js";
import { SessionActivityTracker } from "../server/session/activity.js";

class MockRealtimeSocket implements RealtimeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly CLOSING = 2;
  readyState = this.OPEN;
  readonly sent: string[] = [];
  pingCount = 0;
  terminateCount = 0;
  private readonly listeners = new Map<"pong" | "close", Array<() => void>>();

  send(data: string) {
    this.sent.push(data);
  }

  ping() {
    this.pingCount++;
  }

  terminate() {
    this.terminateCount++;
  }

  on(event: "pong" | "close", listener: () => void) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: "pong" | "close") {
    for (const listener of this.listeners.get(event) || []) listener();
  }
}

describe("session activity tracking", () => {
  it("decorates tool messages from event-derived timestamps and clears completed tools", () => {
    const tracker = new SessionActivityTracker();
    const session = { sessionId: "session-1", sessionFile: "/tmp/session.jsonl" };

    const start = tracker.decorateSessionEvent(session, session.sessionFile, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(start).toMatchObject({ startedAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z" });
    expect(JSON.parse(JSON.stringify(tracker.decorateMessageContent([
      { type: "toolCall", id: "call-1", toolName: "bash", arguments: { command: "pwd" } },
    ], session.sessionFile)))).toEqual([
      { type: "toolCall", id: "call-1", toolName: "bash", arguments: { command: "pwd" }, startedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(tracker.decorateSessionEvent(session, session.sessionFile, { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash" })).toMatchObject({
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(tracker.decorateMessageContent([{ type: "toolCall", id: "call-1", toolName: "bash" }], session.sessionFile)).toEqual([
      { type: "toolCall", id: "call-1", toolName: "bash" },
    ]);
  });

  it("maintains runtime timestamps from live and replayed events", () => {
    const tracker = new SessionActivityTracker();
    const session = { sessionId: "session-1", sessionFile: "/tmp/session.jsonl" };
    tracker.decorateSessionEvent(session, session.sessionFile, { type: "agent_start", startedAt: "2026-01-01T00:00:00.000Z" });
    expect(tracker.runtimeStartedAtForPath(session.sessionFile, true, session)).toBe("2026-01-01T00:00:00.000Z");
    expect(tracker.runtimeLastActivityAtForPath(session.sessionFile, true, session)).toBe("2026-01-01T00:00:00.000Z");

    tracker.noteEventForUnreadRecovery("/tmp/replayed.jsonl", { type: "agent_start", startedAt: "2026-01-02T00:00:00.000Z" });
    expect(tracker.hasRuntimeStartedAt("/tmp/replayed.jsonl")).toBe(true);
    tracker.noteEventForUnreadRecovery("/tmp/replayed.jsonl", { type: "agent_end" });
    expect(tracker.hasRuntimeStartedAt("/tmp/replayed.jsonl")).toBe(false);
  });
});

describe("realtime replay and heartbeat", () => {
  it("records bounded envelopes and replays the exact missed sequence", () => {
    const hub = new RealtimeHub(2);
    const socket = new MockRealtimeSocket();
    hub.attach(socket);
    hub.broadcast({ type: "one" });
    hub.broadcast({ type: "two" });
    hub.broadcast({ type: "three" });

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "one", seq: 1 },
      { type: "two", seq: 2 },
      { type: "three", seq: 3 },
    ]);
    expect(hub.replaySince(1)).toEqual({
      syncRequired: false,
      latestSeq: 3,
      events: [{ type: "two", seq: 2, replay: true }, { type: "three", seq: 3, replay: true }],
    });
    expect(hub.replaySince(99)).toEqual({ syncRequired: true, latestSeq: 3, events: [] });
  });

  it("tracks pongs and terminates clients after the configured missed heartbeat limit", () => {
    const hub = new RealtimeHub(10);
    const socket = new MockRealtimeSocket();
    hub.attach(socket);
    hub.checkHeartbeats(1);
    expect(socket.pingCount).toBe(1);
    socket.emit("pong");
    hub.checkHeartbeats(1);
    expect(socket.pingCount).toBe(2);
    hub.checkHeartbeats(1);
    expect(socket.terminateCount).toBe(1);
  });
});
