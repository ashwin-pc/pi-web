import { describe, expect, it } from "vitest";
import { mapPiEvent, type HarnessEventDto } from "../server/session/piEventMap.js";
import { pi084Events } from "./fixtures/pi-0.84-events.js";

describe("pi event wire mapping", () => {
  it("maps the recorded pi event surface without cumulative streaming messages", () => {
    const mapped = pi084Events.map(mapPiEvent);
    expect(mapped).toMatchSnapshot();
    const updates = mapped.filter((item) => item.kind === "event" && item.event.type === "message_update");
    expect(updates.map((item) => item.kind === "event" && item.event.type === "message_update" ? item.event.assistantMessageEvent.type : "")).toEqual(["text_start", "text_delta", "text_end"]);
    for (const update of updates) {
      expect(update).not.toHaveProperty("event.message");
      expect(update).not.toHaveProperty("event.assistantMessageEvent.partial");
    }
  });

  it("keeps the open harness escape hatch JSON-round-trip tolerant", () => {
    const event: HarnessEventDto = { type: "harness_event", harness: "future", payload: { type: "new_event", value: 1 } };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
