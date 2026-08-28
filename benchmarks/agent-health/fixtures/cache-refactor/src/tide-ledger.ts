export type TideReading = {
  harborCode: string;
  heightInMoonspans: number;
  observedAt: string;
};

export async function readTideLedger(harborCode: string): Promise<TideReading> {
  return {
    harborCode,
    heightInMoonspans: harborCode.length / 3,
    observedAt: new Date().toISOString(),
  };
}
