import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REALTIME_BACKLOG_BYTES, RealtimeHub } from "../server/realtime.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  pings: Buffer[] = [];
  terminate = vi.fn(() => { this.readyState = this.CLOSED; });
  send = vi.fn((data: string) => {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
  });
  ping = vi.fn((data: Buffer) => { this.pings.push(Buffer.from(data)); });
}

const socket = () => new FakeSocket() as unknown as import("ws").WebSocket;

describe("RealtimeHub transport resilience", () => {
  it("terminates accepted sockets when they emit an error", () => {
    const ws = socket();
    const hub = new RealtimeHub(0, 1, () => {});
    hub.attach(ws, 0);
    ws.emit("error", new Error("synthetic socket failure"));
    expect((ws as unknown as FakeSocket).terminate).toHaveBeenCalledOnce();
    expect(hub.clientCount).toBe(1);
    ws.emit("close");
    expect(hub.clientCount).toBe(0);
  });

  it("terminates a slow client before queueing another broadcast", () => {
    const ws = socket();
    const fake = ws as unknown as FakeSocket;
    const hub = new RealtimeHub(0, 1, () => {}, 1000, undefined, 64);
    hub.attach(ws, 0);
    fake.bufferedAmount = 65;
    hub.broadcast({ type: "event", value: "payload" });
    expect(fake.terminate).toHaveBeenCalledOnce();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("allows one large event on an empty queue, then stops queueing more", () => {
    const ws = socket();
    const fake = ws as unknown as FakeSocket;
    const hub = new RealtimeHub(0, 1, () => {}, 1000, undefined, 64);
    hub.attach(ws, 0);
    hub.broadcast({ type: "large", value: "x".repeat(128) });
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.terminate).not.toHaveBeenCalled();
    hub.broadcast({ type: "next" });
    expect(fake.terminate).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledOnce();
  });

  it("keeps realistic state and cumulative tool bursts within the default backlog", () => {
    const ws = socket();
    const fake = ws as unknown as FakeSocket;
    const hub = new RealtimeHub(0, 1, () => {});
    hub.attach(ws, 0);

    for (let index = 0; index < 3; index++) {
      hub.broadcast({
        type: "session_ui_state_changed",
        sessionId: `session-${index}`,
        state: "s".repeat(700 * 1024),
      });
    }
    for (let index = 0; index < 24; index++) {
      hub.broadcast({
        type: "agent_event",
        event: {
          type: "tool_execution_update",
          toolCallId: "tool-call",
          partialResult: "t".repeat(32 * 1024),
        },
      });
    }

    expect(fake.send).toHaveBeenCalledTimes(27);
    expect(fake.bufferedAmount).toBeGreaterThan(1024 * 1024);
    expect(fake.bufferedAmount).toBeLessThan(DEFAULT_REALTIME_BACKLOG_BYTES);
    expect(fake.terminate).not.toHaveBeenCalled();

    fake.bufferedAmount = DEFAULT_REALTIME_BACKLOG_BYTES + 1;
    hub.broadcast({ type: "next" });
    expect(fake.terminate).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledTimes(27);
  });

  it("only accepts the pong for the currently outstanding server ping", () => {
    const bad = socket();
    const badHub = new RealtimeHub(0, 1, () => {});
    badHub.attach(bad, 0);
    (badHub as any).checkHeartbeats();
    bad.emit("pong", Buffer.from("unsolicited"));
    (badHub as any).checkHeartbeats();
    expect((bad as unknown as FakeSocket).terminate).toHaveBeenCalledOnce();

    const good = socket();
    const goodHub = new RealtimeHub(0, 1, () => {});
    goodHub.attach(good, 0);
    (goodHub as any).checkHeartbeats();
    const token = (good as unknown as FakeSocket).pings[0];
    good.emit("pong", token);
    (goodHub as any).checkHeartbeats();
    expect((good as unknown as FakeSocket).terminate).not.toHaveBeenCalled();
    expect((good as unknown as FakeSocket).pings).toHaveLength(2);
  });

  it("keeps a ping token outstanding so a delayed matching pong remains valid", () => {
    const ws = socket();
    const fake = ws as unknown as FakeSocket;
    const hub = new RealtimeHub(0, 2, () => {});
    hub.attach(ws, 0);
    (hub as any).checkHeartbeats();
    const token = fake.pings[0];
    (hub as any).checkHeartbeats();
    expect(fake.pings).toEqual([token]);
    ws.emit("pong", token);
    (hub as any).checkHeartbeats();
    expect(fake.terminate).not.toHaveBeenCalled();
    expect(fake.pings).toHaveLength(2);
  });

  it("replays a bounded set of missed events to a reconnecting client", () => {
    const first = socket();
    const hub = new RealtimeHub(0, 1, () => {}, 1000, undefined, 256);
    hub.attach(first, 0);
    hub.broadcast({ type: "one" });
    hub.broadcast({ type: "two" });

    const reconnect = socket();
    hub.attach(reconnect, 1);
    expect((reconnect as unknown as FakeSocket).sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: "two", seq: 2, replay: true }),
    ]);
  });

  it("requests one sync instead of starting an oversized replay", () => {
    const hub = new RealtimeHub(0, 1, () => {}, 10, undefined, 64);
    hub.broadcast({ type: "baseline" });
    hub.broadcast({ type: "large", value: "x".repeat(128) });
    hub.broadcast({ type: "next" });

    const replay = socket();
    hub.attach(replay, 1);
    const fake = replay as unknown as FakeSocket;
    expect(fake.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "sync_required", latestSeq: 3 },
    ]);
    expect(fake.terminate).not.toHaveBeenCalled();
  });

  it("still terminates an actually slow client before sending replay recovery", () => {
    const hub = new RealtimeHub(0, 1, () => {}, 10, undefined, 64);
    hub.broadcast({ type: "baseline" });
    hub.broadcast({ type: "large", value: "x".repeat(128) });
    const replay = socket();
    const fake = replay as unknown as FakeSocket;
    fake.bufferedAmount = 65;
    hub.attach(replay, 1);
    expect(fake.terminate).toHaveBeenCalledOnce();
    expect(fake.send).not.toHaveBeenCalled();
  });
});
