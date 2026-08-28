import { cacheConfig } from "./cache-config.js";

type CacheParcel<T> = {
  value: T;
  storedAt: number;
  expiresAt: number;
};

export class MoonseedCache<T> {
  readonly #parcels = new Map<string, CacheParcel<T>>();
  #lastSweepAt = 0;

  read(key: string, now = Date.now()): T | undefined {
    const parcel = this.#parcels.get(key);
    if (!parcel) return undefined;

    if (parcel.expiresAt <= now) {
      this.#parcels.delete(key);
      return undefined;
    }

    if (now - this.#lastSweepAt >= cacheConfig().sweepIntervalMs) {
      this.#sweepExpired(now);
    }
    return parcel.value;
  }

  store(key: string, value: T, now = Date.now()): void {
    const config = cacheConfig();
    this.#parcels.set(key, {
      value,
      storedAt: now,
      expiresAt: now + config.readingTtlMs,
    });

    if (this.#parcels.size > config.maxEntries) {
      const oldest = [...this.#parcels.entries()].sort(
        ([, left], [, right]) => left.storedAt - right.storedAt,
      )[0];
      if (oldest) this.#parcels.delete(oldest[0]);
    }
  }

  clear(): void {
    this.#parcels.clear();
    this.#lastSweepAt = 0;
  }

  #sweepExpired(now: number): void {
    for (const [key, parcel] of this.#parcels) {
      if (parcel.expiresAt <= now) this.#parcels.delete(key);
    }
    this.#lastSweepAt = now;
  }
}
