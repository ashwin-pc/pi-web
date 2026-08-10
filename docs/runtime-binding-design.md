# Per-session runtime binding design

GitHub issue #3 proposes running normal host sessions and sandboxed sessions at the same time. Runtime selection is per session; changing where one session runs must not create a reduced pi-web feature set.

## Product invariants

- Local behavior remains the default and must not change.
- A session is authoritative on the box where it runs. The host keeps connection configuration and routing metadata, not a second transcript.
- Runtime choice changes the trust boundary, not the session feature surface.
- Missing, stale, or conflicting bindings fail closed. They never fall back to the host.
- Session IDs remain the user-facing identity. Runtime information is a routing attribute.
- Managed runtimes and user-managed runtimes may have different lifecycle and network policies, but they use the same session API.

## Staged architecture

```text
Browser
  -> HTTP/WebSocket serving layer
  -> binding-authoritative SessionRouter                 (Stage 4)
       -> local SessionService in process
       -> RemoteSessionService -> stdio runner
                                  -> same SessionService  (Stage 3)
  -> runtime providers, model broker, management UI      (Stage 5)
```

### Stage 2 and 2.5: one self-contained local service

`server/session/service.ts` owns all box-local session behavior:

- live-session cache and lookup;
- viewer/work leases, idle cleanup, shutdown, and disposal;
- session creation, opening, deletion, listing, and cwd switching;
- prompts and image persistence, retries, tree navigation, slash/shell commands, models, and projections;
- extension loading and extension web-UI bindings.

The service can be constructed without `server.ts`. Its dependency interface contains only six box externals: the canonical model/auth runtime, an optional session factory (used by the mock harness), extension paths, session configuration, global cwd, and browser client count. Session configuration groups settings defaults with one host post-create finalizer; every creation path awaits that finalizer before it can publish state, so host-owned default bucket state remains ordered ahead of `state_changed` even for extension-created sessions.

`server.ts` remains the serving layer. It owns the current-session route default, browser viewer sockets, activity/tool-timing decoration, realtime sequencing, unread state, session UI state, and current-tab UI-state transfer. State returned by the service is `BaseSessionStateDto`; the serving layer adds host-only fields as a typed intersection before sending it.

### Event boundary

`SessionService.subscribe()` emits serializable `SessionServiceEvent` values. Harness events cross this boundary as the typed, agent-neutral union defined by the Track-0 mapping; pi's exhaustive adapter lives in `server/session/piEventMap.ts`. Heavy content is sent once through deltas and committed-message projections rather than copied into lifecycle events. Unknown harness variants remain visible through `harness_event`. State, capabilities, stats, blocked-model updates, interactions, errors, and shutdown are explicit typed variants. See [multi-harness-design.md](./multi-harness-design.md).

The local implementation JSON-round-trips each event before delivery. This normalizes unsupported non-JSON values at the future runner boundary rather than exposing in-process-only behavior. Listener failures are isolated so one serving adapter cannot interrupt wire-order delivery.

The local server subscribes once. For each agent event it performs host activity enrichment and preserves this browser wire order:

```text
agent_event
session_runtime_changed
[state_changed]
[session_stats_changed]
[models_updated]
```

`agent_settled`, not `agent_end`, is the authoritative idle transition. Durable `entry_appended` semantics travel through `committed_message`. Generic `interaction_request` values use the same service event sink. Browser activity, realtime replay/sequence numbers, unread tracking, and UI stores remain outside the runner protocol.

`NavigationResult.finish()` is the one intentional non-serializable value. It is a serving-side finalizer: the serving adapter writes the navigation response and calls `finish()` in `finally`. A future remote runner must likewise finalize after writing its own response; the callback is never sent over stdio.

### Stage 3: runner transport

The runner is a thin transport over the same `LocalSessionService`, not another implementation:

- newline-delimited request/response dispatch;
- forwarding `SessionServiceEvent` values;
- a health handshake containing protocol version and build hash;
- fail-closed rejection of incompatible builds.

A typed `SessionApi` is derived from the service interface. The service contract suite runs both in process and over a spawned runner, creating a permanent parity ratchet. The runner contains no projections, lifecycle policy, capability matrix, or feature-specific session logic.

### Stage 4: binding-authoritative routing

A `RuntimeRegistry` owns the local service and dynamic runtime providers. A `SessionRouter` resolves persisted bindings before every session-scoped operation:

1. A stored local binding routes to the in-process service.
2. A stored remote binding routes to that runtime's `RemoteSessionService`.
3. An explicit runtime that conflicts with the binding returns a conflict.
4. A missing/unavailable provider returns an unavailable response.
5. No case silently executes against the host.

Creation binds transactionally. Delete/release, WebSocket hello, reconnect, and provider replacement all pass through the same router and lifecycle rules.

A first binding store may live at `.pi/web/runtime-bindings.json`; it is server-owned metadata rather than part of the core pi session format.

### Stage 5: providers, broker, and UI

After parity and routing are enforced, add runtime providers and product UI:

- stdio clients and command/container/SSH providers;
- managed-runtime network isolation;
- a host-side model broker for approved model operations without copying host credentials into managed runtimes;
- runtime connection and health management;
- an explicit per-browser-tab workbench runtime selector;
- runtime-scoped folder browsing and session creation.

Provider implementations vary only transport and lifecycle. Frontend capability gates are not used to excuse service drift.

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

Bindings map `sessionId -> { runtimeId, harnessId }`; `runtimeId` resolves to a `RuntimeRef`. Cwd history is runtime-relative. Harness capabilities come from the selected harness and must be identical across transports. The drawer may render cached locator rows immediately and reconcile in the background, but a successful authoritative runtime listing is required before removing stale rows.

## UX and lifecycle rules

- The active workbench runtime is per browser tab, never server-global.
- Opening a session shows its runtime context; changing the new-session default is explicit.
- “Remove from list” removes host locator metadata and works offline.
- “Delete session” requires the authoritative runtime and deletes the underlying session there.
- Runtime disconnection shows reconnect/recovery UI and never triggers local fallback.
- Managed ephemeral containers need durable mounted session storage or must be labeled disposable.
- Brief transport loss reconnects and resubscribes; confirmed runner death clears running/activity state.

## Validation strategy

- The in-process standalone service test covers create -> prompt -> state/messages/events without importing `server.ts`.
- Every service result and emitted event must be JSON-round-trip stable.
- Source guards keep Pi session member access out of route bodies and retain response-before-navigation-finalizer ordering.
- Stage 3 runs the same contract suite over stdio.
- Stage 4 tests absent runtime IDs, explicit conflicts, stale providers, cloned IDs, WebSocket hello, release, and transactional create.
- Provider tests cover reconnect, isolation, broker validation, and authoritative reconciliation.
- Full browser tests continue to verify unchanged local behavior and extension web UI.
