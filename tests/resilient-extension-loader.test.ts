import { describe, expect, it, vi } from "vitest";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { ResilientResourceLoader } from "../server/extensions/resilientLoader.js";

function fakeLoader(options: {
  extensions?: string[];
  errors?: Array<{ path: string; error: string }>;
  reload?: ResourceLoader["reload"];
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

  it("reuses the successful primary loader so its reload can invalidate extension source caches", async () => {
    let factoryCalls = 0;
    let primaryReloads = 0;
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => {
        factoryCalls += 1;
        return factoryCalls === 2
          ? fakeLoader({ extensions: ["primary"], reload: async () => { primaryReloads += 1; } })
          : fakeLoader();
      },
    });

    await loader.reload();
    await loader.reload();

    expect(primaryReloads).toBe(2);
    expect(factoryCalls).toBe(2);
    expect(loader.getStatus()).toMatchObject({ state: "ready", attempt: 2, extensionCount: 1 });
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

  it("records an applied trust policy when the primary reload reports extension errors", async () => {
    let trusted = false;
    let factoryCalls = 0;
    const errors = [{ path: "/project/.pi/extensions/failing.ts", error: "failed" }];
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      resolveProjectTrust: () => trusted,
      resolveAdditionalExtensionPaths: (value) => [String(value)],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => {
        factoryCalls += 1;
        return fakeLoader(factoryCalls === 3
          ? { errors }
          : {});
      },
    });

    await loader.reload();
    expect(loader.getAppliedProjectTrust()).toBe(false);

    trusted = true;
    await loader.reload();

    expect(loader.getStatus().state).toBe("degraded");
    expect(loader.getAppliedProjectTrust()).toBe(true);

    await loader.reload();
    expect(loader.getStatus().state).toBe("degraded");
    expect(loader.getAppliedProjectTrust()).toBe(true);
  });

  it("keeps grants pending after fallback, clears denied fallback, and preserves prior state when both fail", async () => {
    let trusted = false;
    let factoryCalls = 0;
    const decisions: boolean[] = [];
    const reload = (fail: boolean): ResourceLoader["reload"] => async (options) => {
      decisions.push(await options!.resolveProjectTrust!({ extensionsResult: {} as any }));
      if (fail) throw new Error("reload failed");
    };
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      resolveProjectTrust: () => trusted,
      resolveAdditionalExtensionPaths: (value) => [String(value)],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => {
        factoryCalls += 1;
        if ([3, 5, 7, 8].includes(factoryCalls)) {
          return fakeLoader({ reload: reload(true) });
        }
        return fakeLoader({ reload: reload(false) });
      },
    });

    await loader.reload();
    expect(loader.getAppliedProjectTrust()).toBe(false);

    trusted = true;
    await loader.reload();
    expect(loader.getStatus().state).toBe("degraded");
    expect({
      desiredTrusted: trusted,
      appliedTrusted: loader.getAppliedProjectTrust(),
      pendingReload: loader.getAppliedProjectTrust() !== trusted,
    }).toEqual({
      desiredTrusted: true,
      appliedTrusted: false,
      pendingReload: true,
    });

    trusted = false;
    await loader.reload();
    expect(loader.getStatus().state).toBe("degraded");
    expect(loader.getAppliedProjectTrust()).toBe(false);

    trusted = true;
    await expect(loader.reload()).rejects.toThrow("reload failed");
    expect(loader.getAppliedProjectTrust()).toBe(false);
    expect(decisions).toEqual([false, true, true, false, false, true, true]);
  });

  it("passes the explicit project-trust resolver to both primary and fallback reloads", async () => {
    const decisions: boolean[] = [];
    let factoryCalls = 0;
    const reload = async (options?: Parameters<ResourceLoader["reload"]>[0]) => {
      decisions.push(await options!.resolveProjectTrust!({ extensionsResult: {} as any }));
      if (factoryCalls === 2) throw new Error("primary failed");
    };
    const loader = new ResilientResourceLoader({
      loaderOptions: { cwd: "/project", agentDir: "/agent" },
      resolveProjectTrust: () => false,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createLoader: () => {
        factoryCalls += 1;
        return fakeLoader({ reload });
      },
    });

    await loader.reload();

    expect(loader.getStatus().state).toBe("degraded");
    expect(decisions).toEqual([false, false]);
  });
});
