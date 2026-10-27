export const sessionResourceLimits = {
  listConcurrency: 4,
  idleResidencyTarget: 16,
  maxConcurrentAdmissions: 4,
} as const;

type AdmissionCallbacks = {
  residentCount(): number;
  evictableKeys(): string[];
  evict(key: string): Promise<void>;
};

/**
 * FIFO semaphore for runtime allocations. Idle runtimes are evicted toward the
 * residency target, while protected, viewed, and work-leased runtimes may exceed
 * it so busy worker fan-outs keep making progress.
 */
export class SessionAdmissionController {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async reserve(callbacks: AdmissionCallbacks): Promise<() => void> {
    await this.acquire();
    let released = false;
    try {
      const excessIdle = callbacks.residentCount() + 1 - sessionResourceLimits.idleResidencyTarget;
      for (const key of callbacks.evictableKeys().slice(0, Math.max(0, excessIdle))) await callbacks.evict(key);
    } catch (error) {
      this.release();
      throw error;
    }
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquire(): Promise<void> {
    if (this.active < sessionResourceLimits.maxConcurrentAdmissions) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}
