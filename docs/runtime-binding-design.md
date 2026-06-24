# Per-session runtime binding design

Issue context: GitHub issue #3 proposes that pi-web should support both normal host sessions and sandboxed sessions at the same time. The runtime choice is made per session, not globally.

## Goals

- Keep current host behavior unchanged by default.
- Let a user choose a trust boundary when creating/opening a session.
- Support managed sandboxes created by pi-web and external sandboxes created by the user.
- Do not require one worktree per session. Multiple sessions may attach to the same runtime/cwd, with warnings only.
- Make existing API routes runtime-aware without duplicating UI behavior.

## Non-goals for the first implementation

- Perfect concurrent edit isolation.
- A full container orchestration product.
- Replacing the current local `createAgentSession` path.
- Rewriting all pi-web session history storage in one change.

## Runtime model

```ts
export type RuntimeRef =
  | { kind: "host"; cwd: string }
  | { kind: "sandbox"; sandboxId: string; cwd: string };

export type SandboxRuntime = {
  id: string;
  name: string;
  mode: "managed" | "external";
  endpoint: string;
  status: "unknown" | "starting" | "ready" | "stopped" | "error";
  network: "unknown" | "on" | "off";
  description?: string;
};
```

Persist a binding:

```text
sessionId -> RuntimeRef
```

The binding should live in server-owned web metadata, not in the core pi session file format initially. A simple first store can be `.pi/web/runtime-bindings.json` keyed by session id.

## Server architecture

Introduce a small adapter layer around host and sandbox execution.

```ts
interface RuntimeAdapter {
  ref: RuntimeRef;
  getState(sessionId: string): Promise<PiWebState>;
  getMessages(sessionId: string): Promise<SimplifiedMessage[]>;
  prompt(input: PromptRequest): Promise<{ sessionId: string }>;
  abort(sessionId: string): Promise<void>;
  listGitRepos(sessionId: string): Promise<GitRepo[]>;
  gitStatus(request: GitStatusRequest): Promise<GitStatusResponse>;
  gitDiff(request: GitDiffRequest): Promise<GitDiffResponse>;
  gitSync(request: GitSyncRequest): Promise<GitSyncResponse>;
  listDirs(path: string): Promise<DirectoryListing>;
  createDir(parent: string, name: string): Promise<DirectoryListing>;
  artifact(name: string): Promise<ArtifactResult>;
}
```

### Host adapter

The host adapter wraps existing server functions:

- `makeAgentSession`
- `getOrCreateLiveSessionById`
- `createNewLiveSession`
- `liveSessions`
- `sessionCwd`
- local git/fs/artifact helpers

This should be mostly extraction/refactoring. Behavior should remain byte-for-byte compatible where possible.

### Sandbox adapter

The sandbox adapter proxies to a worker running inside a Docker container, VM, or user-managed environment.

Expected worker surface:

```text
GET  /health
POST /sessions/new
POST /sessions/:id/prompt
POST /sessions/:id/abort
GET  /sessions/:id/state
GET  /sessions/:id/messages
GET  /git/repos?sessionId=...
GET  /git/status?sessionId=...&repo=...
GET  /git/diff?sessionId=...&repo=...&path=...
POST /git/sync
GET  /fs/dirs?path=...
POST /fs/dirs
GET  /artifacts/:name
WS   /events
```

The worker should emit the same logical event types pi-web already broadcasts, so the UI can stay mostly unchanged.

## Request routing

Add a resolver:

```ts
async function runtimeForSessionId(sessionId?: string): Promise<RuntimeAdapter>;
```

Rules:

1. If no `sessionId`, use the current active session binding.
2. If the session has no binding, default to `{ kind: "host", cwd: sessionCwd(...) }` and persist it lazily.
3. For new sessions, use the runtime selected in the request body.
4. For opening historical sessions, use existing binding; if missing, assume host.

Routes to move behind adapters first:

- `/api/prompt`
- `/api/abort`
- `/api/state`
- `/api/messages`
- `/api/sessions/new`
- `/api/sessions/open`
- `/api/git/repos`
- `/api/git/status`
- `/api/git/diff`
- `/api/git/sync`
- `/api/artifacts/*`
- `/api/fs/dirs`
- `/api/session/cwd`

## API additions

```text
GET  /api/runtimes
POST /api/runtimes/managed
POST /api/runtimes/external
GET  /api/sessions/:id/runtime
PATCH /api/sessions/:id/runtime
```

Example new-session body:

```json
{
  "cwd": "/workspace/pi-web",
  "runtime": { "kind": "sandbox", "sandboxId": "sensitive-work", "cwd": "/workspace/pi-web" }
}
```

## UX design

### New session flow

```text
Start session in:
  ○ Host machine
  ○ Existing sandbox
      sensitive-work · sandbox · network off
      private-client · sandbox · network on
      disposable · sandbox
  ○ Create sandbox...
  ○ Connect external sandbox...
```

### Session drawer metadata

```text
Fix reload issue
pi-web · host

Review sensitive client repo
sensitive-work · sandbox · network off
```

### Warnings

Show non-blocking warnings when:

- Multiple live sessions attach to the same sandbox and cwd.
- Sandbox health is unknown or disconnected.
- The selected cwd is outside the sandbox-mounted workspace.
- A sandbox has network enabled for a session marked sensitive.

## Managed sandbox MVP

Docker is the simplest first managed runtime.

Suggested shape:

```text
pi-web server
  creates container
  mounts selected host repo to /workspace/<name>
  starts pi-web sandbox worker inside container
  stores sandbox metadata
  proxies session operations to worker
```

Initial policy knobs:

- mount path
- read/write vs read-only mount
- network on/off
- environment/secrets allowlist
- image name/tag

## External sandbox MVP

For user-created sandboxes, pi-web only stores:

- name
- endpoint URL
- optional auth token
- display metadata: network/cwd/description

Health check verifies `/health` and protocol version.

## Event forwarding

Each sandbox adapter maintains a worker WebSocket connection. Incoming sandbox events are normalized and rebroadcast through the existing pi-web WebSocket stream:

```text
sandbox worker event -> sandbox adapter -> pi-web broadcast(...) -> browser
```

Events must include `sessionId` and runtime metadata so the browser can reconcile active sessions.

## Rollout plan

1. Add `RuntimeRef` types and runtime binding store.
2. Persist host bindings for current and newly created sessions.
3. Extract current host behavior into `HostRuntimeAdapter` with no UX changes.
4. Route `/api/prompt`, `/api/state`, `/api/messages`, and `/api/abort` through the adapter resolver.
5. Add `/api/runtimes` and UI display of runtime badges.
6. Add external sandbox adapter and worker protocol.
7. Add runtime selection to new-session/open-session flow.
8. Add Docker managed sandbox creation.
9. Move git/fs/artifact routes fully behind adapters.
10. Add tests for host compatibility and sandbox proxy behavior.

## Test strategy

- Unit test binding store migration/defaulting.
- API tests proving current host behavior is unchanged.
- Mock sandbox worker tests for prompt/state/messages/abort.
- Git/fs/artifact route tests for both host and sandbox adapters.
- E2E tests for new-session runtime selection and session drawer badges.

## Open questions

- Should artifacts remain globally addressable by filename, or include session/runtime in the URL for sandbox artifacts?
- How should sandbox worker authentication be configured for external sandboxes?
- Should managed sandbox lifecycle follow session lifecycle, or be explicitly user-controlled?
- How much of model/auth configuration should be copied into managed sandboxes vs proxied from host?
