import { expect, type APIRequestContext, type Page } from "@playwright/test";

type SessionUiStateSnapshot = { revision: number; initialized: boolean };
type SessionUiStateResponse = { sessionUiState: SessionUiStateSnapshot };

/** Controlled mock fixture only: seed an intentional partial replacement at the current revision. */
export async function seedSessionUiState(page: Page, fields: Record<string, unknown>) {
  const request: APIRequestContext = page.request;
  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await request.get("/api/session-ui-state");
    expect(read.ok(), `Cannot seed UI state: GET returned ${read.status()}`).toBe(true);
    const { sessionUiState } = await read.json() as SessionUiStateResponse;
    expect(Number.isSafeInteger(sessionUiState?.revision) && sessionUiState.revision >= 0).toBe(true);
    expect(typeof sessionUiState.initialized).toBe("boolean");
    const response = await request.patch("/api/session-ui-state", {
      data: { ...fields, expectedRevision: sessionUiState.revision, ...(!sessionUiState.initialized ? { initialize: true } : {}) },
    });
    if (response.status() === 409) continue;
    expect(response.ok(), `Cannot seed UI state: PATCH returned ${response.status()} ${await response.text()}`).toBe(true);
    return;
  }
  throw new Error("Cannot seed UI state: four consecutive revision conflicts in isolated mock fixture");
}
