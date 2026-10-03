import type { SessionAdapter } from "./adapter.js";
import type { HarnessCatalogDto } from "./dto.js";
import { SessionServiceError } from "./errors.js";

/** The only agent catalog and routing authority. IDs are opaque, not a closed union. */
export class SessionRegistry {
  private readonly entries = new Map<string, SessionAdapter>();
  readonly defaultHarnessId: string;
  constructor(adapters: readonly SessionAdapter[], private readonly enabled = true, defaultHarnessId = adapters[0]?.harness.id) {
    if (!defaultHarnessId) throw new Error("A default adapter is required");
    this.defaultHarnessId = defaultHarnessId;
    for (const adapter of adapters) {
      if (!adapter.harness.id || this.entries.has(adapter.harness.id)) throw new Error(`Duplicate or empty harness ${adapter.harness.id}`);
      if (adapter.piCompatibility && adapter.webIdentity !== "native") throw new Error("Legacy file compatibility requires native web identity");
      this.entries.set(adapter.harness.id, adapter);
    }
    if (!this.entries.has(defaultHarnessId)) throw new Error("Default adapter must be registered");
  }
  values() { return this.entries.values(); }
  has(id: string) { return this.entries.has(id); }
  get(id: string) { return this.entries.get(id); }
  catalog(): HarnessCatalogDto {
    return { multiHarnessEnabled: this.enabled, defaultHarnessId: this.defaultHarnessId, harnesses: [...this.entries.values()].map(({ harness }) => ({
      ...harness, capabilities: { ...harness.capabilities },
      ...(!this.enabled && harness.id !== this.defaultHarnessId ? { enabled: false, unavailableReason: "Additional agents are disabled" } : {}),
    })) };
  }
  require(id: string): SessionAdapter {
    const adapter = this.entries.get(id);
    if (!adapter) throw new SessionServiceError(`Unknown harness: ${id}`, 400);
    const descriptor = this.catalog().harnesses.find((item) => item.id === id)!;
    if (!descriptor.enabled || !descriptor.available) throw new SessionServiceError(descriptor.unavailableReason || `Harness ${id} is unavailable`, 503);
    return adapter;
  }
}
