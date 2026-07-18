import type {
  ConversationTreeDTO,
  JsonObject,
  JsonValue,
  SessionMessageFactDTO,
  SessionModelDTO,
  SessionRuntimeFactDTO,
  SessionStateFactDTO,
  SessionStatsFactDTO,
} from "./dto.js";

export type {
  JsonObject,
  JsonValue,
  SessionMessageFactDTO,
  SessionModelDTO,
  SessionRuntimeFactDTO,
  SessionStateFactDTO,
  SessionStatsFactDTO,
} from "./dto.js";

/** Identifies a session without relying on a process-global current session. */
export interface SessionContext {
  sessionId: string;
}

/** The service instance owns this identity; callers do not provide it. */
export interface ServiceStartDTO {
  boxId: string;
}

export interface ServiceErrorDTO {
  code: string;
  message: string;
  status: number;
}

export interface ServiceSuccess<T> {
  ok: true;
  value: T;
}

export interface ServiceFailure {
  ok: false;
  error: ServiceErrorDTO;
}

export type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

export interface EmptyDTO {
  ok: true;
}

export interface SessionCreateRequest {
  cwd: string;
  previousSessionId: string | null;
}

export interface SessionOpenRequest extends SessionContext {
  cwd: string | null;
}

export interface SessionDeleteRequest extends SessionContext {
  cwd: string | null;
}

export interface SessionDeleteDTO {
  sessionId: string;
  disposition: "trashed" | "deleted";
}

export interface SessionListRequest {
  cwds: string[];
}

export interface SessionSummaryDTO {
  sessionId: string;
  name: string;
  firstMessage: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  cwd: string;
  runtime: SessionRuntimeFactDTO;
}

export interface SessionSwitchCwdRequest {
  cwd: string;
}

export interface SessionCommandsDTO {
  commands: SlashCommandDTO[];
}

export interface SlashCommandDTO {
  name: string;
  description: string;
  source: "web" | "extension" | "prompt" | "skill";
  sourceInfo: JsonObject;
}

export interface SessionModelsDTO {
  cwd: string;
  current: SessionModelDTO | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  models: SessionModelDTO[];
}

export interface PromptImageDTO {
  data: string;
  mimeType: string;
  name: string | null;
}

export interface PromptRequest {
  message: string;
  mode: "steer" | "followUp";
  images: PromptImageDTO[];
}

export interface PromptAcceptedDTO {
  sessionId: string;
}

export interface ModelSelectionRequest {
  provider: string;
  id: string;
  thinkingLevel: string | null;
}

export interface CommandRequest {
  command: string;
}

export interface CommandResultDTO {
  message: string;
  state: SessionStateFactDTO;
}

export interface ShellRequest {
  command: string;
  excludeFromContext: boolean;
}

export interface ShellResultDTO {
  command: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath: string | null;
  excludeFromContext: boolean;
}

export interface TreeNavigationRequest {
  targetId: string;
  summarize: boolean;
  customInstructions: string | null;
  replaceInstructions: boolean;
  label: string | null;
}

export interface TreeNavigationResultDTO {
  editorText: string | null;
  cancelled: boolean;
  aborted: boolean;
  summaryEntry: JsonValue | null;
  leafId: string | null;
  state: SessionStateFactDTO;
}

export interface ExtensionHeaderActionRequest {
  key: string;
}

export interface ExtensionHeaderActionResultDTO {
  label: string;
  markdown: string;
}

export interface ExtensionGitTabRequest {
  key: string;
  action: string | null;
  payload: JsonValue | null;
  repo: ExtensionGitTabRepoDTO | null;
}

export interface ExtensionGitTabRepoDTO {
  path: string | null;
  root: string | null;
  branch: string | null;
}

export interface ExtensionGitTabResultDTO {
  title: string;
  html: string;
}

export type ExtensionUiMethodDTO = "select" | "confirm" | "input" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "editor";

/** JSON-only extension dialog request emitted to the browser adapter. */
export interface ExtensionUiRequestEventDTO extends JsonObject {
  type: "extension_ui_request";
  id: string;
  method: ExtensionUiMethodDTO;
  sessionId: string;
  sessionFile: string;
  timeoutMs: number | null;
}

/** JSON-only browser response passed back to an extension in the session's box. */
export interface ExtensionUiResponseDTO extends JsonObject {
  id: string;
  cancelled: boolean;
  confirmed: boolean;
  value: JsonValue | null;
}

export interface ExtensionUiResponseResultDTO {
  accepted: boolean;
}

export interface ViewerLeaseRequest {
  clientId: string;
}

export interface ViewerLeaseDTO {
  sessionId: string;
  clientId: string;
}

export interface DirectoryListRequest {
  path: string;
}

export interface DirectoryEntryDTO {
  name: string;
  path: string;
}

