# Pi and native harness sessions

Pi, native Codex, Claude and Kiro use **one local session service, one live-handle cache and the existing browser UI**. Kiro is **Supported (deterministic peers)**; **Unverified: real canary pending**. This is an opt-in implementation under review, not a full-parity, release or deployment claim. The historical independent verdict below covers the accepted three-harness base, not fresh Kiro acceptance.

**Last independent verdict: PASS with documented limits on `2f007fca7710729bb29fbc4af99eb8fd3ef32159`**, 2026-09-14. The preceding verdict on `47e14fb` was FAIL because the explicit Claude executable's `--version` child bypassed `8788bb0`'s runtime-token filtering; repair `3f3727c` applies the existing policy to that preflight, and the auditor re-ran both unchanged probes plus the full suite on `2f007fc`. The Pi abort/display (`b312d6d`), drawer-test readiness (`47e14fb`) and Codex optional/null (`2c5101c`) repairs retain their scoped evidence. The [compatibility matrix](native-compatibility.md) distinguishes the historical FAIL, the accepted repair and still-unrun actual/platform gates.

## The exercised path

HTTP operations dispatch through `LocalSessionService` to an owned behavioral handle. Adapter events return through the same service subscription and host relay; native messages do not use the Pi mock broadcaster or require a second server.

```mermaid
flowchart LR
  Browser --> API[HTTP API]
  API --> Service[LocalSessionService]
  Service --> Pi[Pi handle]
  Service --> Codex[Codex handle]
  Service --> Claude[Claude handle]
  Service --> Kiro[Kiro handle]
  Kiro --> ACP[Kiro v2 ACP child]
  Kiro --> Relay
  Pi --> SDK[Pi SDK]
  Codex --> App[Codex app-server]
  Claude --> Query[Claude SDK Query]
  Pi --> Relay[Service event relay]
  Codex --> Relay
  Claude --> Relay
  Relay --> WS[Host WebSocket]
  WS --> Browser
  Service --> Bindings[Web identity metadata]
```

A **harness** chooses the agent; a **runtime** chooses where it runs. Here Pi runs in the host process, Codex owns an app-server child, and Claude's SDK owns its native child. The child processes are native implementation details, **not** the #119 pi-web NDJSON runner. Kiro's leaf uses ACP v1 over an owned stdio child. A general ACP binding, Docker, SSH, remote-runtime selection and cross-harness transcript migration are not implemented by this work. [Runtime binding constraints](runtime-binding-design.md) remain separate; no extra router or universal tool/session framework is reserved for them.

### Ownership in source

