import { describe, expect, it, vi } from "vitest";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";

function fakeLoader(options: {
  extensions?: string[];
  errors?: Array<{ path: string; error: string }>;
  reload?: () => Promise<void>;
} = {}): ResourceLoader {
  const extensionNames = options.extensions || [];
  return {
    getExtensions: () => ({
      extensions: extensionNames.map((name) => ({ name })),
      errors: options.errors || [],
      runtime: {},
    }) as ReturnType<ResourceLoader["getExtensions"]>,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: options.reload || (async () => undefined),
  };
}

describe("ResilientResourceLoader", () => {
  it("falls back instead of blocking session startup when extension loading hangs", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let factoryCall = 0;
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      loadTimeoutMs: 20,
      fetchTimeoutMs: 10,
      log,
      createLoader: () => {
        factoryCall += 1;
        if (factoryCall === 2) return fakeLoader({ reload: () => new Promise(() => undefined) });
        return fakeLoader();
      },
    });

    await loader.reload();

    expect(loader.getStatus()).toMatchObject({
      state: "degraded",
      extensionCount: 0,
      errors: [{ path: "<extension loader>", error: "Extension loading timed out after 20ms" }],
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("continuing without extensions"));
  });

  it("switches live resources back to extensions after a successful retry", async () => {
    let factoryCall = 0;
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      loadTimeoutMs: 20,
      fetchTimeoutMs: 10,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => {
        factoryCall += 1;
        if (factoryCall === 2) return fakeLoader({ reload: () => Promise.reject(new Error("provider unavailable")) });
        if (factoryCall === 4) return fakeLoader({ extensions: ["recovered"] });
        return fakeLoader();
      },
    });

    await loader.reload();
    expect(loader.getStatus().state).toBe("degraded");

    await loader.reload();

    expect(loader.getStatus()).toMatchObject({
      state: "ready",
      attempt: 2,
      extensionCount: 1,
      errors: [],
    });
    expect(loader.getExtensions().extensions).toHaveLength(1);
  });

  it("surfaces loader-reported extension paths and errors", async () => {
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => fakeLoader({
        extensions: ["healthy"],
        errors: [{ path: "/agent/extensions/models.ts", error: "provider timed out" }],
      }),
    });

    await loader.reload();

    expect(loader.getStatus()).toMatchObject({
      state: "degraded",
      extensionCount: 1,
      errors: [{ path: "/agent/extensions/models.ts", error: "provider timed out" }],
    });
  });
});