export interface DirectoryListingDTO {
  path: string;
  parent: string;
  dirs: DirectoryEntryDTO[];
}

export interface DirectoryCreateRequest {
  parent: string;
  name: string;
}

export interface ArtifactReadRequest {
  name: string;
}

/** Artifact bytes are transport data, never a path on the hosting box. */
export interface ArtifactBase64DTO {
  name: string;
  mimeType: string;
  base64: string;
}

export interface ArtifactTextDTO {
  name: string;
  mimeType: string;
  text: string;
}

export interface ArtifactWriteRequest {
  name: string;
  mimeType: string;
  base64: string;
}

export interface ArtifactWriteDTO {
  name: string;
  mimeType: string;
  size: number;
}

export interface GitRepoRefRequest {
  repo: string | null;
}

export interface GitRepoSummaryDTO {
  path: string;
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  isCurrent: boolean;
}

export interface GitReposDTO {
  cwd: string;
  depth: number;
  repos: GitRepoSummaryDTO[];
}

export interface GitStatusRequest extends GitRepoRefRequest {
  fetch: boolean;
}

export interface GitStatusFileDTO {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  label: "untracked" | "conflicted" | "renamed" | "added" | "deleted" | "staged" | "modified";
  staged: boolean;
}

export interface GitStatusDTO {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  defaultRemoteBranch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFileDTO[];
}

export interface GitCommitRefRequest extends GitRepoRefRequest {
  hash: string;
}

export interface GitCommitDTO {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
}

export interface GitLogDTO {
  isRepo: boolean;
  commits: GitCommitDTO[];
}

