import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "../server/realtime.js";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

function socket() {
  const ws = Object.assign(new EventEmitter(), { send: vi.fn(), readyState: 1, OPEN: 1 });
  return { ws: ws as unknown as WebSocket, sent: ws.send };
}

describe("host recovery checkpoints", () => {
  it("requires a snapshot after host restart even when numerical cursors overlap", () => {
    const old = new RealtimeHub(0, 3, vi.fn());
    for (let index = 0; index < 100; index++) old.broadcast({ type: "state_changed" });
    const cursor = old.checkpoint();
    const restarted = new RealtimeHub(0, 3, vi.fn());
    for (let index = 0; index < 150; index++) restarted.broadcast({ type: "state_changed" });
    const client = socket();
    restarted.attach(client.ws, cursor.seq, cursor.epoch);
    expect(client.sent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.sent.mock.calls[0]![0])).toEqual({ type: "sync_required", latestSeq: 150, epoch: restarted.epoch });
  });

  it("replays a matching epoch and explicitly snapshots legacy positive cursors", () => {
    const hub = new RealtimeHub(0, 3, vi.fn());
    hub.broadcast({ type: "state_changed", value: 1 });
    hub.broadcast({ type: "state_changed", value: 2 });
    const matching = socket();
    hub.attach(matching.ws, 1, hub.epoch);
    expect(matching.sent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(matching.sent.mock.calls[0]![0])).toMatchObject({ seq: 2, replay: true, value: 2 });
    const legacy = socket();
    hub.attach(legacy.ws, 1);
    expect(JSON.parse(legacy.sent.mock.calls[0]![0])).toMatchObject({ type: "sync_required", epoch: hub.epoch });
    const initial = socket();
    hub.attach(initial.ws, 0);
    expect(initial.sent).not.toHaveBeenCalled();
    const emptyRestart = socket();
    hub.attach(emptyRestart.ws, 0, "old-epoch");
    expect(JSON.parse(emptyRestart.sent.mock.calls[0]![0])).toMatchObject({ type: "sync_required", epoch: hub.epoch });
  });
  it("replays retained events from a known matching epoch at zero", () => {
    const hub = new RealtimeHub(0, 3, vi.fn());
    const cursor = hub.checkpoint();
    expect(cursor.seq).toBe(0);
    hub.broadcast({ type: "state_changed", value: "missed after hello at zero" });
    const resumed = socket();
    hub.attach(resumed.ws, cursor.seq, cursor.epoch);
    expect(resumed.sent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resumed.sent.mock.calls[0]![0])).toEqual({ type: "state_changed", value: "missed after hello at zero", seq: 1, replay: true });
    const initial = socket();
    hub.attach(initial.ws, 0);
    expect(initial.sent).not.toHaveBeenCalled();
  });

  it("requires recovery when a known zero cursor's prefix was truncated", () => {
    const hub = new RealtimeHub(0, 3, vi.fn(), 1);
    hub.broadcast({ type: "state_changed", value: 1 });
    hub.broadcast({ type: "state_changed", value: 2 });
    const resumed = socket();
    hub.attach(resumed.ws, 0, hub.epoch);
    expect(resumed.sent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resumed.sent.mock.calls[0]![0])).toEqual({ type: "sync_required", latestSeq: 2, epoch: hub.epoch });
    const initial = socket();
    hub.attach(initial.ws, 0);
    expect(initial.sent).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid sequence cursor %s rather than silently skipping replay", (cursor) => {
    const hub = new RealtimeHub(0, 3, vi.fn());
    for (const epoch of [undefined, hub.epoch]) {
      const invalid = socket();
      hub.attach(invalid.ws, cursor, epoch);
      expect(invalid.sent).toHaveBeenCalledTimes(1);
      expect(JSON.parse(invalid.sent.mock.calls[0]![0])).toEqual({ type: "sync_required", latestSeq: 0, epoch: hub.epoch });
    }
  });

  it("orders browser fanout independently of source generations", () => {
    const first = new RealtimeHub(0, 3, vi.fn());
    const second = new RealtimeHub(0, 3, vi.fn());
    const initial = first.checkpoint();
    first.broadcast({ type: "agent_event", source: { generation: "runner-1", cursor: 99 }, event: { type: "message_end" } });
    first.broadcast({ type: "agent_event", source: { generation: "runner-2", cursor: 1 } });
    expect(first.checkpoint()).toEqual({ epoch: initial.epoch, seq: initial.seq + 2 });
    expect(second.checkpoint().epoch).not.toBe(initial.epoch);
  });
});
