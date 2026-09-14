# Native harness compatibility and validation

**Pi, Codex and Claude are wired through the real application, but full parity and final acceptance are not established.** The matrix distinguishes working paths, deliberate limits, known defects and the evidence actually collected.

**Source reviewed:** integration `617ab3fb24d7ffb5772742d75b98dc49c8402089`, 2026-09-14: `0fbe2c1` plus the Codex complete-consent-context fix. This is review-branch code, not a claim about published npm `0.6.0` or upstream `main`. See [the implemented design](multi-harness-design.md), [Codex native details](codex-native.md), [Claude native details](claude-native.md), and [#92](https://github.com/ashwin-pc/pi-web/issues/92).

## Acceptance status first

| Finding / gate | Status at this source pin |
| --- | --- |
| Stopped Pi prose disappears | **Open defect.** Actual Read/stream/guarded Stop/SDK idle succeeded, but `projection.ts` and the live/history error renderers hide retained partial prose when an aborted message also has `errorMessage`. Raw SDK/API/JSONL retains the content. UI repair and baseline attribution are pending; actual cold restart was **not reached**. |
| Native children receive host control credential | **Confirmed, unresolved.** The independent presence-only probe on `0fbe2c1` reproduced twice that Codex and Claude children inherit `PI_WEB_TOKEN`. Those launch environments are unchanged here. Only synthetic credentials/boolean presence were tested; no model call or tool/API exploit was performed. Native auth preservation is not host-secret isolation. |
| Codex consent context | Correction `4466927` is integrated as `617ab3f`; producer's unchanged counterexamples are green twice, with scoped browser coverage. **Independent recheck/acceptance pending.** Conservative context/URL/scope limits below remain; actual prompted approval was not encountered. |
| Mobile native drawer helper | Original hidden-Send flake is not waived. Independent controlled delay reproduced the cause twice: the helper types after HTTP creation but before drawer close, whose focus restoration hides Send. Normal pointer activation after close submits 202. Separate readiness/focus fixture repair is pending. |
| Claude lifecycle corrections | `e691238` / `ef6b994` are integrated in `4a33204` / `0fbe2c1`. The unchanged independent recovery/stale-interrupt/unfinished-tool probes were **4/4 green twice on `0fbe2c1`**. Actual idle opt-in and abort classification have real-CLI/no-real-model regressions. This is not a fresh paid full-flow rerun. |
| Final assembled validation | **Not completed for this pin and remaining fixes.** Earlier full-suite passes remain attached to their exact source snapshots below; they do not override adversarial failures or certify later changes. No independent final correctness/simplicity approval or deployment is claimed. |
| Other unrun checks | Actual prompted approvals for Codex/Claude; broader actual sandbox-denial behavior; canonical macOS execution. Windows is not validated by the recorded Linux runs. These are unrun, not silently inapplicable. |

## Reading the matrix

- **Supported** means implemented with the cited scoped tests/observations, not every native feature or a final release pass.
- **Pi-only** retains the Pi operation and rejects it for native handles. **Deferred/off** means no advertised positive web workflow; where a capability exists it is false and the service/adapter rejects unsupported calls.
- **Native-only** means configured/executed by the native harness, without a pi-web administration or portability claim. **N/A** is reserved for an unexposed transport or terminal-specific surface, with a reason.
- **Known defect / review pending** takes precedence over a green test or a capability bit.

For the production mapping column, **P** is [`PiAdapter` / `PiSessionHandle`](../server/session/adapters/pi/index.ts), **C** is [`CodexHandle` / its factory](../server/session/adapters/codex/index.ts), and **A** is [`ClaudeHandle` / its factory](../server/session/adapters/claude/index.ts). Every application operation uses [`LocalSessionService`](../server/session/service.ts), [`dto.ts`](../server/session/dto.ts) and [`hostEvents.ts`](../server/session/hostEvents.ts). The named test groups resolve to concrete files in the [evidence index](#evidence-index); they are not claims of unseen test coverage.

## Feature matrix

### Sessions, content and lifecycle

| Feature | Pi | Codex | Claude | Native operation → adapter/contract → actual consumer; test provenance |
| --- | --- | --- | --- | --- |
| Select harness; preserve default and identity | Supported default; existing UUIDs | Supported opt-in; new web ID | Supported opt-in; new web ID | `SessionAdapter.create`, catalog / `SessionSnapshotDto` → `sessionDrawer.ts` / `harnessChoice.ts`. **core, browser**: invalid/disabled/unavailable selection never falls back or retags Pi. Drawer-helper defect above remains. |
| Create, list, open | SDK create/open/list preserved | `thread/start`, `thread/list`, `thread/resume` | Lazy handle/UUID creation; `listSessions`, `getSessionInfo`, `getSessionMessages`; Query starts with input | P/C/A factory methods → `SessionInfoDto` and snapshot → drawer/history/session details. **Pi, Codex, Claude, browser**. Claude handle creation is not process startup or durable materialization. |
| Prompt / acceptance | SDK `prompt`; acknowledgement `not-exposed` | `turn/start` accepted turn or ambiguous pending receipt | Async SDK input; native replay/first-reply correlation | P/C/A `prompt` → `PromptReceiptDto`, user transcript events → `composer.ts` / realtime. **core, Codex, Claude, browser** cover rejection/ack/races. Dispatch is not completion; no invented Pi/Claude turn ID. |
| Ordered prose and exposed thinking | SDK events and legacy raw fidelity | Native agent/reasoning item deltas and final items | Partial API events and per-block assistant finals | P event mapping; C `textDelta/projectItem`; A `ClaudeTranscript` → `MessageDto.parts` / keyed transcript events → `content.ts`, `messageList.ts`, thinking cards. **Pi, Codex, Claude, browser, native-ui-state.test.ts**. Redacted/unexposed thinking is not fabricated. |
| Tools, output and terminal status | SDK tool calls/results preserved | Command/file/MCP items; incremental nested output, one authoritative final aggregate | Native tool-use IDs join progress/results; terminal failure ends unfinished presentation | `ToolCallPartDto` → existing `toolCards.ts`. **Codex** tests linear output bytes and races; **Claude** lifecycle tests no dangling running tools or invented results; **browser** checks visible ordering. Actual owned-file observations are separate below. |
| Images and diffs | Existing image/tool/edit/artifact rendering | Inline MCP images; safe file `details.diff` | Inline native image results; structured details retained | C `projection.ts`, A `transcript.ts` → image/result parts → tool-card image/details and diff affordances. **browser** verifies loaded images/live reload and Codex file diff. This does not prove every Claude edit-diff variant or export arbitrary native image paths. |
| Running, retrying, terminal and error state | SDK `agent_settled`, retry/compaction flags; stopped-text defect below | Native turn status plus authoritative thread activity | Result plus authoritative native idle; distinct process loss/model error | P `handlePiEvent`, C `reconcile`, A `receive/settle/fail` → snapshot → `sessionState.ts` / realtime / composer. **Pi, Codex, Claude, native-ui-state.test.ts, browser**. Item end, result or interrupt receipt alone does not establish idle. |
| Exact interrupt | SDK abort; optional host guard | Required host guard → exact native thread/turn interrupt | Required guard → captured Query/generation `interrupt()` | `InterruptReceiptDto` plus later state → composer Stop. **core, Codex, Claude, browser** cover stale/late controls; actual Stop observations below. Claude `still_queued` is not a host queue implementation. |
| Preserve partial content after Stop | **Known defect** in current projection/live/history rendering | Scoped deterministic interrupted-item behavior | Structured abort reason wins over generic native error envelope | Pi actual capture and zero-network projection reproduction are red; repair/replay pending. C/A final parts → shared renderer have **Codex/Claude/browser** coverage. A actual interrupt exposed and motivated its corrected classification; no fresh paid full rerun. |
| Reconnect and concurrent clients | Existing snapshots, queues and attachment reconciliation | Pending requests and transcript hydrate on reload | Pending requests, answer state and live transcript hydrate | `state/messages`, `pendingInteractions`, request/resolved events → realtime/interactions. **browser**, Pi `send-stop.spec.ts` / `session-switch-runtime.spec.ts`. Native incremental text has no claimed exactly-once replay cursor; native finals/history are authoritative. |
| Persistent restart / explicit process-loss reopen | SDK reopen supported; actual cold-restart step **not run** | Supported exact native resume; actual observations recorded | Supported SDK history/resume; actual observations across corrected phases | P `SessionManager.open`; C `thread/resume`; A public readers + Query `resume` → same web binding/history consumer. **core, Codex, Claude, browser**. Claude executable-peer browser restart is a **negative absent-history test**, not positive native persistence proof. |
| Ephemeral/pathless sessions | Existing in-memory mode | Live reuse; expired after process loss | Live reuse; expired after process loss | Native refs omit `sessionFile`; service/adapter refuses expired resume (410). **core, Codex, Claude**. Lifecycle support is tested at adapter/core level; the create HTTP route/browser has no persistence-mode selector. |
| Rename and remove | SDK name; existing trash/delete | Web label and binding tombstone only | Web label and binding tombstone only | `saveNative/update`, Pi rename/remove → snapshot/list → status bar and drawer. **core**, `codex-service.test.ts`, `shallow-session-list.test.ts`. Native removal wording is implemented; a dedicated native removal browser case is not claimed. Native history stays intact. |
| Metadata failure and cleanup | SDK shutdown/extension release preserved | Atomic binding updates and owned process cleanup | Same binding/lifecycle rules; Query cleanup | Existing binding queue → cached/public state; **native-bindings.test.ts**, **core**, **Pi**, native service suites. Failed birth/open cannot leave a usable rejected handle; failed metadata after native prompt dispatch does not falsely reject/replay accepted input. |

Cold lookup may lazily open a saved binding. Polling an already unavailable cached handle or a failed native open does **not** repeatedly respawn it; explicit reopen is the recovery action. Cached persistence status is not native authority, and no recovery path resubmits the previous prompt.

### Decisions, configuration and native distinctions

| Feature | Pi | Codex | Claude | Native operation → adapter/contract → actual consumer; test provenance |
| --- | --- | --- | --- | --- |
| Command/tool approval and scopes | Pi-compatible extension dialogs, not Codex enforcement | Bounded command/file/permission choices; new consent fix **review pending** | `canUseTool`: allow once, exact suggested changes, deny, deny-and-stop | Native `approvals.ts` → `InteractionRequestDto` / validated response → `src/realtime/interactions.ts`. **Codex, Claude, browser** exercise once/turn/session meanings and deny versus cancel. Neither actual native run encountered an approval prompt. |
| Context visible before a grant | Extension's own web-compatible dialog content | Complete reversible JSON, at most **32 KiB UTF-8** for the whole context | Read-only input, caution and proposed-change description | C `approval-context.ts` / A `ClaudeApprovals` → request body/context → details panel. **Codex** new red/green and visible-details tests; **browser** Claude context/answer tests. Scope limits are below, not full native approval parity. |
| Questions | Bridge select/input/editor | Positive native user-input workflow deferred/off | Validated `AskUserQuestion` input/answer mapping | P bridge and A approvals → question/option IDs → interaction forms. **extensions**, **Claude**, **browser** verify required answers, original native labels, focus/answer retention. No Codex question-form implementation is inferred from the shared DTO. |
| MCP elicitation / dynamic control protocols | Pi tools/extensions keep their own integration | Positive elicitation/dynamic-tool flows deferred; documented decline/error | MCP elicitation explicitly declined; undeclared dialogs not enabled | C `unsupportedControlResponse`; A `onElicitation` / ingress → no-grant/error and pending resolution. **Codex, Claude**. Fail-closed coverage is not positive feature support. |
| Duplicate, stale, timeout, disconnect decisions | Session-scoped bridge resolution/default denial | Native request/thread/turn/process correlation | Native request/tool/generation/cancellation correlation | Adapter validation plus service `respondInteraction` → resolved events/forms. **core, Codex, Claude, browser**. Foreign replies cannot grant; stale Codex callbacks must not abort a newer turn. |
| Unknown native information / required controls | Known Pi mapping and bounded wire-compatible fallback | Bounded/redacted observation; unsupported required requests fail closed | Metadata observation before SDK consumption; unsupported required controls fail closed | Native ingress → service diagnostics or explicit errors; accumulated known transcript stays intact. **pi-event-map.test.ts**, **Codex**, **Claude**. Merely forwarding an unknown envelope does not give it browser semantics. |
| Native model, effort and provider auth | Existing Pi model runtime/auth source | Inherit Codex; omit model/effort/policy/tool overrides | Native prompt preset/settings sources; narrow pinned-SDK permission mitigation | C start/resume response / A `system/init` → `nativeSettings` → read-only `modelSettings.ts`. **Codex, Claude, browser**; actual/config-only evidence below. Installation availability is not auth or inference proof. |
| Model/thinking/provider management UI | **Pi-only** registry/default controls | Deferred/off; read-only observation | Deferred/off; read-only observation | P `models/setModel/context`; native service gates → model settings/session details. **core**, `settings.test.ts`, `context.test.ts`, **browser**. Global Pi settings are not native configuration or a new native login flow. |
| Skills, prompts, instruction files, hooks | Pi resource loader and injected web context | **Native-only** discovery/configuration inherited | **Native-only** discovery/configuration inherited | P resource loader → commands/context inspector; C native startup; A `settingSources` + `claude_code` preset. **Pi/extensions**, **Claude** actual-CLI config canary verifies a filesystem hook and discovered skill. Not all native hook/plugin behaviors are canary-tested. |
| Slash commands and shell escapes in browser | **Pi-only** web/extension/prompt/skill commands; `!` / `!!` shell | Deferred/off | Deferred/off as a browser command surface | Composer command lookup → `/api/command` / `/api/shell` → Pi explicit methods; native service rejects. **core**, `composer-shell.spec.ts`, **browser**. Native CLI command availability does not imply a web consumer; see the boundary below. |
| Native tools / MCP / plugins | Existing Pi tools and extension registration | Native configured tool set; no management UI | Native configured tool set; no management UI | Native execution → C items / A tool-use/results → generic cards. **Codex/Claude/browser** validate mapped outputs, not a universal tool registry. Actual checks exercised only an owned-file read; advanced native administration remains native-only/deferred. |
| Permissions and sandbox enforcement | Pi configuration/extensions unchanged | Native enforcement retained | Native enforcement retained, including inherited default mode | C sends native decisions, not an alternate executor; A removes only the exact SDK-generated default-mode override. **Claude** zero-model config test verifies native Read denial; broader real sandbox denial is **not tested** (`bwrap`/`socat` absent on that audit machine). Host-token leakage remains a separate unresolved boundary. |
| Usage, cost and context occupancy | Existing SDK/catalog accounting and context inspector | Reported tokens; no monetary cost or invented occupancy | Current-Query cumulative reported usage/cost, reset on new Query | Native usage → `SessionStatsDto` → session details/context meter. **Pi, Codex, Claude, native-ui-state.test.ts, browser**. Missing cost is unknown, not $0; query totals are not a lifetime bill and token totals are not measured context occupancy. |

**Codex consent limits:** exact command/cwd, native `environmentId`, reason, network host/protocol, permission paths and proposed/deferred rule context are reviewed together. `environmentId` is an identity, not a dump of environment variables. The request remains authoritative even when native tool history is shorter. Explicit network-only requests label their host/protocol scope instead of inventing command/cwd. File requests require their exact live change item, including rename destinations/diffs/root context. Exec/network policy amendments and broad file-session roots are not granted by the offered choices. Credential-like values, concealed/control/bidi text, malformed or ambiguous context, excessive nesting/collections, oversized context, and URLs containing userinfo/query/fragment conservatively defer grants. Plain safe destination URLs remain complete. These restrictions also protect correlated tool details; they are not a permission-policy engine.

**Native command boundary:** the Claude adapter can pass permitted command text through its ordinary prompt API, and rejects conversation-switch commands such as `/clear`, `/resume`, `/fork`, `/new`. The existing browser, however, routes slash text through `/api/command`, which is Pi-only; it has no native slash catalog. The direct SDK `/compact` configuration canary therefore does **not** establish a browser compaction workflow.

**Claude headless boundary:** its native CLI skips interactive workspace-trust dialogs and ignores invalid settings files in headless mode. Use an explicitly selected/trusted cwd; do not claim interactive-terminal trust parity. The adapter's `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` enables lifecycle observation, not different permissions. The version-specific removal of the unsolicited SDK `--permission-mode default` pair preserves native mode resolution and fails closed on unexpected argv.

### Rich Pi operations, extensions and host UI

| Feature | Pi | Codex | Claude | Production mapping → contract/consumer; test provenance and reason |
| --- | --- | --- | --- | --- |
| Steering, follow-up queues | **Pi-only**, existing SDK behavior | Deferred/off | Deferred/off | P `prompt` streaming behavior / queue events → composer queue and realtime. **Pi**, `send-stop.spec.ts`. C/A reject active ordinary input and unsupported modes rather than accidentally creating native queues. |
| Retry and compaction controls | **Pi-only**, existing retry compatibility/manual compaction/cancellation | Host controls deferred/off; native automatic behavior retained | Host controls deferred/off; native automatic behavior retained | P retry/command/work lease → runtime/retry cards; C native `willRetry`, A `api_retry/status` → activity. **Pi**, `retry-errors.spec.ts`, **Codex/Claude**. No native host-side replay is used as Retry. |
| History tree, edit/rerun, continue from earlier node | **Pi-only**, same-session navigation | Deferred/off | Deferred/off | P `navigateTree` → tree DTO/leaf → `conversationTree.ts`, `src/main.ts` message actions. `session-service.test.ts`, `conversation-tree.spec.ts`, `message-actions.spec.ts`. Not a new-session fork. |
| New-session history fork | Deferred/off | Deferred/off | Deferred/off | All adapters advertise `historyFork:false`; web extension `fork` rejects. No fork route/consumer is claimed. Enabling requires exact boundary, new identity, copied history, source unchanged and lineage tests—not just a parent link. |
| File checkpoint/rewind | No new web workflow | Deferred/off | Deferred/off | No shared operation/consumer. Native fork/truncation/checkpoint capabilities are different and are not implied by tree navigation. No filesystem rewind promise. |
| Native plan/review/task administration | Existing Pi summaries only | Contextual plan/diff/review notices; dedicated controls deferred | Forwarded notices/activity; dedicated management deferred | C `projectItem` / plan/diff notifications and A transcript notices → ordinary message/card consumers. **Codex** tests contextual plans/diffs; this is not a review editor, per-task stop UI or native administration API. |
| Pi-native tools, commands, hooks and context changes | **Pi-only**, SDK/resource binding preserved | Not ported | Not ported | P `make` / extension bridge → SDK behavior, Pi context/command UI. **Pi, extensions**. Shared MCP support is not automatic Pi-extension compatibility. |
| Pi web-compatible dialogs/effects | **Pi-only** bridge UI methods | Native decisions use their own adapters | Native decisions use their own adapters | `webUi.ts` select/confirm/input/editor/status/editor effects → existing interaction plumbing. **extensions**, **Pi**. Native approval enforcement is not Pi interception. |
| Terminal-only custom components/renderers | **N/A to browser terminal surface**; existing unsupported bridge methods remain | No terminal renderer port | No terminal renderer port | `custom()`/terminal input/theme/editor replacement have no equivalent browser component consumer. This is an explicit existing web limitation, not a claim that all Pi TUI renderers work. |
| Browser footer/FAB/header/panel/Git-tab/artifact/new-session contributions | **Pi-only** registration and invocation | Deferred/off | Deferred/off | `webUi.ts` → contribution descriptors → `src/extensions/*`, drawer birth fields, Git/artifact hosts. **extensions**, birth-field / `web-panel.spec.ts` / `git.spec.ts`, **browser** native gating. No separate native extension engine. |
| Custom messages and rich built-in rendering | Pi custom text/details/display flags retained | Shared ordered parts, not custom renderer registration | Shared ordered parts, not custom renderer registration | P `projectMessages` / C projection / A transcript → message list/cards/Markdown. `custom-message-reports.test.ts`, `custom-messages.spec.ts`, `messages-content.test.ts`, **browser**. Native tool/assistant error distinctions stay separate. |
| Worker spawning, notepad, delegation spool | **Pi-only** tools/examples and scoped extension HTTP | Deferred/off | Deferred/off | Pi extension registration → `sessions_*`, spool/notepad and visible web sessions. **workers**, **extensions**. Native subagents do not become pi-web workers just because an ID was observed. |
| Parent provenance, worker obligations and native subagents | Explicit web lineage/dependency declarations preserved | Native observed activity only; no host obligation/stop UI | Forwarded native activity/text only; no host obligation/stop UI | Pi `reportSettlementDependencies` → host settlement tracker / `activeWorkerDock` / reference chips; native observations stay native. **workers**, `session-refs.test.ts`. Provenance alone is neither a dependency nor a history fork. |
| Files, Git, built-in artifacts | Supported host feature | Supported host feature | Same host path; native-specific breadth not independently proven | Host cwd routes, not SDK tool shortcuts → Explorer/Git/`artifactPreview.ts`. **host** and **browser** verify Codex host integration with real scratch files. Shared artifact HTML uses sandboxed opaque-origin previews. Pi extension-specific previews/actions are still off for native sessions. |
| Attachments, quote-reply and structured references as input | **Pi-only**, existing upload/markup/context paths | Deferred/off | Deferred/off | `AttachmentDto`, upload/capability checks → composer / quote controls. `attachments.test.ts`, `quote-replies.spec.ts`, `session-switch-runtime.spec.ts`, **core/browser** native rejection. Receiving an output image does not mean uploads are supported. |
| Session lanes, labels, notes and human auth | Host UI preserved | Same host UI; native identity badge | Same host UI; native identity badge | Session/UI stores and auth kernel → drawer/inspector/Security. `session-ui-state.test.ts`, `session-lineage.test.ts`, `multi-auth.spec.ts`, **browser**. Host human login is distinct from native model credentials. |
| Completion unread/notifications | **Pi-only** successful-completion behavior retained | Deferred; idle can follow interruption | Deferred; idle can follow interruption | P completion → host unread/push and browser alerts. `session-service.test.ts`, `completion-alerts.test.ts`, `push-notifications.test.ts`, `notifications.spec.ts`. No native successful-completion notification is inferred from idle. |
| Runner/ACP/Docker/SSH transport parity | **N/A to this exposed local binding** | **N/A to this exposed local binding** | **N/A to this exposed local binding** | No runner/remote/container selection is shipped here. A future binding requires same-harness transport evidence; Pi-shaped runner fixtures do not prove native semantic parity. |

## Evidence index

These files are in the reviewed tree. Passing examples are evidence of their asserted behavior, not all cases in a feature family.

| Group | Reproducible source and boundary |
| --- | --- |
| **core** | [`session-adapter-service.test.ts`](../tests/session-adapter-service.test.ts), [`native-bindings.test.ts`](../tests/native-bindings.test.ts): real service/metadata with a native-shaped admission fixture. **Not** native protocol conformance. Includes queued rename/preview/tombstone races, write failure/rollback, exact identity, explicit retry and ephemeral expiry. |
| **Pi** | [`session-service.test.ts`](../tests/session-service.test.ts), [`session-projection.test.ts`](../tests/session-projection.test.ts), [`pi-event-map.test.ts`](../tests/pi-event-map.test.ts), [`context.test.ts`](../tests/context.test.ts). [`pi-adapter-sdk.test.ts`](../tests/pi-adapter-sdk.test.ts) uses actual SDK 0.84.1 for no-inference startup/local command/shutdown and public UUID compatibility. |
| **Codex** | [`codex-transport.test.ts`](../tests/codex-transport.test.ts), [`codex-approvals.test.ts`](../tests/codex-approvals.test.ts), [`codex-adapter.test.ts`](../tests/codex-adapter.test.ts), [`codex-service.test.ts`](../tests/codex-service.test.ts). Controlled OS JSONL peer enters production transport/adapter/service/host; approval request ID `0`, correlations, context bounds and no-grant paths are covered. |
| **Claude** | [`claude-native.test.ts`](../tests/claude-native.test.ts), [`claude-native-cli.test.ts`](../tests/claude-native-cli.test.ts), [`claude-adapter.test.ts`](../tests/claude-adapter.test.ts), [`claude-session-service.test.ts`](../tests/claude-session-service.test.ts), [`claude-lifecycle.test.ts`](../tests/claude-lifecycle.test.ts). Real pinned SDK with controllable native process/reader seams. Reader fixtures are not actual persisted-history proof. |
| **browser** | [`native-harness.spec.ts`](../tests/e2e/native-harness.spec.ts): real `server.ts`, HTTP/WS/UI, `PI_WEB_MOCK=0`, production native adapters and controlled Codex/Claude executables. No HTTP response fulfillment or replacement service. Claude's SDK readers are not substituted; absent real persisted history rejects. [`session-codex-http.test.ts`](../tests/session-codex-http.test.ts) adds a real-server HTTP/WS vertical, still with a synthetic native process. |
| **extensions** | [`extensions.test.ts`](../tests/extensions.test.ts), [`extension-settings.test.ts`](../tests/extension-settings.test.ts), [`web-ui-settings.test.ts`](../tests/web-ui-settings.test.ts), [`unit/extension-http.test.ts`](../tests/unit/extension-http.test.ts), and [web extension API](pi-web-extensions.md). Selected Pi registration/invocation/lifecycle behavior; no native port is inferred. |
| **workers** | [`session-orchestrator.test.ts`](../tests/session-orchestrator.test.ts), [`notepad-extension.test.ts`](../tests/notepad-extension.test.ts), [`session-settlement.test.ts`](../tests/session-settlement.test.ts), [`settlement-dependencies.test.ts`](../tests/settlement-dependencies.test.ts), [`session-worker-branches.test.ts`](../tests/session-worker-branches.test.ts). Pi extension tools and host metadata/dependency consumers. |
| **host** | [`workspace-files.test.ts`](../tests/workspace-files.test.ts), [`git-diff.test.ts`](../tests/git-diff.test.ts), [`files.spec.ts`](../tests/e2e/files.spec.ts), [`git.spec.ts`](../tests/e2e/git.spec.ts), [`session-ui-state.test.ts`](../tests/session-ui-state.test.ts). Files/Git/UI stores are real host features, not native sandbox enforcement tests. |

## Recorded results and provenance

### Regression, protocol and replay evidence

Counts are **per checkpoint**, not additive and not substituted for newer commits.

| Executed source / owner | Recorded result | What it does not prove |
| --- | --- | --- |
| Core `d21fb77`, producer | Typecheck/build; 670 units; 24 Pi desktop regressions passed. Three metadata/open-cache defects reproduced red before repair. | All-three-harness final assembled suite or actual models. |
| UI `305da58`, producer | Full `npm test`: 700 units / 1 opt-in skip; 870 browser cases / 55 skips; zero failures/retries. Includes 45 native-peer cases (27 Codex, 18 Claude). | Actual native persistence/generation/approval; later adapter fixes or newly discovered Pi stopped-text case. |
| `9de905f`, independent | Fresh ci/typecheck/build; full `npm test` exit 0, 700 units / 1 skip; 851 browser passes **plus one retry-pass flake**, 55 skips. Four independent counterexamples were red. | Clean acceptance; three focused passes did not erase or explain the original flake. |
| `9d5a757`, independent | Fresh ci/typecheck/build; full `npm test`: 713 units / 1 skip; 870 browser passes / 55 skips, **zero failures/retries**. Unchanged Claude lifecycle and Codex consent probes still failed twice. | Correctness approval. A green regression suite missed those counterexamples. |
| Claude corrections in `0fbe2c1` | Producer typed focused suite: 44 pass including opt-in CLI/no-real-model checks; independent unchanged lifecycle probe: **4/4 green twice** on this pin. | A fresh paid full workflow or full assembled acceptance after these fixes. |
| Codex `4466927` → integration `617ab3f`, producer | Original two consent counterexamples red → green twice; typecheck/strict check/build; 752 units / 1 skip; 24 Codex desktop/mobile peer-browser cases, zero retries. Prior actual-canary files unchanged. | Independent acceptance of the correction, a full current assembled suite, or actual prompted-approval handling. |
| Baseline/platform repair, independent | FAB `db5cd6e` → `d3d49fd`; Linux policy `5020476` → `b1ca01b`. 78 genuine Linux references, all 80 original Mac references unchanged. | Canonical macOS execution; unchanged images are not a Mac test pass. |

Independent reports are retained as `issue92-assembled-verify-9de905f/review.md` and `issue92-assembled-verify-9d5a757/review.md` review artifacts, with command logs/probes. The later task evidence records the exact `0fbe2c1` rerun, not the probe's older hard-coded `candidate` label. Review artifacts are supplementary receipts; no workstation-specific path or chat history is required to run the checked-in suites.

### Actual execution is separate

| Harness / evidence | Actual observations | Limits retained |
| --- | --- | --- |
| **Pi SDK 0.84.1**, producer on UI `305da58` | Configured **Pi** provider `codex-bedrock/openai.gpt-5.6-terra`, high thinking—not the native Codex adapter. Preface → one real owned-file `read` → visible partial reply; matching-guard Stop returned 202; SDK `aborted` and `agent_settled`, Stop hidden. Four API messages, including raw SDK content, and saved history retained the prose across page reload. | **UI stopped-prose preservation failed. Cold service restart/reopen NOT RUN.** Budget 3/3 provider requests: one retained profile-loss 401, then exactly two 200 responses after explicit/asserted `AWS_PROFILE`. The private budget copy disabled retries/compaction and pre-named the session; all 13 protected originals stayed unchanged. Later replay cannot relabel the original incomplete canary as passed. |
| **Native Codex 0.154.0**, PATH wrapper 0.154.0.469; producer evidence independently reviewed at `9d5a757` | Normal web sign-in, real marker generation, real read-only command returning a marker absent from the prompt, unchanged owned file; guarded Stop 202, then public native `thread/read` confirmed that exact turn interrupted. Same web/native identity and history after restart; fourth turn recalled earlier file contents. Native settings observed: `openai.gpt-5.6-sol`, medium, on-request/auto_review, readOnly. | Four submitted native turns total, not an asserted exact billable API count. Original drawer/HTTP-status canary assumptions failed; later scoped continuation used only the fourth turn. Initial live-idle assertion did not finish; later history/reopened state is separate evidence. No approval prompt. The memory assertion is not a native zero-tool inventory. No complete executed-tree digest certifies every later integration change. |
| **Claude SDK 0.3.270 / CLI 2.1.270**, producer across corrected phases | Native owned-file Read and exact unprompted marker; guarded Query interrupt receipt and native quiescence; supported history discovery and further app restart retained native identity/history IDs; final explicit prompt recalled the marker with running → result → idle. | Three browser prompts, four observed assistant API IDs, native caps 2/1/1. First phase exposed missing idle-event opt-in; second exposed abort/error misclassification. Final resume phase passed after corrections; **no fresh full paid rerun**. No actual approval prompt or broader sandbox-enforcement canary. |

Retained producer receipts: `issue92-pi-canary/continuation/{report.md,validation.json}`; `codex-actual-phase3/{report.md,report.json,budget.json,cleanup-audit.json}`; `claude-actual-canary/` initial/continuation/resume reports. Copies of user-facing reports are in review artifacts under `issue92/{ui,codex,claude}/`; these names describe evidence bundles, not required native stores.

The Claude **actual-CLI, zero-real-model** configuration suite is another class: fresh `/compact` against an unreachable synthetic API verifies inherited `dontAsk`, explicit `plan`, native filesystem SessionStart hook, skill discovery, native Read deny rule and result-before-idle. Its local synthetic Anthropic SSE case verifies the real CLI's abort envelope. It does not validate native user authentication, a real provider, browser interaction or real-model reasoning.

## Setup and reproducible validation

### Obtain the review code and verify pins

Use a clone/review bundle that contains the integration commit. Do not assume `npm ...@latest` or upstream `main` has this implementation, and do not assemble #119/#120 merely to obtain a native adapter.

```sh
# Run in that clone; choose an unused worktree path.
review_commit=617ab3fb24d7ffb5772742d75b98dc49c8402089
git worktree add --detach ../pi-web-92-check "$review_commit"
cd ../pi-web-92-check
node --version
npm ci
npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @anthropic-ai/claude-agent-sdk
```

Node **>=24** is required; the independent Linux run used Node 24.15.0/npm 11.12.1. Keep optional dependencies: `npm ci --omit=optional` can omit Claude's platform executable. Install Chromium's OS dependencies if required by the platform; do not regenerate/fallback to another platform's screenshots.

| Integration pin | Source / verification |
| --- | --- |
| Pi coding-agent and pi-ai **0.84.1** | Exact `package.json`/lockfile; `pi-adapter-sdk.test.ts`. No separate global Pi install is required for the app. |
| Codex native/protocol **0.154.0** | `codex --version`, `codex app-server --help`; handshake version check. [Generated schema/pin](../tests/fixtures/codex-0.154.0/pin.json), SHA-256 `24df528acec2952e6b96c1c2b061f98e60177d059e12c90cf318621380c9de9e`. |
| Audited Codex wrapper **0.154.0.469** | Machine-specific observed PATH wrapper, not a universal package dependency. Preserve its ordinary managed authentication; a managed “login not required” response is not failed auth. |
| Claude Agent SDK **0.3.270**, bundled CLI **2.1.270** | Exact dependency/platform package and runtime version checks. The machine's system CLI **2.1.226** was not replaced. `claude --version` alone does not identify the SDK's bundled integration CLI. |

Primary native sources and schema-generation commands are in the leaf docs. A version/help/catalog check does not submit inference and is not generation acceptance.

### Ordinary isolated application launch

Use an **owned shell/tmux session** and an unused loopback port; never restart another checkout or reuse its auth/UI stores. Run the following from the reviewed checkout inside that shell. Keep the native HOME/config/auth intact; only Pi/pi-web scratch state is redirected.

```sh
umask 077
run="$(mktemp -d)"
mkdir -p "$run/pi-agent" "$run/workspace"
# Clear inherited *web* authentication inputs in this scratch shell only.
# Native provider/auth variables and HOME/CODEX_HOME/CLAUDE_CONFIG_DIR are not replaced.
unset PI_WEB_TOKEN PI_WEB_AUTH_MODE PI_WEB_AUTH_POLICY PI_WEB_AUTH_METHODS
unset PI_WEB_AUTH_TRUSTED_HEADER PI_WEB_AUTH_PROXY_PEERS PI_WEB_AUTH_RP_ID
unset PI_WEB_NO_SESSION PI_CODING_AGENT_SESSION_DIR
unset PI_WEB_CODEX_PEER_DIR PI_WEB_CLAUDE_PEER_DIR
unset PI_WEB_CODEX_COMMAND PI_WEB_CODEX_ARGS PI_WEB_CLAUDE_EXECUTABLE
export HOST=127.0.0.1 PORT=49512 # choose/check an unused port
export PI_WEB_AUTH_ORIGIN="http://localhost:$PORT"
export PI_WEB_DEV=0 PI_WEB_MOCK=0 PI_WEB_MULTI_HARNESS=1
export PI_CODING_AGENT_DIR="$run/pi-agent" PI_WEB_CWD="$run/workspace"
export PI_WEB_AUTH_STORE="$run/web-auth.json"
export PI_WEB_SETTINGS_FILE="$run/settings.json"
export PI_WEB_SESSION_UI_STATE_FILE="$run/ui-state.json"
export PI_WEB_NATIVE_BINDINGS_FILE="$run/native-bindings.json"
export PI_WEB_PUSH_FILE="$run/push.json"
export PI_WEB_NOTEPAD_DIR="$run/notepad" PI_WEB_NOTEPAD_DB="$run/notepad-db.json"
export PI_WEB_NOTEPAD_VAULT="$run/notepad-vault" PI_WEB_DELEGATION_SPOOL="$run/spool"
npm run build
npm start
```

Use the terminal's single-use setup link and normal browser password/passkey sign-in; [authentication instructions](passkey-auth.md) cover recovery. Do not use the fixtures' open/no-auth policy for a real-harness acceptance check. Treat bootstrap URLs/server logs as private, not publishable canary evidence. At this pin, clearing a live token for scratch isolation does **not** repair or waive the documented native-child token-inheritance defect.

Open the configured origin, choose a harness on the landing screen or **Sessions → New session**, and verify its identity/effective settings. Pi remains selected by default. Codex uses `codex` on PATH; Claude uses its matching bundled executable. Before startup, an operator may instead set `PI_WEB_CODEX_COMMAND` and JSON-string-array `PI_WEB_CODEX_ARGS`, or an absolute matching `PI_WEB_CLAUDE_EXECUTABLE`; browser requests cannot set them. Incorrect/unavailable installs fail rather than execute Pi.

Preserve native authentication/configuration, including required provider selectors. Audit any extra installed Pi extensions before this launch: redirecting known stores is not an OS sandbox or a guarantee about arbitrary extension side effects. **tmux may retain a different environment from the initiating shell:** explicitly set and assert the expected non-secret profile selector inside the runner/server, not just outside it. Never print keys or tokens. For an actual Pi check, provision only required Pi configuration/auth privately in the scratch agent directory (0600), verify original hashes, and pre-name the session to avoid unbudgeted title inference. A scratch empty Pi directory does not inherit the user's model config automatically.

To test restart, stop only this owned app and restart with the **same** scratch paths. Reopen the same saved web/native identity without resending previous input. Keep the private directory until that check finishes; then clean only owned processes/ports/private scratch data, not native homes or history. `npm start` is the existing single-process entry, not a new serving path; the regular supervised option and public/child ports are documented in [README](../README.md).

### Deterministic full gate — no real models

Use a disposable HOME and allowlisted environment for **test peers**, unlike actual native-auth checks. Keep the validation checkout outside directories named `artifact`: an existing mock scenario matches that word in attachment paths. Execute these commands in an owned tmux shell; change the offset if any computed port is in use. The full runner uses `9876 + offset`, `10176 + offset`, `10476 + offset`, `10776 + offset`, plus `10 * shardIndex` for viewport shards.

```sh
check="$(mktemp -d)"
mkdir -p "$check/home" "$check/pi-agent"
check_run() {
  env -i PATH="$PATH" HOME="$check/home" USER=piweb-test LOGNAME=piweb-test \
    PI_CODING_AGENT_DIR="$check/pi-agent" \
    PI_WEB_AUTH_STORE="$check/auth.json" PI_WEB_SETTINGS_FILE="$check/settings.json" \
    PI_WEB_SESSION_UI_STATE_FILE="$check/ui.json" PI_WEB_NATIVE_BINDINGS_FILE="$check/native.json" \
    PI_WEB_PUSH_FILE="$check/push.json" \
    PLAYWRIGHT_BROWSERS_PATH="$check/browsers" \
    PI_WEB_CLAUDE_CONFIG_CANARY=0 PI_WEB_E2E_PORT_OFFSET=20000 "$@"
}
# Install into the same explicit cache used by every isolated browser process.
check_run npx playwright install chromium
check_run npm run typecheck
check_run npm run build # includes extension declarations
check_run npm test     # full parallel/sharded runner, not test:serial
```

The full runner includes typecheck, unit tests, Vite build and all browser projects. `npm run build` above additionally builds extension declarations. `PI_WEB_E2E_SHARDS=<n>` changes viewport sharding; `PI_WEB_E2E_CONCURRENCY=<n>` changes scheduling. The browser config retries by default: retain/report any initial failure and retry count even when `npm test` exits zero. Linux references are explicit; no snapshot update is a validation pass.

Focused regressions, using the same `check_run` function and private environment:

```sh
check_run npm run test:unit -- tests/native-bindings.test.ts tests/session-adapter-service.test.ts \
  tests/session-service.test.ts tests/pi-adapter-sdk.test.ts tests/session-projection.test.ts \
  tests/pi-event-map.test.ts tests/context.test.ts tests/extensions.test.ts
check_run npm run test:unit -- tests/codex-transport.test.ts tests/codex-approvals.test.ts \
  tests/codex-adapter.test.ts tests/codex-service.test.ts tests/session-codex-http.test.ts
check_run npm run test:claude
check_run env PLAYWRIGHT_PORT=39876 npx playwright test tests/e2e/native-harness.spec.ts \
  --project=mobile --project=tablet --project=desktop --retries=0
```

`test:claude` typechecks native sources/tests before running them. If checking Codex independently of a dynamic module loader, use the strict native-leaf command in [codex-native.md](codex-native.md#reproducible-validation). The production browser fixture owns its ephemeral real server and OS peers; the chosen `PLAYWRIGHT_PORT` also isolates Playwright's ordinary mock-server/output setup. Tests for mock/Pi behavior are not evidence that Codex or Claude executed a model.

### Additional actual-CLI checks — still zero real model calls

```sh
check_run env PI_WEB_CLAUDE_CONFIG_CANARY=1 DISABLE_TELEMETRY=1 \
  npx vitest run tests/claude-native-config.test.ts
```

This suite deliberately redirects HOME/config and uses synthetic credentials plus an unreachable API/local SSE server. That isolation is correct for a configuration/protocol check, **not** for an actual native-auth canary. Retain its result separately from paid generation and browser evidence.

### Actual-harness acceptance — explicit budget only

No additional paid calls are authorized by these instructions or by a green fixture suite. All recorded phase budgets above are exhausted. For a separately approved fresh phase, inspect the checked-in runner, preserve existing ledgers/evidence and use an owned tmux shell with asserted native profile/configuration:

```sh
# Actual runners inherit native HOME; provision their browser cache separately.
npx playwright install chromium
# Explicit opt-ins, excluded from npm test; execute only with a new authorized budget.
PI_WEB_CODEX_ACTUAL_CANARY=1 node --import tsx tests/codex-actual-canary.ts
PI_WEB_CLAUDE_ACTUAL_CANARY=1 npm run canary:claude
```

Codex's runner refuses reuse unless its retained ledger is at the exact permitted phase; `--resume` is specifically the earlier three-turn-to-four-turn continuation, not an automatic retry. Claude's documented continuation manifest spends only the remaining phase and uses supported native discovery, not a seeded binding/private reader. Never delete/reset a consumed ledger to make a rerun possible. Both runners create fresh web credentials; their isolation does not waive the outstanding child-environment finding.

There is no checked-in bounded actual-Pi runner at this source pin. The recorded Pi run used a retained producer harness. A future approved manual/automated repeat must use the normal browser and production SDK: pre-name/configure the scratch Pi session, keep a persistent provider-request budget including failures/helper calls, read an unpredictable marker only from an owned file, stop after visible streamed text with the observed guard, and verify retained parts on reload **and a separately reached cold reopen**. Stop/report at the budget or deadline; do not infer missing coverage from raw-history retention.

For every actual attempt record the executed revision/pins, native settings/auth setup without secrets, prompt/provider-request accounting, native/web/execution identity checks, visible result, approvals encountered or **not encountered**, timeout/failure, cold-reopen boundary and cleanup. A replay of a captured real message is deterministic replay evidence; it cannot retroactively convert that original run's failed/unrun steps into passes.

## Completion gate

Before acceptance, resolve/review the open defects, integrate their regressions and rerun the full applicable suite on the exact final code. Record skips/retries and native actual/config-only/peer/replay evidence separately, including untouched originals and platform limits. Require independent correctness **and** simplicity review. This document introduces no new framework, native policy bypass, live restart, main promotion or deployment permission.