export interface GitCommitFileDTO {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetailsDTO {
  commit: GitCommitDTO;
  files: GitCommitFileDTO[];
  diff: string;
}

export interface GitDiffRequest extends GitRepoRefRequest {
  path: string;
  staged: boolean;
}

export interface GitDiffDTO {
  path: string;
  staged: boolean;
  diff: string;
}

export interface GitImageRequest extends GitRepoRefRequest {
  path: string;
  oldPath: string | null;
  version: "before" | "after";
  staged: boolean;
}

export interface GitImageDTO {
  path: string;
  base64: string;
}

export interface GitSyncDTO {
  output: string;
  status: GitStatusDTO;
}

/** Filesystem operations belong to the service's box, not to a session. */
export interface SessionFilesystemService {
  list(request: DirectoryListRequest): Promise<ServiceResult<DirectoryListingDTO>>;
  mkdir(request: DirectoryCreateRequest): Promise<ServiceResult<DirectoryListingDTO>>;
}

export interface SessionArtifactService {
  read(context: SessionContext, request: ArtifactReadRequest): Promise<ServiceResult<ArtifactTextDTO>>;
  readBase64(context: SessionContext, request: ArtifactReadRequest): Promise<ServiceResult<ArtifactBase64DTO>>;
  write(context: SessionContext, request: ArtifactWriteRequest): Promise<ServiceResult<ArtifactWriteDTO>>;
}

export interface SessionGitService {
  repos(context: SessionContext): Promise<ServiceResult<GitReposDTO>>;
  status(context: SessionContext, request: GitStatusRequest): Promise<ServiceResult<GitStatusDTO>>;
  log(context: SessionContext, request: GitRepoRefRequest): Promise<ServiceResult<GitLogDTO>>;
  commit(context: SessionContext, request: GitCommitRefRequest): Promise<ServiceResult<GitCommitDetailsDTO>>;
  diff(context: SessionContext, request: GitDiffRequest): Promise<ServiceResult<GitDiffDTO>>;
  image(context: SessionContext, request: GitImageRequest): Promise<ServiceResult<GitImageDTO>>;
  sync(context: SessionContext, request: GitRepoRefRequest): Promise<ServiceResult<GitSyncDTO>>;
}

export interface WebFooterDTO {
  key: string;
  footer: JsonValue;
}

export interface WebHeaderActionDTO {
  key: string;
  icon: string | null;
  title: string;
  label: string | null;
}

export interface WebGitTabDTO {
  key: string;
  title: string;
  label: string | null;
}

export type SessionServiceEvent =
  | { type: "pi_event"; sessionId: string; sessionFile: string; event: JsonValue }
  | { type: "session_runtime_changed"; sessionId: string; sessionFile: string; runtime: SessionRuntimeFactDTO }
  | { type: "state_changed"; state: SessionStateFactDTO }
  | { type: "session_stats_changed"; sessionId: string; sessionFile: string; stats: SessionStatsFactDTO }
  | { type: "models_updated"; sessionId: string; models: SessionModelDTO[] }
  | { type: "server_error"; sessionId: string; sessionFile: string; error: ServiceErrorDTO }
  | { type: "session_shutdown"; sessionId: string; sessionFile: string; reason: "idle" | "delete" | "reset" | "close" }
  | { type: "web_footer_changed"; sessionId: string; sessionFile: string; webFooters: WebFooterDTO[] }
  | { type: "web_header_actions_changed"; sessionId: string; sessionFile: string; webHeaderActions: WebHeaderActionDTO[] }
  | { type: "web_git_tabs_changed"; sessionId: string; sessionFile: string; webGitTabs: WebGitTabDTO[] }
  | ExtensionUiRequestEventDTO;

/**
 * Box-local session protocol. All session-scoped methods require an explicit
 * context; browser route defaults and activity decoration live outside it.
 */
export interface SessionService {
  start(): Promise<ServiceResult<ServiceStartDTO>>;
  close(): Promise<ServiceResult<EmptyDTO>>;
  create(request: SessionCreateRequest): Promise<ServiceResult<SessionStateFactDTO>>;
  open(request: SessionOpenRequest): Promise<ServiceResult<SessionStateFactDTO>>;
  delete(request: SessionDeleteRequest): Promise<ServiceResult<SessionDeleteDTO>>;
  list(request: SessionListRequest): Promise<ServiceResult<SessionSummaryDTO[]>>;
  switchCwd(context: SessionContext, request: SessionSwitchCwdRequest): Promise<ServiceResult<SessionStateFactDTO>>;
  state(context: SessionContext): Promise<ServiceResult<SessionStateFactDTO>>;
  messages(context: SessionContext): Promise<ServiceResult<SessionMessageFactDTO[]>>;
  stats(context: SessionContext): Promise<ServiceResult<SessionStatsFactDTO>>;
  tree(context: SessionContext): Promise<ServiceResult<ConversationTreeDTO>>;
  commands(context: SessionContext): Promise<ServiceResult<SessionCommandsDTO>>;
  models(context: SessionContext): Promise<ServiceResult<SessionModelsDTO>>;
  prompt(context: SessionContext, request: PromptRequest): Promise<ServiceResult<PromptAcceptedDTO>>;
  abort(context: SessionContext): Promise<ServiceResult<PromptAcceptedDTO>>;
  abortCompaction(context: SessionContext): Promise<ServiceResult<PromptAcceptedDTO>>;
  retry(context: SessionContext): Promise<ServiceResult<PromptAcceptedDTO>>;
  rename(context: SessionContext, name: string): Promise<ServiceResult<SessionStateFactDTO>>;
  setModel(context: SessionContext, request: ModelSelectionRequest): Promise<ServiceResult<SessionStateFactDTO>>;
  executeCommand(context: SessionContext, request: CommandRequest): Promise<ServiceResult<CommandResultDTO>>;
  executeShell(context: SessionContext, request: ShellRequest): Promise<ServiceResult<ShellResultDTO>>;
  navigateTree(context: SessionContext, request: TreeNavigationRequest): Promise<ServiceResult<TreeNavigationResultDTO>>;
  abortBranchSummary(context: SessionContext): Promise<ServiceResult<PromptAcceptedDTO>>;
  respondExtensionUi(context: SessionContext, response: ExtensionUiResponseDTO): Promise<ServiceResult<ExtensionUiResponseResultDTO>>;
  hasHeaderAction(context: SessionContext, request: ExtensionHeaderActionRequest): Promise<ServiceResult<boolean>>;
  invokeHeaderAction(context: SessionContext, request: ExtensionHeaderActionRequest): Promise<ServiceResult<ExtensionHeaderActionResultDTO>>;
  hasGitTab(context: SessionContext, request: ExtensionHeaderActionRequest): Promise<ServiceResult<boolean>>;
  invokeGitTab(context: SessionContext, request: ExtensionGitTabRequest): Promise<ServiceResult<ExtensionGitTabResultDTO>>;
  acquireViewer(context: SessionContext, request: ViewerLeaseRequest): Promise<ServiceResult<ViewerLeaseDTO>>;
  releaseViewer(context: SessionContext, lease: ViewerLeaseDTO): Promise<ServiceResult<EmptyDTO>>;
  fs: SessionFilesystemService;
  artifacts: SessionArtifactService;
  git: SessionGitService;
  subscribe(listener: (event: SessionServiceEvent) => void): () => void;
}

/** Rejects values that JSON.stringify would silently alter or discard. */
export function assertSessionTransportValue(value: unknown, path = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} must be a finite JSON number`);
  }
  if (value === undefined) throw new TypeError(`${path} must not be undefined`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSessionTransportValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) assertSessionTransportValue(nested, `${path}.${key}`);
    return;
  }
  throw new TypeError(`${path} is not JSON-serializable`);
}

/** Round-trips protocol values through the same JSON boundary a remote transport uses. */
export function serializeSessionTransport<T extends JsonValue>(value: T): T {
  assertSessionTransportValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
