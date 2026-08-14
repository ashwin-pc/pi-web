import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import { createSettingsStore } from "../server/settings.js";
import type { PiWebSettingsRegistration } from "../src/extensions.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeBridge() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-webui-"));
  tempDirs.push(dir);
  const realStore = createSettingsStore(join(dir, "settings.json"));
  let failWrite = false;
  /** Arm exactly one extension-write failure (used to simulate a bad disk). */
  const armWriteFailure = () => { failWrite = true; };
  const settingsStore = {
    ...realStore,
    patchExtension: (...args: Parameters<typeof realStore.patchExtension>) => {
      if (failWrite) {
        failWrite = false;
        return Promise.reject(new Error("disk full"));
      }
      return realStore.patchExtension(...args);
    },
  } as typeof realStore;
  const emitted: unknown[] = [];
  const bridge = createWebUiBridge({
    emit: (value) => emitted.push(value),
    clientCount: () => 1,
    withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
    createNewSession: async () => ({}),
    sessionCwd: () => "/repo",
    state: () => ({}),
    settingsStore,
    modelOptions: () => new Set(["anthropic:fast-1"]),
  });
  return { bridge, settingsStore, emitted, armWriteFailure };
}

/** A fake pi-web session object; identity is what the registry keys on. */
function makeSession(sessionId: string) {
  return { sessionId } as any;
}

function schemaFor(id: string, extra: Partial<PiWebSettingsRegistration> = {}): PiWebSettingsRegistration {
  return {
    id,
    title: "Demo",
    schemaVersion: 1,
    fields: [{ key: "tier", type: "text", label: "Tier" }],
    ...extra,
  };
}

async function register(bridge: any, session: any, schema: PiWebSettingsRegistration) {
  return bridge.registerSettings(session, schema);
}

