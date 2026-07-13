# Runtime-authoritative session and workbench design

Issue context: pi-web must support local and sandbox/remote sessions without silently crossing trust boundaries. Connecting a runtime is a one-time operation; choosing a workbench runtime establishes the complete execution scope for one browser tab.

## Product model

- **Runtime manager:** connect, verify, reconnect, and forget runtime configurations.
- **Workbench runtime:** an explicit per-tab choice, similar to a VS Code window's remote authority. Session tabs, drawer, folders, models/auth, git, artifacts, composer, and tools all share it.
- **Session runtime:** an immutable routing attribute of an existing session. A different-runtime session must switch this workbench explicitly or open in another browser tab.
- **cwd:** always interpreted inside the selected workbench runtime.
- **No fallback:** an unavailable runtime produces recovery UI, never a local session with the same id/cwd.

Connecting and selecting are separate:

```text
Connect SSH devbox once
  -> select SSH devbox as this tab's workbench runtime
  -> browse ~/workspace on devbox
  -> create multiple sessions there
```

The workbench switcher lives in the session drawer footer beside Settings. It remains the entry point for connecting a first runtime, while the empty-session screen only changes folders.

## Identity and routing

`sessionId` remains the globally unique identity. Runtime ids are routing attributes, not part of identity:

```ts
type SessionLocator = {
  sessionId: string;
  runtimeId: string;
  cwd: string;
  sessionFile?: string;
  updatedAt: string; // host-observed activity/reconciliation time
};
```

Reasons:

- pi session ids are UUIDv7 and already globally unique;
- pins, unread state, and markers can stay keyed by session id without migration;
- the same durable session store exposed through two runtime configs remains one session;
- API calls, deep links, and realtime envelopes carry `runtimeId` explicitly for routing.

Session URLs use `sessionId` plus `runtimeId` for recovery routing. Current-session API calls also send `x-pi-web-runtime-id`. The runtime id is a stable, user-declared configuration id—not a container instance id.

## Ownership

### Runtime is authoritative

A runtime owns:

- pi session files and transcripts;
- cwd, title, message count, model/thinking selection state;
- session tree and runtime artifacts;
- runtime-side git and tool execution.

Managed local containers do not own provider credentials or provider network transport. Those are deliberately host-brokered as described below. SSH and other machine runtimes remain responsible for their own credentials and networking.

The runner exposes capped/paginated `sessions.list`; pi-web reconciles its locator cache from that list.

### Host stores connection configuration and locator cache

The host stores:

- declarative runtime connection configurations;
- last-known session locator and display metadata;
- host-observed activity ordering;
- normal web UI state keyed by session id.

The locator cache supports immediate drawer rendering, deep links, and unavailable-runtime recovery. It is not authoritative session history. A locator's runtime ownership is immutable: reconciliation may update metadata but must never reclassify the session to a runtime that also happens to list the same id. Forgetting a runtime intentionally removes all of its cached locators.

## Durable runtime storage

Disposable infrastructure cannot be authoritative for durable data.

The built-in Docker provider uses an `--rm` container but mounts a stable named volume at `/root/.pi/agent`. The container/runner can be recreated while session data survives. The volume name derives from the declarative runtime id and can be overridden with `PI_WEB_DOCKER_SESSION_VOLUME`.

User-managed Apple containers, Docker/Podman exec targets, and SSH hosts are responsible for durable runtime storage. The UI should state whether storage is a pi-web volume, runtime-managed, or explicitly disposable.

## Session host architecture

Routes resolve a session once to a capability-based host:

```ts
interface SessionHost {
  kind: "local" | "runner" | "unavailable";
  sessionId: string;
  runtimeId: string;
  state(): Promise<WebState>;
  messages(): Promise<MessageState>;
  prompt?(message: string, images: ImagePart[], mode: QueueMode): Promise<void>;
  abort?(): Promise<void>;
  listModels?(): Promise<ModelState>;
  setModel?(...): Promise<WebState>;
  gitStatus?(): Promise<GitStatus>;
  // Optional method means explicit unsupported capability.
}
```

- Local host wraps the in-process pi session.
- Runner host wraps the shared stdio runner protocol.
- Unavailable host returns last-known metadata and recovery state.

The runner forwards every pi event through the same host enrichment and browser realtime pipeline used by local sessions.

## Managed-container model broker

Apple container, Docker, and Podman runners use a typed, bidirectional model protocol over the existing stdio transport. Their container network has no internet route.

