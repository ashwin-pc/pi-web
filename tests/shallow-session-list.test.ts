import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shallowListSessions } from "../server/session/shallowList.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("shallow session listing", () => {
  it("projects bounded metadata without depending on transcript body size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-shallow-"));
    roots.push(cwd);
    const directory = join(cwd, "sessions");
    await mkdir(directory);
    const id = "019f328a-bc2c-772b-a095-81b1ad27d054";
    const path = join(directory, `2026-07-05T13-49-40-780Z_${id}.jsonl`);
    const lines = [
      { type: "session", id, timestamp: "2026-07-05T13:49:40.780Z", cwd },
      { type: "message", message: { role: "user", content: [{ type: "text", text: " First   prompt " }] } },
      { type: "session_info", name: "Initial" },
    ].map(JSON.stringify);
    const inflatedBody = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(1024) } })}\n`.repeat(100);
    await writeFile(path, `${lines.join("\n")}\n${inflatedBody}${JSON.stringify({ type: "session_info", name: "Late rename" })}\n`);

    const [info] = await shallowListSessions(cwd, directory);
    expect(info).toMatchObject({ id, cwd, name: "Late rename", firstMessage: "First prompt", created: "2026-07-05T13:49:40.780Z" });
    expect(info.messageCount).toBeUndefined();
  });
});
