import { describe, expect, it } from "vitest";
import { normalizeSessionUiState, shouldMigrateLocalUiState } from "../src/app/types.js";

const localState = normalizeSessionUiState({
  lanes: [{ sessionId: "legacy-pin", lane: "pinned", since: "2025-01-01T00:00:00.000Z" }],
});

describe("session UI state first-run migration", () => {
  it("migrates legacy local state only when the server explicitly reports revision zero", () => {
    expect(shouldMigrateLocalUiState({
      ok: true,
      status: 200,
      sessionUiState: { revision: 0 },
    }, localState)).toBe(true);
  });

  it("does not migrate over an initialized server even when its collections are empty", () => {
    expect(shouldMigrateLocalUiState({
      ok: true,
      status: 200,
      sessionUiState: { revision: 7 },
    }, localState)).toBe(false);
  });

  it("does not migrate after an unauthorized or empty response", () => {
    expect(shouldMigrateLocalUiState({ ok: false, status: 401 }, localState)).toBe(false);
    expect(shouldMigrateLocalUiState({ ok: true, status: 200 }, localState)).toBe(false);
  });
});