| Owner | Current responsibility |
| --- | --- |
| [`server/session/adapter.ts`](../server/session/adapter.ts) | `SessionAdapter.create/open/list` and `SessionHandle.state/messages/prompt/interrupt/respondInteraction/cancelInteractions/subscribe/dispose`. Native SDK objects do not cross this contract. |
| [`server/session/service.ts`](../server/session/service.ts) | Web-ID lookup, the live cache, coalesced opens, input admission, Pi-only operation gates, viewer/work leases, initialization publication and disposal. |
| [`adapters/pi/adapter.ts`](../server/session/adapters/pi/adapter.ts), [`pi/index.ts`](../server/session/adapters/pi/index.ts) | Actual `createAgentSession`, resource/extension binding, Pi projection, model/command/tree/shell operations, queues, retry compatibility and SDK shutdown. Rich Pi methods stay explicit on `PiSessionHandle`. |
| [`adapters/codex/index.ts`](../server/session/adapters/codex/index.ts), [`transport.ts`](../server/session/adapters/codex/transport.ts) | Native app-server handshake, thread/turn/item/request correlation, authoritative thread activity and owned JSONL transport. No Pi model/tool executor is substituted. |
| [`adapters/claude/index.ts`](../server/session/adapters/claude/index.ts), [`native.ts`](../server/session/adapters/claude/native.ts) | Lazy `query()` input, native SDK readers/resume, query-generation guards and the documented native process seam. `transcript.ts` and `approvals.ts` project content and resolve native controls. |
| [`adapters/kiro/index.ts`](../server/session/adapters/kiro/index.ts), [`transport.ts`](../server/session/adapters/kiro/transport.ts) | CLI 2.24.0 preflight, ACP v1 new/load/prompt/cancel, sparse content and once-only decisions. Public catalog discovery filters the observed v2 source; nonempty/historical replay remains unverified. [Kiro evidence and limits](kiro-native.md). |
| [`adapters/nativeEnvironment.ts`](../server/session/adapters/nativeEnvironment.ts) | One copy/filter policy for the Codex transport, Claude explicit-executable version preflight and final SDK callback, and Kiro version/catalog/ACP children. Excludes the case-insensitive exact `PI_WEB_TOKEN` key, preserving other native auth/configuration and input maps. Pi does not use it; it is not an OS sandbox or a general environment policy. |
| [`nativeBindings.ts`](../server/session/nativeBindings.ts) | Atomic pi-web-owned web/native identity, cwd, display metadata and removal tombstones. It is not a native transcript store. |
| [`dto.ts`](../server/session/dto.ts), [`hostEvents.ts`](../server/session/hostEvents.ts), [`activity.ts`](../server/session/activity.ts) | Serializable snapshots, ordered parts, interaction lifecycle, host activity decoration and browser wire events. Native protocol types remain in their adapters. |
| [`server.ts`](../server.ts), [`server/realtime.ts`](../server/realtime.ts) | Authenticated HTTP/WS entry, lazy native factory registration, realtime sequencing/replay, host files/Git/UI metadata and completion plumbing. |
| [`src/app/sessionState.ts`](../src/app/sessionState.ts), [`src/realtime/realtime.ts`](../src/realtime/realtime.ts) | Per-session browser state and event reconciliation. [`messageList.ts`](../src/messages/messageList.ts), [`content.ts`](../src/messages/content.ts) and [`toolCards.ts`](../src/tools/toolCards.ts) consume the shared transcript. |
| [`server/mock.ts`](../server/mock.ts) | A controllable Pi SDK peer. It emits through SDK subscription ingress; it is not a second browser event path. Native tests have their own protocol/SDK peers. |

The Pi adapter's raw-session `WeakMap` only associates extension callbacks with their owning Pi handle. Its bridge sinks do not replace the service's live cache or introduce another operation dispatcher.

## From operation to visible behavior