describe("extension settings registry", () => {
  it("rejects a schema whose owner id is not namespaced", async () => {
    const { bridge } = await makeBridge();
    const result = await register(bridge, makeSession("s1"), schemaFor("nodots"));
    expect(result.registered).toBe(false);
    expect(result.error).toMatch(/namespaced/);
    expect(bridge.settingsSchemas()).toHaveLength(0);
  });

  it("rejects structurally invalid descriptors before reserving the id", async () => {
    const { bridge } = await makeBridge();
    const bad = await register(bridge, makeSession("s1"), schemaFor("demo.x", { fields: [{ key: "a", type: "nope" as any, label: "A" }] }));
    expect(bad.registered).toBe(false);
    expect(bad.error).toMatch(/unsupported field type/);
    // The id must remain claimable after a rejected registration.
    const good = await register(bridge, makeSession("s2"), schemaFor("demo.x"));
    expect(good.registered).toBe(true);
  });

  it("rejects nested list fields that the client cannot render", async () => {
    // Removing the server-side nested-list guard makes this registration
    // succeed and exposes values the client cannot safely edit.
    const { bridge } = await makeBridge();
    const result = await register(bridge, makeSession("s1"), schemaFor("demo.x", {
      fields: [{
        key: "groups",
        type: "list",
        label: "Groups",
        itemFields: [{
          key: "members",
          type: "list",
          label: "Members",
          itemFields: [{ key: "name", type: "text", label: "Name" }],
        }],
      }],
    }));

    expect(result.registered).toBe(false);
    expect(result.error).toMatch(/nested list fields are not supported/);
    expect(bridge.settingsSchemas()).toHaveLength(0);
  });

  it("migrates once when two sessions register the same schema concurrently", async () => {
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    const migrate = vi.fn(async () => ({ tier: "new" }));
    const schema = schemaFor("demo.x", { schemaVersion: 2, migrate });

    const [a, b] = await Promise.all([
      register(bridge, makeSession("s1"), schema),
      register(bridge, makeSession("s2"), schema),
    ]);

    expect(a.registered).toBe(true);
    expect(b.registered).toBe(true);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(bridge.settingsSchemas()).toHaveLength(1);
    expect((await settingsStore.read()).extensions?.["demo.x"]?.values).toEqual({ tier: "new" });
  });

  it("keeps the first schema when a divergent one claims the same id", async () => {
    const { bridge } = await makeBridge();
    await register(bridge, makeSession("s1"), schemaFor("demo.x"));
    const divergent = await register(bridge, makeSession("s2"), schemaFor("demo.x", {
      fields: [{ key: "other", type: "toggle", label: "Other" }],
    }));

    expect(divergent.registered).toBe(false);
    expect(divergent.error).toMatch(/already registered/);
    const [descriptor] = bridge.settingsSchemas() as any[];
    expect(descriptor.fields[0].key).toBe("tier");
  });

  it("keeps a schema live until the last registrant shuts down", async () => {
    const { bridge } = await makeBridge();
    const first = makeSession("s1");
    const second = makeSession("s2");
    await register(bridge, first, schemaFor("demo.x"));
    await register(bridge, second, schemaFor("demo.x"));

    bridge.releaseSessionSettings(first);
    expect(bridge.settingsSchemas()).toHaveLength(1); // still registered by s2

    bridge.releaseSessionSettings(second);
    expect(bridge.settingsSchemas()).toHaveLength(0);
  });

  it("broadcasts only when the published schema list changes", async () => {
    // Restoring an unconditional registration/release broadcast increases the
    // counts below when an equivalent session joins or a non-last one leaves.
    const { bridge, emitted } = await makeBridge();
    const first = makeSession("s1");
    const second = makeSession("s2");
    const schema = schemaFor("demo.x");
    const broadcasts = () => emitted.filter((event: any) => event?.type === "web_settings_schemas_changed") as any[];

    await register(bridge, first, schema);
    expect(broadcasts()).toHaveLength(1);
    expect(broadcasts()[0].webSettingsSchemas).toHaveLength(1);

    await register(bridge, second, schema);
    expect(broadcasts()).toHaveLength(1); // identical published descriptor

    bridge.releaseSessionSettings(first);
    expect(broadcasts()).toHaveLength(1); // second keeps it published

    bridge.releaseSessionSettings(second);
    expect(broadcasts()).toHaveLength(2);
    expect(broadcasts()[1].webSettingsSchemas).toHaveLength(0);
  });

  it("notifies every live registrant with its own callback and session id", async () => {
    const { bridge } = await makeBridge();
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    await register(bridge, makeSession("s1"), schemaFor("demo.x", { onChange: firstChange }));
    await register(bridge, makeSession("s2"), schemaFor("demo.x", { onChange: secondChange }));

    bridge.notifySettingsChanged("demo.x", { tier: "fast" });

    expect(firstChange).toHaveBeenCalledWith({ tier: "fast" }, { sessionId: "s1" });
    expect(secondChange).toHaveBeenCalledWith({ tier: "fast" }, { sessionId: "s2" });
  });

  it("stops notifying a registrant once its session shuts down", async () => {
    const { bridge } = await makeBridge();
    const goneChange = vi.fn();
    const liveChange = vi.fn();
    const gone = makeSession("s1");
    await register(bridge, gone, schemaFor("demo.x", { onChange: goneChange }));
    await register(bridge, makeSession("s2"), schemaFor("demo.x", { onChange: liveChange }));

    bridge.releaseSessionSettings(gone);
    bridge.notifySettingsChanged("demo.x", { tier: "fast" });

    expect(goneChange).not.toHaveBeenCalled();
    expect(liveChange).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing onChange without skipping other registrants", async () => {
    const { bridge } = await makeBridge();
    const good = vi.fn();
    await register(bridge, makeSession("s1"), schemaFor("demo.x", { onChange: () => { throw new Error("boom"); } }));
    await register(bridge, makeSession("s2"), schemaFor("demo.x", { onChange: good }));

    expect(() => bridge.notifySettingsChanged("demo.x", { tier: "fast" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("does not register a session that shut down while migration was in flight", async () => {
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    const session = makeSession("s1");
    let releaseMigration: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseMigration = resolve; });
    const schema = schemaFor("demo.x", {
      schemaVersion: 2,
      migrate: async () => { await gate; return { tier: "new" }; },
    });

    const pending = register(bridge, session, schema);
    bridge.releaseSessionSettings(session); // session dies mid-migration
    releaseMigration();
    const result = await pending;

    expect(result.registered).toBe(false);
    expect(result.error).toMatch(/shut down/);
    expect(bridge.settingsSchemas()).toHaveLength(0); // no dead-session registration left behind
  });

  it("falls back to defaults and surfaces an error when migration throws", async () => {
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    const result = await register(bridge, makeSession("s1"), schemaFor("demo.x", {
      schemaVersion: 2,
      migrate: async () => { throw new Error("bad migration"); },
    }));

    expect(result.registered).toBe(true);
    expect(result.usedBackup).toBe(true);
    expect(result.error).toMatch(/bad migration/);

    const stored = (await settingsStore.read()).extensions?.["demo.x"];
    expect(stored?.values).toEqual({ tier: "" });                  // defaults
    expect(stored?.backup?.values).toEqual({ tier: "old" });        // original preserved
    const [descriptor] = bridge.settingsSchemas() as any[];
    expect(descriptor.migrationError).toMatch(/bad migration/);     // visible to the UI
  });

  it("hides a schema from validation and transport until migration settles", async () => {
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    let releaseMigration: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseMigration = resolve; });
    const pending = register(bridge, makeSession("s1"), schemaFor("demo.x", {
      schemaVersion: 2,
      migrate: async () => { await gate; return { tier: "new" }; },
    }));

    expect(bridge.settingsSchemas()).toHaveLength(0);
    expect(bridge.settingsSchemaEntry("demo.x")).toBeUndefined();

    releaseMigration();
    await pending;
    expect(bridge.settingsSchemas()).toHaveLength(1);
    expect(bridge.settingsSchemaEntry("demo.x")).toBeDefined();
  });
});

describe("extension settings registry — failure corner cases", () => {
  it("does not let an in-flight registration overwrite a divergent replacement", async () => {
    // Removing the pending-release guard changes the canonical winner; restoring
    // blind stale reattachment too lets both callers succeed while one is invisible.
    const { bridge } = await makeBridge();
    const first = makeSession("s1");
    const joiner = makeSession("s2");
    const divergent = makeSession("s3");
    const joinerChange = vi.fn();
    const divergentChange = vi.fn();
    const canonical = schemaFor("demo.x", { onChange: joinerChange });

    expect((await register(bridge, first, canonical)).registered).toBe(true);
    const joining = register(bridge, joiner, canonical); // awaits the settled shared migration
    bridge.releaseSessionSettings(first);
    const diverging = register(bridge, divergent, schemaFor("demo.x", {
      fields: [{ key: "other", type: "toggle", label: "Other" }],
      onChange: divergentChange,
    }));

    const [joinResult, divergentResult] = await Promise.all([joining, diverging]);
    expect(joinResult.registered).toBe(true);
    expect(divergentResult.registered).toBe(false);
    expect(divergentResult.error).toMatch(/different schema/);
    expect(bridge.settingsSchemas()).toHaveLength(1);
    expect((bridge.settingsSchemas() as any[])[0].fields[0].key).toBe("tier");
    expect(bridge.settingsSchemaEntry("demo.x")).toBeDefined();

    bridge.notifySettingsChanged("demo.x", { tier: "fast" });
    expect(joinerChange).toHaveBeenCalledWith({ tier: "fast" }, { sessionId: "s2" });
    expect(divergentChange).not.toHaveBeenCalled();
  });

  it("keeps same-schema registrations visible and notifiable across an in-flight release", async () => {
    // Restoring pending-entry deletion plus blind continuation reattachment makes
    // one successful same-schema registrant disappear from notifications.
    const { bridge } = await makeBridge();
    const first = makeSession("s1");
    const second = makeSession("s2");
    const third = makeSession("s3");
    const secondChange = vi.fn();
    const thirdChange = vi.fn();
    const secondSchema = schemaFor("demo.x", { onChange: secondChange });
    const thirdSchema = schemaFor("demo.x", { onChange: thirdChange });

    expect((await register(bridge, first, secondSchema)).registered).toBe(true);
    const secondRegistration = register(bridge, second, secondSchema);
    bridge.releaseSessionSettings(first);
    const thirdRegistration = register(bridge, third, thirdSchema);

    const [secondResult, thirdResult] = await Promise.all([secondRegistration, thirdRegistration]);
    expect(secondResult.registered).toBe(true);
    expect(thirdResult.registered).toBe(true);
    expect(bridge.settingsSchemas()).toHaveLength(1);
    expect(bridge.settingsSchemaEntry("demo.x")).toBeDefined();

    bridge.notifySettingsChanged("demo.x", { tier: "fast" });
    expect(secondChange).toHaveBeenCalledWith({ tier: "fast" }, { sessionId: "s2" });
    expect(thirdChange).toHaveBeenCalledWith({ tier: "fast" }, { sessionId: "s3" });
  });

  it("skips a migration write when a concurrent reset changes the revision", async () => {
    // Removing expectedRevision from migration writes makes the migration
    // silently recreate and overwrite the record reset inside migrate().
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    const result = await register(bridge, makeSession("s1"), schemaFor("demo.x", {
      schemaVersion: 2,
      migrate: async () => {
        await settingsStore.resetExtension("demo.x", 1);
        return { tier: "migrated" };
      },
    }));

    expect(result.registered).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.usedBackup).toBe(false);
    expect(result.error).toMatch(/migration skipped.*changed concurrently/i);
    expect((await settingsStore.read()).extensions?.["demo.x"]).toBeUndefined();
  });

  it("keeps the owner id usable after a migration write fails", async () => {
    // Regression: the migration promise is shared by every registration of an
    // id, so a rejected store write used to poison that id until restart.
    const { bridge, settingsStore, armWriteFailure } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });
    armWriteFailure(); // the migration's write is the one that fails

    const schema = schemaFor("demo.x", { schemaVersion: 2, migrate: async () => ({ tier: "new" }) });
    const first = await register(bridge, makeSession("s1"), schema);
    expect(first.error).toMatch(/disk full/);

    // A later session must still be able to register the same id.
    const second = await register(bridge, makeSession("s2"), schema);
    expect(second.registered).toBe(true);
    expect(bridge.settingsSchemas()).toHaveLength(1);
  });

  it("does not drop the entry when the reserving session dies while another is still registering", async () => {
    // Regression: the disposed reserver deleted the entry while a concurrent
    // registrant was still awaiting migration; that registrant was told it had
    // registered while its schema stayed invisible forever.
    const { bridge, settingsStore } = await makeBridge();
    await settingsStore.patchExtension("demo.x", { tier: "old" }, { schemaVersion: 1, expectedRevision: 0 });

    let releaseMigration: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseMigration = resolve; });
    const schema = schemaFor("demo.x", {
      schemaVersion: 2,
      migrate: async () => { await gate; return { tier: "new" }; },
    });

    const reserver = makeSession("s1");
    const joiner = makeSession("s2");
    const reserverRegistration = register(bridge, reserver, schema);
    const joinerRegistration = register(bridge, joiner, schema);

    bridge.releaseSessionSettings(reserver); // reserver dies mid-migration
    releaseMigration();

    const [reserverResult, joinerResult] = await Promise.all([reserverRegistration, joinerRegistration]);
    expect(reserverResult.registered).toBe(false);
    expect(joinerResult.registered).toBe(true);

    // The surviving registrant must be visible and notifiable.
    expect(bridge.settingsSchemas()).toHaveLength(1);
    expect(bridge.settingsSchemaEntry("demo.x")).toBeDefined();
    const onChange = vi.fn();
    await register(bridge, joiner, schemaFor("demo.x", { schemaVersion: 2, migrate: async () => ({ tier: "new" }), onChange }));
    bridge.notifySettingsChanged("demo.x", { tier: "fast" });
    expect(onChange).toHaveBeenCalled();
  });
});
