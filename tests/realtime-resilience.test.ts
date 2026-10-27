import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "../server/realtime.js";

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

  it("still replays missed events to a reconnecting client", () => {
    const first = socket();
    const hub = new RealtimeHub(0, 1, () => {});
    hub.attach(first, 0);
    hub.broadcast({ type: "one" });
    hub.broadcast({ type: "two" });

    const reconnect = socket();
    hub.attach(reconnect, 1);
    expect((reconnect as unknown as FakeSocket).sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: "two", seq: 2, replay: true }),
    ]);
  });

  it("stops a replay once its queued frames cross the backlog bound", () => {
    const hub = new RealtimeHub(0, 1, () => {}, 10, undefined, 64);
    hub.broadcast({ type: "one" });
    hub.broadcast({ type: "two" });
    hub.broadcast({ type: "three" });
    hub.broadcast({ type: "four" });

    const replay = socket();
    hub.attach(replay, 1);
    expect((replay as unknown as FakeSocket).terminate).toHaveBeenCalledOnce();
    expect((replay as unknown as FakeSocket).send.mock.calls.length).toBeGreaterThan(0);
    expect((replay as unknown as FakeSocket).send.mock.calls.length).toBeLessThan(3);
  });

  it("applies the backlog bound to sync-required sends", () => {
    const hub = new RealtimeHub(0, 1, () => {}, 1, undefined, 64);
    hub.broadcast({ type: "one" });
    const stale = socket();
    (stale as unknown as FakeSocket).bufferedAmount = 65;
    hub.attach(stale, 99);
    expect((stale as unknown as FakeSocket).terminate).toHaveBeenCalledOnce();
    expect((stale as unknown as FakeSocket).send).not.toHaveBeenCalled();
  });
});
