import { describe, expect, it } from "vitest";
import { cityHomeOf, cityMessagesOf } from "../src/views/vr/cityClient.js";
import type { ClientMessage } from "../src/client/types.js";

describe("VR City adapter", () => {
  it("lays workspace roots out as home, avenues and districts", () => {
    expect(cityHomeOf(["/h/me/oss/pi-web", "/h/me/oss/pi-web-vr/", "/h/me/work/harbor"])).toEqual({
      home: "/h/me",
      avenues: new Map([["oss", ["/h/me/oss/pi-web", "/h/me/oss/pi-web-vr"]], ["work", ["/h/me/work/harbor"]]]),
    });
    // One root: its parent is the avenue, so it is still a district.
    expect(cityHomeOf(["/h/me/oss/pi-web"])).toEqual({ home: "/h/me", avenues: new Map([["oss", ["/h/me/oss/pi-web"]]]) });
    // Nested roots collapse into the outer one; deeper parents become one flattened avenue.
    expect(cityHomeOf(["/h/me/oss/pi-web", "/h/me/oss/pi-web/sub", "/h/me/oss/x/y"])).toEqual({
      home: "/h/me",
      avenues: new Map([["oss", ["/h/me/oss/pi-web"]], ["oss/x", ["/h/me/oss/x/y"]]]),
    });
  });

  it("turns client messages into the City's transcript: tool calls merged with their results", () => {
    const messages: ClientMessage[] = [
      { id: "u", role: "user", text: "Fix it", timestamp: "2026-10-11T09:00:00Z" },
      { id: "a", role: "assistant", text: "Reading **now**.", toolCalls: [{ id: "t1", name: "read", args: { path: "src/a.ts" }, paths: ["/r/src/a.ts"] }, { id: "t2", name: "bash", args: { command: "npm test" }, paths: [] }] },
      { id: "r1", role: "tool", text: "contents", tool: { id: "t1", name: "read", args: { path: "src/a.ts" }, paths: ["/r/src/a.ts"], isError: false } },
      { id: "streaming-0", role: "assistant", text: "Almost", streaming: true },
    ];
    const city = cityMessagesOf(messages, true);
    expect(city.map((m) => [m.type, m.name || "", m.status || "", Boolean(m.streaming)])).toEqual([
      ["user", "", "", false], ["assistant", "", "", false], ["tool", "read", "success", false], ["tool", "bash", "running", false], ["assistant", "", "", true],
    ]);
    expect(city[1].html).toContain("<strong>now</strong>");
    expect(city[2]).toMatchObject({ sub: "/r/src/a.ts", sum: "a.ts", body: "contents", args: { path: "src/a.ts" } });
    expect(city[3]).toMatchObject({ sub: "npm test", args: { command: "npm test" } });
    // A run that is over has no running tools.
    expect(cityMessagesOf(messages, false).some((m) => m.status === "running")).toBe(false);
  });

  it("keeps only the most recent 40 turns", () => {
    const messages: ClientMessage[] = Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, role: "user", text: `turn ${i}` }));
    const city = cityMessagesOf(messages, false);
    expect(city).toHaveLength(40);
    expect(city[0].text).toBe("turn 10");
  });
});
