import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactDerivations } from "../server/extensions/artifactDerived.js";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import { stlContribution } from "../examples/pi-web-extensions/3d-modeling/stl.js";

// Substitute only the geometry computation: exercise the actual trusted STL
// handler and core/registration bridge, recording the bytes it consumes.
vi.mock("../examples/pi-web-extensions/3d-modeling/stl-edges.js", () => ({
  deriveStlEdges: async (source: string, destination: string) => writeFile(destination, await readFile(source)),
}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("core-bound STL derivation source", () => {
  it.each([false, true])("consumes the streamed legacy file, canonical shadow appears: %s", async shadow => {
    const root = await mkdtemp(join(tmpdir(), "derive-source-")); roots.push(root);
    const legacy = join(root, ".pi-web-uploads/artifacts/model.stl");
    const canonical = join(root, ".pi/web/artifacts/model.stl");
    await mkdir(dirname(legacy), { recursive: true }); await writeFile(legacy, "streamed legacy mesh");
    let ui: any;
    const bridge = createWebUiBridge({ emit: () => {}, clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}), sessionCwd: () => root, state: () => ({}) });
    const session = { sessionId: "one", sessionFile: join(root, "one.jsonl"), agent: { waitForIdle: async () => {} }, bindExtensions: async (options: any) => { ui = options.uiContext; } };
    await bridge.bind(session);
    const contribution = stlContribution(() => root);
    ui.web.contribute("stl", contribution);
    const artifact = { name: "model.stl", path: "/api/session-artifacts/one/model.stl", kind: "file" };
    const view = await bridge.invokeContribution(session, { slot: "artifact-preview", key: "stl", event: { context: artifact } }) as any;
    const store = new ArtifactDerivations();
    const token = store.select({ sessionId: "one", key: "stl", registration: view.registration, artifact, url: artifact.path });
    // The original stream resolver selected legacy while canonical was absent.
    const checkStreamIdentity = store.bind(token, "one", artifact.path, legacy);
    checkStreamIdentity();
    if (shadow) { await mkdir(dirname(canonical), { recursive: true }); await writeFile(canonical, "wrong canonical mesh"); }
    // A forged browser field is not an authority: core creates trusted options.
    const browserBody = { selection: token, key: "stl", source: canonical };
    const output = await store.derive(browserBody.selection, "one", browserBody.key, new AbortController().signal,
      (selection, options) => bridge.deriveArtifactPreview(session, { ...selection, artifact: { ...selection.artifact, source: browserBody.source } } as any, options));
    try { expect(await output.file.readFile("utf8")).toBe("streamed legacy mesh"); }
    finally { await output.cleanup(); }
    expect(JSON.stringify(view)).not.toContain(legacy);
    expect(JSON.stringify(view)).not.toContain(canonical);
  });
});
