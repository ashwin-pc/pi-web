import type { SessionAdapter } from "./adapter.js";
import type { HarnessCatalogDto } from "./dto.js";
import { SessionServiceError } from "./errors.js";

/** The only agent catalog and routing authority. IDs are opaque, not a closed union. */
export class SessionRegistry {
  private readonly entries = new Map<string, SessionAdapter>();
  constructor(adapters: readonly SessionAdapter[], private readonly enabled = true) {
    for (const adapter of adapters) {
      if (!adapter.harness.id || this.entries.has(adapter.harness.id)) throw new Error(`Duplicate or empty harness ${adapter.harness.id}`);
      this.entries.set(adapter.harness.id, adapter);
    }
    if (!this.entries.has("pi")) throw new Error("Default Pi adapter is required");
  }
  values() { return this.entries.values(); }
  has(id: string) { return this.entries.has(id); }
  catalog(): HarnessCatalogDto {
    return { multiHarnessEnabled: this.enabled, defaultHarnessId: "pi", harnesses: [...this.entries.values()].map(({ harness }) => ({
      ...harness, capabilities: { ...harness.capabilities },
      ...(!this.enabled && harness.id !== "pi" ? { enabled: false, unavailableReason: "Native agents are disabled" } : {}),
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
