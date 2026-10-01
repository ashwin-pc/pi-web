import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionsReadTools } from "../server/session/referenceTools.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.find((part) => part.type === "text")?.text || "";
}

function tools(calls: Array<{ reference: unknown; tail: number }> = []) {
  return createSessionsReadTools(async (reference, tail) => {
    calls.push({ reference, tail });
    return {
      reference,
      source: "saved history (may include alternate branches)",
      entries: [{ entryId: reference.entryId || "entry-1", text: "[assistant] line one\n  → read(path: notes)" }],
      truncated: false,
    };
  });
}

describe("native sessions_read", () => {
  it("keeps legacy id/tail input, defaults to 20, and caps it at 200", async () => {
    const calls: Array<{ reference: unknown; tail: number }> = [];
    const read = tools(calls)[0]!;
    expect(Object.keys((read.parameters as any).properties)).toEqual(["id", "tail"]);

    await read.execute("call", { id: "session-1", tail: 999 }, undefined, undefined, undefined as never);
    const result = await read.execute("call", { id: "session-1" }, undefined, undefined, undefined as never);
    expect(text(result)).toContain("/?sessionId=session-1&entryId=entry-1");

    expect(calls).toEqual([
      { reference: { sessionId: "session-1" }, tail: 200 },
      { reference: { sessionId: "session-1" }, tail: 20 },
    ]);
  });

  it("accepts a copied URL in id and treats an entry link as an exact target", async () => {
    const calls: Array<{ reference: unknown; tail: number }> = [];
    const result = await tools(calls)[0]!.execute("call", { id: "https://example.invalid/?sessionId=session-1&entryId=entry-1", tail: 7 }, undefined, undefined, undefined as never);

    expect(calls).toEqual([{ reference: { sessionId: "session-1", entryId: "entry-1" }, tail: 7 }]);
    expect(text(result)).toContain("/?sessionId=session-1&entryId=entry-1");
    expect(result.details).toMatchObject({ sessionId: "session-1", entryId: "entry-1", sessionRefs: [{ sessionId: "session-1", entryId: "entry-1" }] });
  });

  it("throws invalid input and read failures instead of returning a fake error result", async () => {
    const read = tools()[0]!;
    await expect(read.execute("call", { id: "not a session" }, undefined, undefined, undefined as never)).rejects.toThrow("sessions_read: id");
    const failing = createSessionsReadTools(async () => { throw new Error("saved history missing"); })[0]!;
    await expect(failing.execute("call", { id: "session-1" }, undefined, undefined, undefined as never)).rejects.toThrow("saved history missing");
  });

  it("is a single native tool without extensions and propagates SDK-level errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-native-read-"));
    tempDirs.push(cwd);
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      customTools: tools(),
    });

    const names = session.getAllTools().map((tool) => tool.name);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(names.filter((name) => name === "sessions_read")).toHaveLength(1);
    expect(names).not.toContain("read_session");
    const sdkRead = (session.agent.state.tools as Array<{ name: string; execute: Function }>).find((tool) => tool.name === "sessions_read")!;
    await expect(sdkRead.execute("call", { id: "not a session" }, undefined, undefined)).rejects.toThrow("sessions_read: id");
    session.dispose();
  });
});
