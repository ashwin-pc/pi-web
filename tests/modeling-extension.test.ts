import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runCad: vi.fn(), sliceStl: vi.fn() }));
vi.mock("../examples/pi-web-extensions/3d-modeling/cad/core.js", () => ({ runCad: mocks.runCad }));
vi.mock("../examples/pi-web-extensions/3d-modeling/slicing/prusa.js", () => ({ sliceStl: mocks.sliceStl }));
import modelingExtension from "../examples/pi-web-extensions/3d-modeling/index.js";

function setup() {
  const tools: any[] = [];
  const handlers = new Map<string, Function>();
  const pi: any = { registerTool: (tool: any) => tools.push(tool), on: (name: string, handler: Function) => handlers.set(name, handler), exec: vi.fn() };
  modelingExtension(pi);
  return { tools, handlers, pi };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("single CLI-backed modeling extension", () => {
  it("registers only the modeling tool, unconditionally without optional runtimes", () => {
    const { tools } = setup();
    expect(tools.map(t => t.name)).toEqual(["modeling"]);
    expect(mocks.runCad).not.toHaveBeenCalled();
  });

  it("forwards the identical argv, cwd, cancellation and host exec to the shared dispatcher", async () => {
    const { tools, pi } = setup();
    const signal = new AbortController().signal;
    const args = ["fusion", "read", "--json", '{"queryType":"activeCommand"}'];
    mocks.runCad.mockResolvedValue({ activeCommand: null });
    const result = await tools[0].execute("call", { args }, signal, undefined, { cwd: "/workspace" });
    expect(mocks.runCad).toHaveBeenCalledWith(args, { cwd: "/workspace", signal, exec: expect.any(Function) });
    await mocks.runCad.mock.calls[0][1].exec("program", ["arg"]);
    expect(pi.exec).toHaveBeenCalledWith("program", ["arg"]);
    expect(result.details).toEqual({ activeCommand: null });
  });

  it("propagates failed commands instead of marking them successful", async () => {
    const { tools } = setup();
    mocks.runCad.mockRejectedValue(new Error("Mutation requires acknowledgement"));
    await expect(tools[0].execute("call", { args: ["fusion", "undo"] }, undefined, undefined, { cwd: "/workspace" })).rejects.toThrow("acknowledgement");
  });

  it("keeps STL/G-code previews and routes the Slice action to the canonical slicer", async () => {
    const { handlers } = setup();
    const contribute = vi.fn();
    const context = { cwd: "/workspace", ui: { web: { capabilities: { slots: ["artifact-preview", "artifact-action"], kinds: ["rendered"] }, contribute } } };
    handlers.get("session_start")!({}, context);
    expect(contribute.mock.calls.map(c => c[0])).toEqual(["gcode-viewer.preview", "stl-viewer.preview", "3d-modeling.slice"]);
    const sliceAction = contribute.mock.calls.find(c => c[0] === "3d-modeling.slice")![1];
    mocks.sliceStl.mockResolvedValue({ url: "/api/artifacts/model.gcode", bytes: 123 });
    const rendered = await sliceAction.render({ context: { name: "model.stl", path: "/api/artifacts/model.stl" } });
    expect(mocks.sliceStl).toHaveBeenCalledWith(expect.anything(), "/workspace", expect.objectContaining({ input: "model.stl", output: "model.gcode" }));
    expect(rendered.markdown).toContain("/api/artifacts/model.gcode");
    handlers.get("session_shutdown")!({}, context);
    expect(contribute.mock.calls.slice(-3).map(c => [c[0], c[1]])).toEqual([["gcode-viewer.preview", undefined], ["stl-viewer.preview", undefined], ["3d-modeling.slice", undefined]]);
  });

  it("does not require browser UI to register the CLI tool", () => {
    const { handlers, tools } = setup();
    expect(() => handlers.get("session_start")!({}, { cwd: "/workspace" })).not.toThrow();
    expect(tools).toHaveLength(1);
  });
});
