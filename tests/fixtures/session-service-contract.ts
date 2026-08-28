import { describe, expect, it, vi } from "vitest";
import { jsonRoundTrip, type SessionService, type SessionServiceEvent } from "../../server/session/dto.js";

export type ServiceHarness = { service: SessionService; initialId: string; close(): Promise<void> };
export function describeSessionService(name: string, makeHarness: () => Promise<ServiceHarness>) {
  describe(name, () => {
    it("keeps create, prompt, projections, events, capabilities and JSON parity", async () => {
      const h = await makeHarness();
      try {
        const events: SessionServiceEvent[] = []; h.service.subscribe(event => events.push(event));
        const initial = await h.service.state(h.initialId);
        const created = await h.service.create(h.initialId);
        await h.service.prompt(created.sessionId, { message: "hello transport", mode: "steer", attachments: [] });
        await vi.waitFor(() => expect(events.some(e => e.type === "committed" && e.sessionId === created.sessionId)).toBe(true));
        const state = await h.service.state(created.sessionId); const messages = await h.service.messages(created.sessionId);
        expect(state.capabilities).toEqual(initial.capabilities); expect(messages).toContainEqual(expect.objectContaining({ role: "user", text: "hello transport" }));
        for (const value of [created, state, messages, ...events]) expect(jsonRoundTrip(value)).toStrictEqual(value);
        expect(events.map(e => e.type)).toEqual(expect.arrayContaining(["agent", "committed", "stats"]));
      } finally { await h.close(); }
    });
    it("correlates concurrent requests and preserves serialized errors", async () => {
      const h = await makeHarness(); try {
        const [state, messages] = await Promise.all([h.service.state(h.initialId), h.service.messages(h.initialId)]); expect(state.sessionId).toBe(h.initialId); expect(messages).toEqual([]);
        await expect(h.service.state("missing")).rejects.toMatchObject({ message: expect.stringContaining("Session not found") });
      } finally { await h.close(); }
    });
    it("resolves and cancels interactions through the service contract", async () => {
      const h = await makeHarness(); try {
        const interactions: SessionServiceEvent[] = []; h.service.subscribe(event => { if (event.type === "interaction") interactions.push(event); });
        await h.service.prompt(h.initialId, { message: "request-interaction", mode: "steer", attachments: [] });
        await vi.waitFor(() => expect(interactions).toHaveLength(1));
        const first = interactions[0]; if (!first || first.type !== "interaction") throw new Error("missing interaction");
        await expect(h.service.respondInteraction({ id: first.request.id, confirmed: true })).resolves.toBe(true);
        await h.service.prompt(h.initialId, { message: "request-interaction", mode: "steer", attachments: [] });
        await vi.waitFor(() => expect(interactions).toHaveLength(2));
        const second = interactions[1]; if (!second || second.type !== "interaction") throw new Error("missing interaction");
        await h.service.cancelInteractions();
        await expect(h.service.respondInteraction({ id: second.request.id, confirmed: true })).resolves.toBe(false);
      } finally { await h.close(); }
    });
    it("returns serving-side navigation data without a finish callback", async () => {
      const h = await makeHarness(); try { const value = await h.service.navigate(h.initialId, "missing", {}); expect(value).not.toHaveProperty("finish"); expect(jsonRoundTrip(value)).toStrictEqual(value); } finally { await h.close(); }
    });
  });
}
