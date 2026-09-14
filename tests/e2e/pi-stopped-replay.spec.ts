import { readFileSync } from "node:fs";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { simplifyMessage } from "../../server/session/projection.js";

// Captured-data replay only. No provider calls or actual canary rerun.
const captured = JSON.parse(readFileSync(new URL("../fixtures/pi-stopped-capture/after-stop-messages.json", import.meta.url), "utf8"));
const aborted = captured.at(-1).raw;
const partial = aborted.content.find((part: any) => part.type === "text").text;

async function replay(page: Page, messages: any[]) {
  await page.request.post("/api/mock/reset");
  let socket!: WebSocketRoute;
  await page.routeWebSocket("**/ws**", (ws) => { socket = ws; });
  await page.route("**/api/messages?**", (route) => route.fulfill({ json: { messages: messages.map((message) => simplifyMessage(message)) } }));
  await page.goto("/");
  await expect(page.locator(".message.assistant", { hasText: "Pi canary starting." })).toHaveCount(1);
  return {
    event: (event: Record<string, unknown>) => socket.send(JSON.stringify({ type: "agent_event", event })),
    settle: () => { messages.push(aborted); },
  };
}

async function retainedCapture(page: Page) {
  await expect(page.locator(".message.assistant", { hasText: "Sort books alphabetically by author surname." })).toHaveCount(1);
  await expect(page.locator('.toolCard[data-tool-name="read"]')).toHaveCount(1);
  const bodies = await page.locator(".message.assistant > .body").allTextContents();
  expect(bodies.join("\n")).toContain("PI92_ACTUAL_cf729ea61ce073b5");
  expect(bodies.join("\n")).toContain("This makes a known author");
  const incomplete = page.locator(".runtimeErrorCard", { hasText: "response incomplete" });
  await expect(incomplete).toHaveCount(1);
  await expect(incomplete).toContainText("interrupted");
  await expect(incomplete.locator(".runtimeErrorAction", { hasText: "Continue" })).toBeVisible();
  await expect(page.locator(".runtimeErrorCard", { hasText: "assistant error" })).toHaveCount(0);
  await expect(page.locator(".runtimeErrorCard", { hasText: "response failed" })).toHaveCount(0);
  await expect(page.locator("#messages")).not.toContainText(aborted.errorMessage);
  const order = await page.locator(".message.assistant, .toolCard").allTextContents();
  expect(order.findIndex((text) => text.includes("Pi canary starting."))).toBeLessThan(order.findIndex((text) => text.includes("read")));
  expect(order.findIndex((text) => text.includes("read"))).toBeLessThan(order.findIndex((text) => text.includes("Sort books alphabetically")));
}

test("captured Pi abort: partial prose survives live message_end, settlement and browser reload", async ({ page }) => {
  const control = await replay(page, captured.slice(0, -1).map((message: any) => message.raw));
  control.event({ type: "agent_start" });
  await expect(page.locator("#stopButton")).toBeVisible();
  control.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: partial } });
  await expect(page.locator(".message.assistant", { hasText: "Sort books alphabetically" })).toHaveCount(1);
  control.event({ type: "message_end", message: aborted });
  // A following event provides an observable boundary after message_end in the
  // ordered WebSocket stream. It is replay control, not captured model output.
  control.event({ type: "tool_execution_start", toolCallId: "replay-barrier", toolName: "replay barrier", args: {} });
  await expect(page.locator('.toolCard[data-tool-name="replay barrier"]')).toHaveCount(1);
  await expect(page.locator(".runtimeErrorCard")).toHaveCount(0);
  control.settle();
  control.event({ type: "agent_end", aborted: true, messages: [aborted] });
  control.event({ type: "agent_settled" });
  await expect(page.locator("#stopButton")).toBeHidden();
  await retainedCapture(page);
  await page.reload();
  await retainedCapture(page);
});

test("synthetic abort keeps visible thinking and completed tool parts without retry grouping", async ({ page }) => {
  const synthetic = { role: "assistant", stopReason: "aborted", errorMessage: "503 Service unavailable", content: [
    { type: "text", text: "Pi canary starting." },
    { type: "thinking", thinking: "Visible synthetic thinking." },
    { type: "toolCall", id: "synthetic-read", name: "read", arguments: { path: "synthetic.txt" } },
    { type: "text", text: "Synthetic partial answer." },
    { type: "toolCall", id: "synthetic-unfinished", name: "grep", arguments: { pattern: "unfinished", path: "synthetic.txt" } },
  ] };
  await replay(page, [
    { role: "user", content: "Synthetic prompt" },
    synthetic,
    { role: "toolResult", toolCallId: "synthetic-read", toolName: "read", content: "Synthetic tool output." },
  ]);
  for (let reload = 0; reload < 2; reload++) {
    await expect(page.locator(".toolCard--thinking")).toContainText("Visible synthetic thinking.");
    await expect(page.locator('.toolCard[data-tool-name="read"]')).toHaveCount(1);
    const unfinished = page.locator('.toolCard[data-tool-name="grep"]');
    await expect(unfinished).toHaveCount(1);
    await expect(unfinished).not.toHaveClass(/toolCard--running|toolCard--success/);
    const expand = unfinished.locator('.toolCardExpandToggle[aria-expanded="false"]');
    if (await expand.isVisible()) await expand.click();
    await expect(unfinished).toContainText("Tool call interrupted before a result was recorded.");
    await expect(page.locator(".message.assistant", { hasText: "Synthetic partial answer." })).toHaveCount(1);
    await expect(page.locator(".runtimeErrorCard", { hasText: /assistant error|response failed|retrying/ })).toHaveCount(0);
    await page.reload();
  }
});
