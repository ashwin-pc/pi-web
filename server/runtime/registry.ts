import type { RuntimeRef } from "./bindings.js";

export class RuntimeRegistry {
  private runtimes = new Map<string, RuntimeRef>();

  constructor(initial: RuntimeRef[] = []) {
    for (const runtime of initial) this.add(runtime);
  }

  add(runtime: RuntimeRef): void {
    this.runtimes.set(runtime.id, runtime);
  }

  get(id: string): RuntimeRef | undefined {
    return this.runtimes.get(id);
  }

  list(): RuntimeRef[] {
    return Array.from(this.runtimes.values()).sort((a, b) => a.label.localeCompare(b.label));
  }
}

export const localRuntime: RuntimeRef = { id: "local", kind: "local", label: "Local machine" };
