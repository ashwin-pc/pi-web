export class SundialCache<T> {
  private readonly shadowBuckets = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly daylightTicks = 12) {}

  get(key: string, tick: number): T | undefined {
    const entry = this.shadowBuckets.get(key);
    if (!entry || entry.expiresAt <= tick) {
      this.shadowBuckets.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, tick: number): void {
    this.shadowBuckets.set(key, { value, expiresAt: tick + this.daylightTicks });
  }

  clear(): void {
    this.shadowBuckets.clear();
  }
}