The full [matrix](native-compatibility.md#feature-matrix) adds native operation names and per-feature test provenance. These are the application entry points they share:

| Application operation | Handle/contract | Actual consumer |
| --- | --- | --- |
| `GET /api/harnesses`; `POST /api/sessions/new` | Catalog plus `SessionAdapter.create` → `SessionSnapshotDto` | [`sessionDrawer.ts`](../src/sessions/sessionDrawer.ts) and [`harnessChoice.ts`](../src/sessions/harnessChoice.ts), in the landing and drawer flows |
| `GET /api/sessions`; `POST /api/sessions/open` | Adapter `list/open`, web binding → `SessionInfoDto` / snapshot | Drawer identity badges, open/history loading and [`sessionInfo.ts`](../src/sessionInfo/sessionInfo.ts) |
| `POST /api/prompt`; `POST /api/abort` | Handle `prompt/interrupt` → `PromptReceiptDto` / `InterruptReceiptDto`; later authoritative snapshots | [`composer.ts`](../src/composer/composer.ts), status and realtime state; HTTP 202 alone does not clear Stop |
| `GET /api/messages`; transcript events | `MessageDto.parts` and keyed start/part/delta/replace events | Existing message list, thinking/tool cards, inline images and diff affordances |
| `POST /api/interactions/respond` | `InteractionResponseDto` → owning handle's native validation | [`interactions.ts`](../src/realtime/interactions.ts), pending snapshots and request/resolved events |
| `POST /api/session/name`; `POST /api/sessions/delete` | Pi SDK name/delete, or native web metadata update/tombstone | Status-bar name and drawer; native removal explicitly retains native history |
| Pi context/tree/models/commands/shell/contributions | Explicit `PiSessionHandle` methods guarded by the service | Existing inspector, tree, model settings, composer and extension surfaces; not native API emulation |

Omitted `harnessId` means Pi. Selecting another harness creates another session; it never retags the landing Pi UUID. Unknown, disabled or unavailable selection fails without Pi fallback. Catalog availability describes an installation, not working authentication, model entitlement or completed native initialization.

## Identity and persistence

| Field | Meaning and limits |
| --- | --- |
| `sessionId` | Public web identity. Pi retains its SDK UUID values for extensions, API/spool references and existing history. Codex/Claude/Kiro receive independent web UUIDs. |
| `nativeSession.sessionId` | Actual Codex thread / Claude session / Pi session identity. It may be absent before native assignment. Pi's equal UUID value does not merge the structural roles. |
| `activeExecution.id`, `owner: "host"` | A live host stale-command guard, not a native turn or durable replay ID. |
| `activeExecution.nativeExecutionId` | Only a real native execution ID: Codex `turn.id` when known. Pi/Claude omit it; Claude assistant API IDs and wrapper UUIDs are not turn IDs. |
| Message/part IDs; `nativeItemId` | Stable rendering keys and separately exposed native item identity. They are not control-request IDs or new web sessions. |
| Interaction `id` | Web request identity; the adapter retains exact native request/tool/process scope. Numeric native request ID `0` is valid and is not replaced by a truthiness test. |
| `sessionFile` / listed `path` | Optional Pi compatibility metadata only. Native resume never uses a fabricated Pi path. |
| Listed `created` / `modified` | Creation time is optional because Kiro's public catalog exposes only `updatedAt`; display ordering uses modified time, without inventing creation time. |

Persistent does not mean already materialized. Codex storage may appear only after native acceptance; Claude can allocate an ID before its first Query. A cached `unmaterialized` or `unavailable` label is an observation: supported native resume/read APIs determine whether persistent history now exists. Live ephemeral handles are reused; after loss they expire with 410, without recreation. There is no browser persistence-mode selector or HTTP `persistence` field in `/api/sessions/new` at this snapshot.

Kiro uses public CLI listing and ACP load replay; no private store is parsed. Only source-v2 catalog rows are eligible for native discovery. A separate real zero-model probe proved immediate persistence and fresh-child load for one newly created empty session; historical/nonempty replay remains unverified. Kiro rejects ephemeral creation rather than deleting history afterward.

Pi keeps its existing SDK/session-format handling inside its adapter. Codex uses public thread operations; Claude uses `listSessions`, `getSessionInfo`, `getSessionMessages` and Query `resume`. The host does not parse Codex/Claude private JSONL or databases. Native handles keep an in-memory transcript for display; the binding file stores only identity and display metadata, including a first-prompt preview.

Binding read/merge, validation, candidate construction, atomic rename and in-memory publication share one queue. State/discovery writes merge against the last successful row, preserving renames, previews and tombstones. Failed writes do not publish a candidate. Removing a native binding does not delete native history; Pi retains its existing trash/delete operation.

A cold lookup can lazily open a saved binding. That is different from repeatedly recovering a dead cached handle: ordinary state/message polling neither replaces that unavailable handle nor retries a failed native open. Explicit open resumes the same native identity. No host prompt replay is used to repair a failed or ambiguous dispatch.

## Initialization, acknowledgement and settlement

Creation registers early enough for startup interaction responses, but buffers ordinary state/agent/runtime/contribution publication through Pi defaults and the host post-create finalizer. The initial native binding must commit before publication. Native open also registers tentatively until its metadata refresh succeeds; a failure disposes/unsubscribes the handle and removes it from the usable cache. HTTP operations and WS hello use admission checks. These rules reuse the service's initialization state, not a second lifecycle manager.

| Boundary | Pi | Codex | Claude |
| --- | --- | --- | --- |
| Prompt receipt | `not-exposed`: SDK dispatch has no equivalent native acceptance receipt | `turn/start` acceptance exposes real turn ID; ambiguous timeout stays pending and is not resent | Async input dispatch is pending until user replay/first-reply correlation provides acknowledgement |
| Active input | Existing steer/follow-up queue behavior | Only ordinary idle `prompt`; no implicit active-turn steering | Only ordinary `prompt`; no hidden queue across a live execution |
| Stop target | SDK abort, optional matching host guard | Required host guard → exact native `turn/interrupt` thread/turn | Required host guard → captured live Query/generation; delayed control failure cannot fail a newer execution |
| Terminal versus idle | SDK `agent_settled`, including existing retry compatibility, not `agent_end` alone | Completed item/turn is not idle; thread activity remains authoritative | Result ends a turn, then native `session_state_changed: idle` settles it; the documented idle-event opt-in is requested |
| Lost process versus model error | Existing error/retry behavior retained; explicit abort now takes precedence over a simultaneous transport diagnostic | Unavailable transport invalidates active work/requests | Lost Query is unavailable; a model-result error on a usable Query is a different state |

Kiro's producer gate is green on `9dcc6f3`: full parallel `npm test` has 853 unit passes with two existing skips, and 897 browser passes with 55 existing skips, with zero failures/retries. The same gate exposed and repaired an inherited shared scroll-input race without changing snapshots or weakening its original assertion. [Kiro validation](kiro-native.md#recorded-producer-gate--2026-09-24) separates deterministic evidence, real zero-model shape probes and pending real-model acceptance.

Kiro's distinct lifecycle is **Supported (deterministic peers)**: prompt dispatch reports `not-exposed`; the outstanding ACP prompt response supplies the exact terminal stop reason and ends the turn. Stop validates the host guard, sends a cancel notification, and remains busy until that response. It does not fabricate native acceptance or an execution ID. Once-only decisions are exact offered options; remembered scopes remain disabled. [Kiro native](kiro-native.md) documents replay, consent bounds and unverified real sequencing.

`phase`, `activity`, pending requests and the active guard travel in `SessionSnapshotDto`. No universal sequence requires every run to emit every phase. Native terminal failures close unfinished tool *presentation*, without inventing a tool result or claiming that filesystem effects were rolled back.

## Transcript and decisions

`message_start`, `message_part`, `message_delta` and `message_replace` address stable message/part keys. Ordered text, exposed thinking, tool calls/results and inline images use the existing renderer. Codex command-output deltas can address text nested inside a tool result; authoritative final items replace the final aggregate, rather than resending every accumulated prefix. Claude reconciles partial events with separate per-block finals that can share one assistant API ID. Pi retains its legacy raw/event fidelity path; native messages do not impersonate it.

Unknown native per-item history times are omitted, not replaced with reopen time. Incremental native text does not have a claimed exactly-once replay guarantee: native final items and supported history readers are authoritative. Browser sequence replay and pending-interaction hydration are separate from native transcript replay.

**Pi abort presentation is repaired in `b312d6d`** (owned `5c2db66`). The inherited baseline defect preferred an `errorMessage` over retained parts even when `stopReason` was `aborted`. Projection, raw-text fallback and live/history rendering now preserve partial content, exclude aborts from failure/retry grouping, and retain the incomplete-response/Continue affordance. A tool without a recorded result is shown as interrupted, not successful or still running. [`pi-stopped-projection.test.ts`](../tests/pi-stopped-projection.test.ts) cold-opens a copy of captured JSONL through public SDK APIs; [`pi-stopped-replay.spec.ts`](../tests/e2e/pi-stopped-replay.spec.ts) supplies projected history and scripted WebSocket events to the real renderer. These are explicitly **captured-data/synthetic replay**, not a fresh provider run: the original actual canary's cold service restart remains **NOT RUN**.

A request includes adapter-owned choices, context and expiry. The browser returns the web session/request IDs and an offered `choiceID` or validated answers; it cannot supply arbitrary native grant JSON. Decline/continue, cancel/interrupt, once/session grants and Claude permission suggestions remain distinct. Duplicate, expired, foreign or already-resolved replies cannot grant again. Disconnect/timeout/disposal take the adapter's documented no-grant path.

**Decision fidelity remains a final review gate.** Codex `617ab3f` separates diagnostics from complete, reversible consent JSON, with a 32 KiB UTF-8 limit over the whole rendered context. Its original command-tail/URL probes independently passed twice, plus 24 controlled native browser cases, on that earlier pin. `2c5101c` (owned `ec3eade`) then repairs schema-valid omitted/null `network.enabled`, `fileSystem.entries` and `globScanMaxDepth`: no default grant is inserted, supplied nested representations and native choice/scope mappings survive, and existing top-level null omission stays unchanged. Its unchanged six-case probe is producer-green twice and passed independent rechecks at `47e14fb`; the later preflight omission, not this permission mapping, caused the overall FAIL.

Credential-like, concealed, oversized or ambiguous context still cannot grant; URLs with userinfo, query strings or fragments are conservatively deferred. Exec/network policy amendments remain unavailable. `environmentId` is native context identity, not an environment-variable dump. Current request fields, not possibly shortened history, are authoritative. These conservative limits and **unobserved actual prompted approvals** remain explicit; the null repair is compatibility, not broader permission policy.

## Extensions and host features are different layers

Both regular Pi extensions and pi-web contributions are loaded by Pi's runtime, not a harness-neutral extension engine. Neutral browser components can be reused without claiming that a Pi extension's tools, callbacks or registration execute under Codex/Claude.

| Surface | Current dependency and treatment | Provenance |
| --- | --- | --- |
| Pi tools, hooks, skills, prompts, instruction files and injected web context | Pi resource loader/SDK, preserved in Pi. Native loaders/configuration remain native; Pi's `contexts/web-ui.md` is not injected into them. | Pi `make/context/commands`; `context.test.ts`, `pi-adapter-sdk.test.ts` |
| `select`, `confirm`, `input`, `editor`, notifications/status and editor effects | Existing Pi web bridge, with session-scoped pending/resolved lifecycle. Native approvals/questions use their own mappings, not Pi hook interception. | `server/extensions/webUi.ts`; `extensions.test.ts`, `session-service.test.ts` |
| Terminal components, custom TUI, terminal input, theme/editor replacement | No browser terminal exists. Several existing bridge methods are no-ops; `custom()` returns no component. This is not full Pi TUI-renderer parity. | `createWebExtensionUiContext`; no positive browser claim for these methods |
| Same-session tree navigation versus a new history fork | Pi `navigateTree` remains available. All `historyFork` flags are false; bridge-initiated fork/session switching reject. Provenance is not copied history or filesystem rewind. | Pi `navigate`, `bindWebExtensions`; `conversation-tree.spec.ts`, `message-actions.spec.ts` |
| Footer, FAB, header action, panel, Git tab, artifact action/preview, new-session field | Registration/invocation requires Pi. Native snapshots expose no Pi contributions; native UI hides them and service methods reject. Generic built-in renderer reuse is not a native contribution host. | `webUi.ts`, `src/main.ts`; `extensions.test.ts`, `web-panel.spec.ts`, birth-field specs, `native-harness.spec.ts` |
| Extension settings and system-info contributions | Registrations come from Pi; settings remain retained/global Pi extension data, not native configuration. Native settings UI disables Pi editing/reload. Built-in system information remains a host feature. | `webUi.ts`, `src/settings/extensionSettings.ts`; `web-ui-settings.test.ts`, `system-info.spec.ts`, native gate tests |
| `sessions_*`, notepad and delegation spool | Pi tools/examples using scoped extension HTTP and existing UUIDs. No native tool registration or worker-spawn port is promised. | `examples/pi-web-extensions/session-orchestrator.ts`, `notepad/`; `session-orchestrator.test.ts`, `notepad-extension.test.ts` |
| Worker obligations, lineage and reference chips | Host UI consumes explicit web-session metadata/dependency declarations. Native subagent items do not create host workers or settlement obligations. | `server/session/settlement.ts`, `src/sessions/settlementDependencies.ts`, `src/app/sessionRefs.ts`; settlement/lineage/reference tests |
| Custom messages versus built-in tool rendering | Pi custom message text/details/display flags remain readable. Native ordered parts reuse generic cards; custom native/TUI renderer registration is not implemented. | `projection.ts`, `messageList.ts`, `toolCards.ts`; custom-message and native-part tests |
| Files, Git and built-in artifacts | Host routes and cwd-scoped viewers operate independently of the agent. Their operator authority is not the native tool sandbox. Extension-specific artifact actions remain Pi-only. | `server/shared/workspaceFiles.ts`, `src/files/`, `src/git/`, `src/artifactPreview.ts`; workspace/files/Git and native-browser tests |

See [pi-web extensions](pi-web-extensions.md) and [scoped extension HTTP](extension-http.md) for the existing APIs and trust model, not instructions to port them automatically.

## Configuration and review boundary

The server alone accepts executable/argument overrides. `PI_WEB_MULTI_HARNESS=1` enables selection; Pi remains the default. Native effective settings are read-only in `modelSettings.ts`; Pi's registry/defaults/credential configuration are not fallback native settings. Claude preserves its native prompt/settings sources, narrowly removes the pinned SDK's unsolicited default-permission argument, and opts into authoritative idle notifications. Details and pins are in [Codex](codex-native.md), [Claude](claude-native.md) and [Kiro](kiro-native.md). Kiro has no model or mode mutation API in the web UI. Its CLI preflight, catalog and ACP children all apply the same native environment exclusion.

Browser authentication and native provider authentication are separate. No new native login UI is added. Unknown ingress diagnostics omit/redact payloads, and arbitrary auth output is not a transcript feature. **Runtime exclusion in `8788bb0` was incomplete:** its tests and original probe entered Claude through `createClaudeQuery()`, missing `ClaudeHandle.ensureQuery()`'s preceding `execFile(--version)`. The independent matching-version probe observed the token in that first child, despite exclusion from the second.

**`3f3727c` repairs the missed preflight with the same helper**, without changing version validation, SDK configuration or explicit-env semantics. The production-`createClaudeAdapter` regression now checks both distinct children, exact native sentinels and unchanged parent/caller maps; matching/rejected-version audit probes are producer-green twice. Pi's environment remains unchanged. The fresh independent audit of `2f007fc` accepted this repair. This is narrow credential separation, not isolation of the host filesystem, every secret or arbitrary trusted custom spawn code.

**Native browser-test readiness is repaired in `47e14fb`** (owned `5aafef8`, test-only). Drawer creation waits for its actual post-create state hydration and overlay closure, then uses normal pointer focus. Desktop keeps its side-by-side drawer; landing adopts the create snapshot and does not wait for a drawer-only GET. The regression delays a real request without replacing its content. It changes no production UI behavior and does not excuse the historical hidden-Send flake.

Use the [setup and validation recipes](native-compatibility.md#setup-and-reproducible-validation) with an explicit Chromium cache, non-artifact validation cwd and free owned runner ports outside the platform's ephemeral range. The auditor verified the prior independent full `npm test` at `47e14fb` (797 units / 2 skips; 888 browser passes / 55 skips; zero retries), then added fresh focused checks and the blocking preflight counterexample. The architecture was judged acceptable for this local scope; **the `47e14fb` verdict was nevertheless FAIL, not superseded by green regression counts**. The repaired pin `2f007fc` then passed the independent audit: full parallel `npm test` 799 units / 2 skips; 888 browser passes / 55 skips; zero failures/retries, plus both unchanged B1 probes. Actual Pi cold restart, prompted native approvals and canonical macOS/Windows execution remain unrun; no paid budget or deployment authorization is implied.
