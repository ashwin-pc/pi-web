import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function loader(cwd: string, agentDir: string, extensionPath: string) {
  return new DefaultResourceLoader({
    cwd, agentDir, additionalExtensionPaths: [extensionPath],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
}

function wavyExtension(result: ReturnType<DefaultResourceLoader["getExtensions"]>) {
  return result.extensions.find((extension) => extension.path.endsWith("wavy/index.ts"));
}

describe("Wavy extension isolation", () => {
  it("registers no Wavy resources when the extension is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "wavy-sdk-off-")); roots.push(root);
    const sdk = loader(root, join(root, "agent"), join(root, "missing-wavy", "index.ts"));
    await sdk.reload();
    const result = sdk.getExtensions();
    expect(wavyExtension(result)).toBeUndefined();
    expect(result.extensions.flatMap((extension) => [...extension.tools.keys()]).filter((name) => name.startsWith("wavy"))).toEqual([]);
  });

  it("loads registration through the real SDK loader and a global-style symlink without evaluating lazy modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "wavy-sdk-isolation-")); roots.push(root);
    const source = resolve(import.meta.dirname, "../..");
    const fixture = join(root, "fixture", "wavy");
    const installed = join(root, "agent", "web-extensions", "wavy");
    await mkdir(fixture, { recursive: true });
    await mkdir(join(root, "agent", "web-extensions"), { recursive: true });
    await Promise.all(["index.ts", "settings.ts", "types.ts"].map((name) => cp(join(source, name), join(fixture, name))));
    // If any of these modules becomes a static import again, SDK discovery fails.
    for (const name of ["store.ts", "engines.ts", "preview.ts"]) await writeFile(join(fixture, name), `throw new Error(${JSON.stringify(`eager ${name}`)});\n`);
    await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await symlink(fixture, installed, process.platform === "win32" ? "junction" : "dir");

    const sdk = loader(root, join(root, "agent"), join(installed, "index.ts"));
    await expect(sdk.reload()).resolves.toBeUndefined();
    const result = sdk.getExtensions();
    expect(result.errors).toEqual([]);
    const extension = wavyExtension(result);
    expect(extension).toBeDefined();
    expect([...extension!.tools.keys()]).toEqual(["wavy", "wavy_status", "wavy_compose", "wavy_render", "wavy_transcribe"]);
    expect([...extension!.handlers.keys()]).toEqual(["resources_discover", "session_start", "session_shutdown"]);
    expect(await readFile(join(fixture, "engines.ts"), "utf8")).toContain("eager engines.ts");
  });

  it("resolves an action-local dynamic import from the real globally symlinked extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "wavy-sdk-dynamic-")); roots.push(root);
    const installed = join(root, "agent", "web-extensions", "wavy");
    await mkdir(join(root, "agent", "web-extensions"), { recursive: true });
    await symlink(resolve(import.meta.dirname, "../.."), installed, process.platform === "win32" ? "junction" : "dir");
    const sdk = loader(root, join(root, "agent"), join(installed, "index.ts"));
    await sdk.reload();
    const result = sdk.getExtensions();
    expect(result.errors).toEqual([]);
    const status = wavyExtension(result)!.tools.get("wavy_status")!.definition;
    const oldPython = process.env.WAVY_SHEETSAGE_PYTHON;
    const oldModel = process.env.WAVY_SHEETSAGE_MODEL;
    delete process.env.WAVY_SHEETSAGE_PYTHON; delete process.env.WAVY_SHEETSAGE_MODEL;
    try {
      const output = await status.execute("isolation", {}, undefined, undefined, { cwd: root } as any);
      const content = output.content[0];
      expect(content.type).toBe("text");
      if (content.type !== "text") throw new Error("expected text status output");
      expect(content.text).toContain('"inferenceValidated": false');
      expect(content.text).toContain("No downloads are performed");
    } finally {
      if (oldPython === undefined) delete process.env.WAVY_SHEETSAGE_PYTHON; else process.env.WAVY_SHEETSAGE_PYTHON = oldPython;
      if (oldModel === undefined) delete process.env.WAVY_SHEETSAGE_MODEL; else process.env.WAVY_SHEETSAGE_MODEL = oldModel;
    }
  });
});
