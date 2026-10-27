export const sessionResourceLimits = {
  maxExtraListCwds: 8,
  listConcurrency: 4,
  maxLiveSessions: 16,
  maxConcurrentAdmissions: 4,
} as const;

export class SessionAdmissionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAdmissionLimitError";
  }
}

type AdmissionCallbacks = {
  residentCount(): number;
  evictableKeys(): string[];
  evict(key: string): Promise<void>;
};

/**
 * Counts reservations before runtime allocation and serializes capacity checks.
 * A reservation remains active until its caller either registers the runtime or
 * abandons the allocation.
 */
export class SessionAdmissionController {
  private pending = 0;
  private capacityQueue = Promise.resolve();

  async reserve(callbacks: AdmissionCallbacks): Promise<() => void> {
    if (this.pending >= sessionResourceLimits.maxConcurrentAdmissions) {
      throw new SessionAdmissionLimitError("Too many concurrent session openings; retry shortly.");
    }
    this.pending += 1;
    let released = false;
    try {
      await this.serializeCapacityCheck(async () => {
        const requiredEvictions = callbacks.residentCount() + this.pending - sessionResourceLimits.maxLiveSessions;
        if (requiredEvictions <= 0) return;
        const victims = callbacks.evictableKeys();
        if (victims.length < requiredEvictions) {
          throw new SessionAdmissionLimitError("All live session slots are busy; close a session and retry.");
        }
        for (const key of victims.slice(0, requiredEvictions)) await callbacks.evict(key);
        if (callbacks.residentCount() + this.pending > sessionResourceLimits.maxLiveSessions) {
          throw new SessionAdmissionLimitError("All live session slots are busy; close a session and retry.");
        }
      });
    } catch (error) {
      this.pending -= 1;
      throw error;
    }
    return () => {
      if (released) return;
      released = true;
      this.pending -= 1;
    };
  }

  private serializeCapacityCheck<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.capacityQueue.then(operation, operation);
    this.capacityQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
