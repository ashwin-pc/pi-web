import type { ReadableStore, Unsubscribe } from "./types.js";

/**
 * A minimal external store: getSnapshot() returns the same value until
 * set() is called with a new one; subscribers run synchronously after each
 * change. Listener errors are isolated so one view cannot break another.
 */
export function createStore<T>(initial: T): ReadableStore<T> & { set(next: T): void; listenerCount(): number } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void): Unsubscribe {
      // A wrapper per subscription, so the same function subscribed twice gets two disposers.
      const entry = () => listener();
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error("pi-web client listener failed", error); }
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** A set of callbacks with typed payloads, returning disposers. */
export function createEmitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void): Unsubscribe {
      const entry = (value: T) => listener(value);
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
    emit(value: T) {
      for (const listener of [...listeners]) {
        try { listener(value); } catch (error) { console.error("pi-web client listener failed", error); }
      }
    },
    size: () => listeners.size,
    clear: () => listeners.clear(),
  };
}
