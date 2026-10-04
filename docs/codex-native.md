# Native Codex sessions

Pi remains the default. Set `PI_WEB_MULTI_HARNESS=1` to enable the registry-backed agent picker and native session creation. The catalog at `GET /api/harnesses` is also the server's routing/validation authority; it reports capability and host-command availability without starting agents.

## Trusted host configuration

Use the existing installed Codex, its native authentication, and its configuration. This integration does not install Codex, read its private session database, select a provider, or override its model, approval policy, or sandbox.

```sh
PI_WEB_MULTI_HARNESS=1 \
PI_WEB_CODEX_COMMAND=/absolute/path/to/codex \
PI_WEB_CODEX_ARGS='["app-server","--listen","stdio://"]' \
 npm start
```

Without the command setting, the server resolves `codex` on its own PATH. A browser cannot supply an executable, process environment, arguments, native home, or permission policy. `PI_WEB_NATIVE_BINDINGS_FILE` optionally selects the host's web/native identity metadata file.

**Exact supported handshake: `0.155.0-alpha.16`.** Other versions are rejected before creating/resuming a thread. The experimental generated schema and hash are pinned in `tests/fixtures/codex-0.155.0-alpha.16/`. Upgrades require schema comparison, handshake tests, and bounded native acceptance—not loosening the guard. Server settings cannot bypass this pin.

## Contract and ownership

`server/session/adapter.ts` defines the shared `SessionHandle`: identity, snapshots, messages, acknowledged input, execution-guarded interruption, interactions, subscriptions, and asynchronous disposal. `PiOperations` is an independent compatibility interface, not a `Pick` of its concrete implementation. The optional adapter `piCompatibility` facet declares legacy file/history lookup/removal separately from the `webIdentity: "native" | "host"` allocation policy. Generic persistence, discovery and recovery inspect these declarations, never Pi's name.

`registry.ts` owns descriptors, defaults, availability, capability catalog, and routing. Native discovery skips both disabled and unavailable descriptors before starting subprocesses. Host executable lookup resolves PATH/PATHEXT (including Windows environment-key casing and quoted directories) once for both catalog and launch. Windows `.cmd`/`.bat` launch uses `cross-spawn`; Unix retains its anchored guardian without adding a shell. Its constructor accepts the default registration ID (otherwise the first registered adapter) and does not require Pi. Application bootstrap still registers Pi by default; `LocalSessionService` accepts a configured default and additional adapters without routing edits. Deterministic tests register the real Codex adapter under a local host identity using its `registrationId` option and a native protocol peer—not a fake production agent. That registration option is not exposed to browser requests.

`SessionService` owns admission, host execution IDs, viewer/work leases, live handles, subscription retirement, and native bindings. Pi keeps its existing SDK factory/runtime resource owner and supplies an explicit typed `piOperations` group for models, extensions, history, citations, commands, compaction, and retry. Generic consumers have no raw SDK accessor. The native adapter is a production stdio JSON-RPC client, not a prompt-driven simulator; deterministic subprocess peers exist only under tests. On Unix, an owned Node guardian anchors the subprocess group while the native wrapper and descendants run. Native EOF/natural exit does not retire that anchor: cleanup completes TERM/KILL independently of wrapper close, and the host stops signalling a group once its owned leader has exited. The guardian also kills its own anchored group on host IPC disconnect. Native stderr is never forwarded.

Native web UUIDs and native thread IDs are different. Only binding metadata is stored by pi-web: identity, cwd, title/first-message summary, persistence status, and timestamps. Discovery lookup/allocation/upsert by registration/native identity is one queued operation, so overlapping cwd requests return one canonical web ID and preserve tombstones. Native transcripts are loaded through `thread/resume`/public protocol methods. Creating a thread does not imply durable history; a persistent session becomes resumable after observed native materialization. Polling a dead handle does not recreate it or replay input: explicit open resumes the persisted native identity. Removing a session forgets/tombstones its web binding; **native history remains untouched**.

## Browser/API behavior

- Select an available agent before creating a session. Registry capabilities gate Pi-only actions; there is no agent-name switch in browser behavior. Empty-session reuse requires the selected registration identity in its canonical candidate helper, including cold hydration and post-open rechecks.
- `POST /api/sessions/new` accepts `harnessId` and cwd. Omitted agent still selects Pi. Browser executable/environment overrides are ignored.
- `POST /api/prompt` acknowledges acceptance, not completion. Native receipts carry both a host execution ID and native turn ID. Failed identity-metadata persistence after accepted dispatch reports an error without converting it to a replay-inviting rejection.
- Native execution phases are authoritative. An interrupt receipt is not an idle signal; settling lasts until terminal native turn/thread observations. Native Stop sends `expectedExecutionId`; stale/missing guards are rejected. The canonical browser Stop action catches HTTP/transport rejection, reconciles authoritative state, then displays feedback; it never retries or retargets. Pi predecessor interruption/finalization captures its execution and lease tokens, so late A cleanup cannot clear B's gated startup.
- Native text, thinking, and tool results have stable thread/turn/item-derived message/part keys. Completion replaces provisional content. Hydration neither reconstructs fake Pi messages nor invents missing timestamps. Initial transcript events buffer until authoritative history loads rather than invalidating that load. Optional host observation revisions make buffered/replayed events idempotent against snapshots, including recovery snapshots; these process-scoped ordinals are not native timestamps or persisted native history. Inline tool images are supported; file-ID image references have explicit unsupported placeholders, not guessed URLs. Tool result details, including file diffs and structured MCP JSON, render as escaped, wrapped text in disclosures in both live and hydrated transcripts.
- Native approvals use session-scoped opaque choices with response validation. Pending interactions are included in reconnect snapshots. Unsupported/dangerous requests fail closed; native process loss is not an approval outcome.
- Unknown cost/context/usage is omitted or shown unavailable, never fabricated as zero. Effective native model/reasoning settings are read-only; native attachments, queues, model selection, extensions, bash, retry, and history mutation are not advertised.
- Pi retains its existing session-file/API compatibility, prompt capture, citation/retry handling, #163 execution/checkpoint fixes, and #165 lifecycle/disposal protections.

## Validation

Deterministic adapter/transport/approval/service tests cover ingress, strict version rejection, unknown/malformed/late responses, provisional/final projection, process loss, resumable identity, exact interruption, cross-session choices, and bounded cleanup. HTTP/WebSocket tests use the normal application server and a controlled native protocol peer. `tests/e2e/codex-native.spec.ts` exercises the production browser/host/transport across normal viewport projects, without route fulfillment or a simulated agent registered in production.

The real acceptance run used the unchanged installed executable/auth/config and three submitted turns total: native read-only file/tool output; exact-turn Stop confirmed by native `thread/read` status `interrupted`; owned app restart followed by same-thread context recall without another tool call. Live approvals were not requested in that run; approval coverage is deterministic, not a claimed live entitlement/policy test. Review screenshots, protocol receipts, diagrams, and logs belong in ignored artifacts, not this tracked documentation.
