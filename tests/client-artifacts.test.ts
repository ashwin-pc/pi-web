import { describe, expect, it, vi } from "vitest";
import { artifactKind, artifactPathOf, artifactsInTranscript, createArtifactsController } from "../src/client/artifacts.js";
import { createMessagesController } from "../src/client/messages.js";
import type { ClientMessage } from "../src/client/types.js";

describe("artifacts", () => {
  it("maps file names to the kinds views lay out", () => {
    expect(["a.png", "r.md", "app.html", "clip.webm", "fix.diff", "part.stl", "scene.glb", "flow.mmd", "song.mp3", "data.csv"].map(artifactKind))
      .toEqual(["image", "markdown", "html", "video", "diff", "model", "model", "diagram", "audio", "other"]);
  });

  it("recognises artifact routes and tool paths, and nothing else", () => {
    expect(artifactPathOf("/api/artifacts/reports/a%20b.md")).toBe("reports/a b.md");
    expect(artifactPathOf("/api/session-artifacts/s1/shots/x.png?v=2")).toBe("shots/x.png");
    expect(artifactPathOf("https://host:8787/api/artifacts/x.png")).toBe("x.png");
    expect(artifactPathOf("/repo/.pi/web/artifacts/vr/index.html", "/repo")).toBe("vr/index.html");
    expect(artifactPathOf("./.pi/web/artifacts/a.stl")).toBe("a.stl");
    expect(artifactPathOf("/repo/src/main.ts", "/repo")).toBeUndefined();
    expect(artifactPathOf("https://example.com/a.png")).toBeUndefined();
  });

  it("finds a session's artifacts in its transcript, with the turn that produced each", () => {
    const messages: ClientMessage[] = [
      { id: "u0", role: "user", text: "Draw it" },
      { id: "a0", role: "assistant", text: "Here: ![chart](/api/artifacts/chart.png) and [the report](/api/session-artifacts/s1/report.md).", toolCalls: [{ name: "write", args: {}, paths: ["/repo/.pi/web/artifacts/part.stl"] }] },
      { id: "u1", role: "user", text: "Again, and compare [the old one](/api/artifacts/old.png)" },
      { id: "a1", role: "assistant", text: "Updated /api/artifacts/chart.png and see /api/artifacts/app/index.html" },
    ];
    expect(artifactsInTranscript("s1", messages, "/repo")).toEqual([
      { id: "chart.png", kind: "image", name: "chart", path: "chart.png", url: "/api/artifacts/chart.png", turn: 0, origin: "linked" },
      { id: "report.md", kind: "markdown", name: "the report", path: "report.md", url: "/api/session-artifacts/s1/report.md", turn: 0, origin: "linked" },
      { id: "part.stl", kind: "model", name: "part.stl", path: "part.stl", url: "/api/session-artifacts/s1/part.stl", turn: 0, origin: "written" },
      { id: "old.png", kind: "image", name: "the old one", path: "old.png", url: "/api/artifacts/old.png", turn: 1, origin: "linked" },
      { id: "app/index.html", kind: "html", name: "index.html", path: "app/index.html", url: "/api/artifacts/app/index.html", turn: 1, origin: "linked" },
    ]);
  });

  it("keeps a live store per session, with sizes and existence from one listing per workspace", async () => {
    let persisted: unknown[] = [{ role: "user", text: "go", entryId: "u" }];
    const messages = createMessagesController({ load: async () => persisted, cwdOf: () => "/repo" });
    const list = vi.fn(async (_sessionId: string, path: string) => path === ".pi/web/artifacts"
      ? { entries: [{ name: "shots", kind: "directory" }, { name: "chart.png", kind: "file", size: 2048 }] }
      : { entries: [{ name: "a.png", kind: "file", size: 10 }] });
    const controller = createArtifactsController({ messages: (id) => messages.get(id), cwdOf: () => "/repo", list });
    const store = controller.get("s1");
    controller.get("s2"); // same workspace: no second listing
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot()).toEqual([]);
    persisted = [...persisted, { role: "assistant", text: "![c](/api/artifacts/chart.png) ![gone](/api/artifacts/gone.png)", entryId: "a" }];
    await messages.get("s1").refresh();
    expect(store.getSnapshot().map((a) => [a.path, a.bytes, a.exists])).toEqual([["chart.png", 2048, true], ["gone.png", undefined, false]]);
    controller.dispose();
  });
});
