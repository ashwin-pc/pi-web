export type RuntimeRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type RuntimeResponse = {
  id: string;
  ok: true;
  result: unknown;
} | {
  id: string;
  ok: false;
  error: string;
};

export type RuntimeEvent = {
  event: string;
  data?: unknown;
};

export type DirectoryListing = {
  path: string;
  parent: string;
  dirs: Array<{ name: string; path: string }>;
};

export type GitStatusResult = {
  ok: true;
  cwd: string;
  isRepo: boolean;
  branch: string;
  porcelain: string;
};

export function encodeRuntimeMessage(value: RuntimeRequest | RuntimeResponse | RuntimeEvent): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseRuntimeLine(line: string): RuntimeRequest | RuntimeResponse | RuntimeEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Runtime message must be an object");
  return parsed as RuntimeRequest | RuntimeResponse | RuntimeEvent;
}
