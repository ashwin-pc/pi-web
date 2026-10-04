import { expect, it, vi } from "vitest";
import { exactStop } from "../src/composer/exactStop.js";

it.each([400, 409])("handles exact Stop HTTP %s without retry or rejection", async (status) => {
  const stop = vi.fn(async () => new Response("Execution A is no longer active", { status }));
  const messages: string[] = [];
  const reconcile = vi.fn(async () => { messages.length = 0; });
  await expect(exactStop(stop, (message) => messages.push(message), reconcile)).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(messages).toEqual(["Stop failed: Execution A is no longer active"]);
});
it("handles transport and reconciliation failure without leaking a rejection", async () => {
  const stop = vi.fn(async () => { throw new Error("offline"); });
  const report = vi.fn();
  await expect(exactStop(stop, report, async () => { throw new Error("still offline"); })).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(report.mock.calls).toEqual([["Could not refresh session state: still offline"], ["Stop failed: offline"]]);
});
