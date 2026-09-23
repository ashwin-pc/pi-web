export interface VerifyWavyPackageOptions { localBrowserPath?: string }
export function verifyWavyPackage(archivePath: string, options?: VerifyWavyPackageOptions): Promise<void>;
