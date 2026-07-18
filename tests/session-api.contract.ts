import type {
  ArtifactBase64DTO,
  DirectoryCreateRequest,
  ExtensionGitTabRequest,
  JsonObject,
  PromptRequest,
  SessionArtifactService,
  SessionContext,
  SessionFilesystemService,
  SessionGitService,
  SessionCreateRequest,
  SessionMessageFactDTO,
  SessionRuntimeFactDTO,
  SessionService,
  SessionServiceEvent,
  SessionStateFactDTO,
  TreeNavigationRequest,
} from "../server/session/api.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type OptionalKeys<Value extends object> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? Key : never;
}[keyof Value];

type SessionServiceMethods =
  | "start" | "close" | "create" | "open" | "delete" | "list" | "switchCwd"
  | "state" | "messages" | "stats" | "tree" | "commands" | "models"
  | "prompt" | "abort" | "abortCompaction" | "retry" | "rename" | "setModel"
  | "executeCommand" | "executeShell" | "navigateTree" | "abortBranchSummary"
  | "respondExtensionUi" | "hasHeaderAction" | "invokeHeaderAction" | "hasGitTab" | "invokeGitTab"
  | "acquireViewer" | "releaseViewer" | "fs" | "artifacts" | "git" | "subscribe";

type _CompleteSurface = Assert<Equal<keyof SessionService, SessionServiceMethods>>;
type _NoOptionalServiceMembers = Assert<Equal<OptionalKeys<SessionService>, never>>;
type _NoOptionalFilesystemMembers = Assert<Equal<OptionalKeys<SessionFilesystemService>, never>>;
type _NoOptionalArtifactMembers = Assert<Equal<OptionalKeys<SessionArtifactService>, never>>;
type _NoOptionalGitMembers = Assert<Equal<OptionalKeys<SessionGitService>, never>>;
type _ExplicitStateContext = Assert<Equal<Parameters<SessionService["state"]>, [context: SessionContext]>>;
type _ExplicitPromptContext = Assert<Equal<Parameters<SessionService["prompt"]>, [context: SessionContext, request: PromptRequest]>>;
type _ExplicitNavigationContext = Assert<Equal<Parameters<SessionService["navigateTree"]>, [context: SessionContext, request: TreeNavigationRequest]>>;
type _BoxScopedDirectoryOperation = Assert<Equal<Parameters<SessionService["fs"]["mkdir"]>, [request: DirectoryCreateRequest]>>;
type _ExplicitGitContext = Assert<Equal<Parameters<SessionService["git"]["status"]>[0], SessionContext>>;
type _StartUsesServiceOwnedIdentity = Assert<Equal<Parameters<SessionService["start"]>, []>>;
type _CloseUsesServiceOwnedIdentity = Assert<Equal<Parameters<SessionService["close"]>, []>>;
type _CreateHasNoRemoteSessionFile = Assert<Equal<Extract<keyof SessionCreateRequest, "previousSessionFile">, never>>;
type _RawStateHasNoActivityTimestamps = Assert<Equal<Extract<keyof SessionStateFactDTO, "runtimeStartedAt" | "runtimeLastActivityAt">, never>>;
type _RawRuntimeHasNoActivityTimestamps = Assert<Equal<Extract<keyof SessionRuntimeFactDTO, "startedAt" | "lastActivityAt">, never>>;
type _RawMessageHasNoActivityTimestamp = Assert<Equal<Extract<keyof SessionMessageFactDTO, "startedAt" | "lastActivityAt">, never>>;
// @ts-expect-error JSON object values cannot be undefined.
const invalidJsonObject: JsonObject = { missing: undefined };
void invalidJsonObject;
type _GitTabPayloadIsTransportSafe = Assert<Equal<Parameters<SessionService["invokeGitTab"]>[1], ExtensionGitTabRequest>>;
type _ArtifactReadContext = Assert<Equal<Parameters<SessionService["artifacts"]["readBase64"]>[0], SessionContext>>;
type _ArtifactHasNoFilesystemPath = Assert<Equal<Extract<keyof ArtifactBase64DTO, "file" | "path">, never>>;
type _EventsAreDiscriminated = Assert<Equal<Extract<SessionServiceEvent, { type: "models_updated" }>["type"], "models_updated">>;

export {};
