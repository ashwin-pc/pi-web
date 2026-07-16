export type RuntimeCapabilities = {
  messageBranching: boolean;
  sessionRename: boolean;
  slashCommands: boolean;
  shellCommands: boolean;
  sessionStats: boolean;
  gitPanel: boolean;
  gitSync: boolean;
  extensionUi: boolean;
  compactionCancel: boolean;
};

export const RUNNER_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  messageBranching: true,
  sessionRename: false,
  slashCommands: false,
  shellCommands: false,
  sessionStats: false,
  gitPanel: false,
  gitSync: false,
  extensionUi: false,
  compactionCancel: false,
};

export const LOCAL_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  messageBranching: true,
  sessionRename: true,
  slashCommands: true,
  shellCommands: true,
  sessionStats: true,
  gitPanel: true,
  gitSync: true,
  extensionUi: true,
  compactionCancel: true,
};

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

export type RuntimeRequestTransport = {
  sendEvent: (event: string, data?: unknown) => void;
};

export type RuntimeRequestHandler = ((request: RuntimeRequest, transport: RuntimeRequestTransport) => Promise<unknown>) & {
  dispose?: () => void;
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
