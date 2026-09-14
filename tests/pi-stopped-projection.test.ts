import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isAssistantAbortedMessage, isAssistantFailureMessage, projectMessages, simplifyMessage } from "../server/session/projection.js";
import { messageText } from "../src/messages/content.js";
import type { PiWebSession } from "../server/types.js";

const fixture = new URL("./fixtures/pi-stopped-capture/", import.meta.url);
const captured = JSON.parse(await readFile(new URL("after-stop-messages.json", fixture), "utf8"));
const aborted = captured.at(-1).raw;
const partialText = aborted.content.find((part: any) => part.type === "text").text;

it("preserves the unchanged captured Pi abort instead of classifying its transport diagnostic as failure", () => {
  expect(aborted.stopReason).toBe("aborted");
  expect(aborted.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
  const projected = simplifyMessage(aborted)!;
  expect(projected.raw).toEqual(aborted);
  expect(projected.text).toContain(partialText);
  expect(projected.isError).toBe(false);
  for (const message of [aborted, projected, captured.at(-1)]) {
    expect(isAssistantAbortedMessage(message)).toBe(true);
    expect(isAssistantFailureMessage(message)).toBe(false);
    expect(messageText(message)).toContain(partialText);
    expect(messageText(message)).not.toContain(aborted.errorMessage);
  }
});

it("cold-opens captured data through public Pi SessionManager without inference (captured-data replay)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stopped-replay-"));
  try {
    const file = join(root, "capture.jsonl");
    await copyFile(new URL("owned-pi-session.jsonl", fixture), file);
    const original = await readFile(file, "utf8");
    for (let open = 0; open < 2; open++) {
      const sessionManager = SessionManager.open(file, root);
      const messages = sessionManager.buildSessionContext().messages;
      expect(messages).toEqual(captured.map((message: any) => message.raw));
      const projected = projectMessages({ sessionManager, messages } as PiWebSession);
      expect(projected.at(-1)).toMatchObject({ isError: false, raw: aborted });
      expect(projected.at(-1)!.text).toContain(partialText);
      expect(projected[1].toolCalls).toEqual(captured[1].toolCalls);
      expect(projected[2].text).toBe(captured[2].text);
    }
    expect(await readFile(file, "utf8")).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([undefined, "error", "length"])("keeps genuine failure behavior for stopReason %s (synthetic)", (stopReason) => {
  const message = { role: "assistant", content: "Partial", stopReason, errorMessage: "503 Service unavailable" };
  expect(isAssistantFailureMessage(message)).toBe(true);
  expect(isAssistantAbortedMessage(message)).toBe(false);
  expect(simplifyMessage(message)).toMatchObject({ isError: true, text: "Service unavailable (503)" });
  expect(messageText(message)).toBe("Service unavailable (503)");
});