- On startup the runner requests the host's available model catalog. The catalog contains model metadata only—never URLs, headers, or credentials.
- The runtime keeps authoritative model/thinking selection in its session but registers a broker stream implementation for inference.
- A model request carries only an approved provider/model id, conversation context, and safe stream options.
- The host looks up the authoritative model, resolves host auth, invokes pi-ai, and forwards typed stream events.
- Runner-supplied API keys, headers, environment, URLs, callbacks, and abort signals are discarded. Abort is a separate typed operation tied to one stream id.
- A runner may not issue arbitrary host HTTP requests. Unknown host methods and unavailable models are rejected.
- Closing the runner transport aborts active host model streams so reconnects cannot leave billable requests running.

The runtime process scrubs credential-shaped environment variables in broker mode and uses in-memory dummy auth only to satisfy the agent's local model-selection API. Host auth never enters runtime storage. This supersedes copying `auth.json` into managed containers.

Because tools have no network route, they cannot bypass the broker with curl, DNS, raw sockets, or cleared proxy settings. Broker failure is fail-closed. SSH runtimes intentionally do not use this broker and depend on authentication/networking configured on the remote machine.

## Listing and ordering

`GET /api/sessions?runtimeId=<id>` lists only the requested runtime and includes `runtimeRef` on every row.

For remote runtimes, the browser first requests cached locators and renders them immediately, then requests authoritative runner data in the background. `sessions.list` is capped and cursor-paginated.

Drawer ordering uses host-observed activity/reconciliation time. Runtime timestamps remain metadata but do not control cross-host ordering, avoiding SSH clock-skew bugs.

Remembered cwd history is keyed by runtime id so paths such as `/workspace` are never suggested for local sessions.

## Delete versus remove

These are distinct operations:

- **Remove from list:** deletes only the host locator/UI metadata. It works while the runtime is offline and does not claim runtime data was deleted. If an online runtime later lists the session again, it correctly reappears.
- **Delete session data:** requires the authoritative runtime to be connected, releases the live session, and deletes its session file. Only then is the locator removed.

Unavailable sessions show **Remove from list**, not a misleading successful **Delete** action. **Forget runtime** removes the saved connection and all host-side locators for that runtime, but never claims to delete runtime-owned session data.

## Connection and recovery

Command-backed providers keep desired session subscriptions and automatically reconnect with exponential backoff. After reconnect they resubscribe to remembered sessions.

On transport/runner death the host:

- broadcasts runtime connection state;
- clears running/tool/activity enrichment maps for sessions routed there;
- broadcasts terminal unavailable state so rows do not remain “running” forever;
- never falls back to local.

Deep links and WebSocket hello for an unavailable explicit runtime return a locator/recovery state rather than a local state. Requests without an explicit runtime are local for compatibility and never infer routing from locator metadata.

## Runtime manager UX

Normal users use guided forms for:

- Apple container exec;
- Docker exec;
- Podman exec;
- SSH host aliases.

The server generates constrained commands for guided adapters and verifies runner health/protocol before registration. For Apple container, Docker, and Podman it first inspects the network and rejects an unproven policy. Apple must use a `hostOnly` network with `--no-dns`; Docker/Podman must use `--network none`. Internal Docker/Podman bridges are rejected because embedded DNS can remain an egress channel. Advanced command runtimes cannot be proven by pi-web and are labeled `unverified`.

Raw command JSON remains under an Advanced disclosure and requires `PI_WEB_ALLOW_CUSTOM_RUNTIMES=1` outside development/mock mode because it is persistent authenticated host command execution.

## Validation requirements

- Local behavior remains unchanged with no extra runtime.
- Runner-owned session list and pagination.
- Cache-first runtime-scoped drawer reconciliation.
- Per-tab workbench persistence with runtime-scoped tabs, session drawer, folders, models/auth, git, artifacts, composer, and tools.
- Cross-runtime session navigation requires an explicit workbench switch or another browser tab.
- Explicit runtime routing for state/messages/prompt/model/git/artifacts/open/delete and WebSocket hello.
- Durable Docker session-volume command construction.
- Typed host model broker with host-authoritative endpoint/auth resolution and cancellation.
- Zero-egress managed containers and guided network-inspection rejection tests.
- Proof that runtime-supplied credentials/headers cannot cross the broker contract.
- Offline remove versus online delete semantics.
- Reconnect/resubscribe and stale-running cleanup.
- Full typecheck, unit/API/runtime tests, E2E suite, and production build.
