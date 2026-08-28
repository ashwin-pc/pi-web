export type CacheConfig = {
  readingTtlMs: number;
  sweepIntervalMs: number;
  maxEntries: number;
};

let activeConfig: CacheConfig = {
  readingTtlMs: 45_000,
  sweepIntervalMs: 12_000,
  maxEntries: 250,
};

export function cacheConfig(): Readonly<CacheConfig> {
  return activeConfig;
}

export function replaceCacheConfig(next: CacheConfig): void {
  activeConfig = { ...next };
}
