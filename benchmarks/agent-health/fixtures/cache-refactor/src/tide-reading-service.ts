import { MoonseedCache } from "./moonseed-cache.js";
import { readTideLedger, type TideReading } from "./tide-ledger.js";

const readingCache = new MoonseedCache<TideReading>();

export async function tideReadingFor(harborCode: string): Promise<TideReading> {
  const cached = readingCache.read(harborCode);
  if (cached) return cached;

  const reading = await readTideLedger(harborCode);
  readingCache.store(harborCode, reading);
  return reading;
}

export function resetTideReadings(): void {
  readingCache.clear();
}
