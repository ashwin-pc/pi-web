// Typed UI slots, shaped like dsh's (deepseek-harness) four kinds, without
// its framework. A host *declares* a slot, which claims the right to render
// it; contributors *register* into it. Every declaration and registration
// returns a disposer, so contributions are reversible.
//
//   single  one value renders; the most recent registration wins and
//           disposing it reveals the previous one
//   list    every registration, in registration order
//   keyed   one value per key (most recent wins per key)
//   chain   every registration in order, meant to be composed by the host
//           (for example, a middleware chain)
import type { ReadableStore, Unsubscribe } from "../client/types.js";

export type SlotKind = "single" | "list" | "keyed" | "chain";

type Registration<T> = { value: T; key?: string; serial: number };

export type SlotSnapshot<T, K extends SlotKind> =
  K extends "single" ? T | undefined
    : K extends "keyed" ? ReadonlyMap<string, T>
      : readonly T[];

/** What the declaring host gets: the slot's contents as a store, and the claim's disposer. */
export type SlotHost<T, K extends SlotKind> = ReadableStore<SlotSnapshot<T, K>> & {
  name: string;
  kind: K;
  dispose(): void;
};

export class SlotError extends Error {
  constructor(message: string) { super(message); this.name = "SlotError"; }
}

export type SlotRegistry = {
  declare<T, K extends SlotKind>(name: string, kind: K): SlotHost<T, K>;
  /** Contributions may arrive before the host declares the slot; they render once it does. */
  register<T>(name: string, value: T, options?: { key?: string }): Unsubscribe;
  isDeclared(name: string): boolean;
  kindOf(name: string): SlotKind | undefined;
};

export function createSlotRegistry(): SlotRegistry {
  type SlotState = {
    kind?: SlotKind;
    registrations: Registration<unknown>[];
    listeners: Set<() => void>;
    snapshot?: unknown;
  };
  const slots = new Map<string, SlotState>();
  let serial = 0;

  function slot(name: string): SlotState {
    let state = slots.get(name);
    if (!state) { state = { registrations: [], listeners: new Set() }; slots.set(name, state); }
    return state;
  }

  function computeSnapshot(state: SlotState): unknown {
    const ordered = [...state.registrations].sort((a, b) => a.serial - b.serial);
    switch (state.kind) {
      case "single": return ordered[ordered.length - 1]?.value;
      case "keyed": {
        const map = new Map<string, unknown>();
        for (const item of ordered) if (item.key !== undefined) map.set(item.key, item.value);
        return map;
      }
      default: return ordered.map((item) => item.value);
    }
  }

  function changed(state: SlotState) {
    if (!state.kind) return;
    state.snapshot = computeSnapshot(state);
    for (const listener of [...state.listeners]) {
      try { listener(); } catch (error) { console.error("slot listener failed", error); }
    }
  }

  return {
    declare<T, K extends SlotKind>(name: string, kind: K): SlotHost<T, K> {
      const state = slot(name);
      if (state.kind) throw new SlotError(`Slot "${name}" is already declared (${state.kind}); only one host may render it.`);
      if (kind === "keyed" && state.registrations.some((item) => item.key === undefined)) {
        throw new SlotError(`Slot "${name}" has registrations without a key; keyed slots need one.`);
      }
      state.kind = kind;
      state.snapshot = computeSnapshot(state);
      let disposed = false;
      return {
        name,
        kind,
        getSnapshot: () => state.snapshot as SlotSnapshot<T, K>,
        subscribe(listener) {
          const entry = () => listener();
          state.listeners.add(entry);
          return () => { state.listeners.delete(entry); };
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          state.kind = undefined;
          state.snapshot = undefined;
          state.listeners.clear();
          // Registrations stay, so a later host sees what contributors already offered.
          if (!state.registrations.length) slots.delete(name);
        },
      };
    },
    register<T>(name: string, value: T, options: { key?: string } = {}): Unsubscribe {
      const state = slot(name);
      if (state.kind === "keyed" && options.key === undefined) throw new SlotError(`Slot "${name}" is keyed; register with a key.`);
      const registration: Registration<unknown> = { value, serial: ++serial, ...(options.key === undefined ? {} : { key: options.key }) };
      state.registrations.push(registration);
      changed(state);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const current = slots.get(name);
        if (!current) return;
        current.registrations = current.registrations.filter((item) => item !== registration);
        changed(current);
        if (!current.kind && !current.registrations.length) slots.delete(name);
      };
    },
    isDeclared: (name) => Boolean(slots.get(name)?.kind),
    kindOf: (name) => slots.get(name)?.kind,
  };
}
