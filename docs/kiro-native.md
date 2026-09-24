# Kiro native integration

**Supported (deterministic peers): Kiro is the fourth opt-in local harness behind the existing `LocalSessionService` and `SessionHandle`. Unverified: real canary pending.** Implementation validation made no real Kiro calls. Separately authorized zero-model probes captured real new/load responses, startup notifications and catalog source shapes; those captures inform this slice's synthetic peer. Prompt, permission and nonempty replay frames remain spec-based until the real canary.

## Pins and native ownership

| Component | Exact target |
| --- | --- |
| CLI | `kiro-cli 2.24.0`, checked before each owned ACP launch and public catalog operation |
| Invocation | `kiro-cli acp --agent-engine v2` |
| Protocol | ACP version **1**, stdio JSON-RPC 2.0, newline-delimited UTF-8 |
| Leaf-only types | `@agentclientprotocol/sdk@1.5.0`, root v1 exports; no experimental v2 imports |
| Schema SHA-256 | `2a920d3c0f76443e07ffa7801443e3cdf008e2a3095e565581a0433fd728ce41` |
| SDK integrity | `sha512-524jwbB2iYWA+kWWyv9fhKbhU89dH/lu9u5EXwVNmfYzopV8BujCDxByBDZhxRUkB7RWIJzISCnwivdDk+bdVg==` |
| Zod peer | SDK accepts `^3.25.0 || ^4.0.0`; this application pins **4.4.3**, already resolved by the baseline |

The adapter uses a small owned JSONL transport and the pinned SDK's request, notification, content and permission types. It does not add an ACP router, alternate SessionService, tool executor, private transcript parser or browser ACP contract. Native SDK types remain inside `server/session/adapters/kiro/`.

Set `PI_WEB_MULTI_HARNESS=1` to enable native selection. Pi remains the default. Factory construction checks executable availability without launching Kiro; availability is not authentication or inference entitlement. Trusted server configuration may set `PI_WEB_KIRO_COMMAND` and `PI_WEB_KIRO_ARGS` (a JSON string array replacing the ACP arguments). The command must also accept the ordinary `--version` and `chat --agent-engine v2 --list-sessions --format json` argv; ACP argument overrides are not appended to metadata commands. Browser input cannot configure either variable. Overrides are trusted transport/test configuration, not a supported v3 engine selector; preserve the explicit v2 invocation. A missing executable, incorrect version or failed initialization never falls back to Pi.

`nativeChildEnvironment` applies separately to **all three** launches: version, public catalog and ACP. It copies the supplied environment and removes only the exact case-insensitive `PI_WEB_TOKEN` key. Native HOME, authentication, agents, hooks, tools, trust settings, MCP configuration and other environment inputs remain native. There is no trust-all flag, Pi system prompt, model default or permission-policy override. `mcpServers: []` means no client-supplied MCP additions. The separate real zero-model probe observed native MCP servers starting with this input; exhaustive native configuration inheritance still needs a canary. This is credential separation, not an operating-system sandbox.

## Real zero-model shape checkpoint

Separately authorized probes on 2026-09-24 captured 30 real frames. New returns `{sessionId,modes,models}`; load returns `{modes,models}` without a session ID. Neither response contains `configOptions`. The synthetic peer uses these field shapes with clearly synthetic mode/model values, not copied account catalogs.

Startup emits `_kiro.dev/mcp/server_initialized`, `_kiro.dev/commands/available`, `_kiro.dev/subagent/list_update` (without `sessionId`) and `_kiro.dev/metadata`, both before and after the response. These remain bounded observations, not browser commands, instructions or usage accounting. The largest captured commands notification was 78,786 bytes. The production default frame cap is **8 MiB**, with the same bound for unterminated input and buffered load replay; lower caps exist only as explicit transport-test options.

Ordinary errors preserve their correlated RPC code and omit arbitrary `data`. The real malformed-input response has code `-32700` with **no id**, rather than JSON-RPC's usual null ID. This exact exception is observed without closing an idle connection. If requests are pending, correlation is ambiguous: fail closed, retain partial content and never guess a recipient or replay input. The rejected line in `error.data` is never forwarded. Malformed public catalog JSON also produces a constant setup diagnostic, without reflecting native stdout.

The probe also saw native session/log writes and live MCP children. EOF closed both ACP parents cleanly, but descendants needed owned-group cleanup. No claim of native HOME immutability is made. The retained external probe report and frames are evidence, not a runtime dependency; the checked-in synthetic peer is portable.

## One exercised handle path

```mermaid
flowchart LR
  Browser --> API[Existing HTTP API]
  API --> Service[LocalSessionService]
  Service --> Handle[Kiro handle]
  Handle --> ACP[Owned ACP child]
  ACP --> Projection[DTO projection]
  Projection --> Relay[Existing host relay]
  Relay --> Browser
```

| Handle operation | Native mapping and honest limits |
| --- | --- |
| Create | Version preflight, initialize with protocol 1 and empty client capabilities, then `session/new {cwd,mcpServers:[]}`. Web UUID and native ID differ. The pinned real probe showed immediate persistence before any prompt, public source `v2` and successful fresh-child empty load; the handle reports resumable. |
| Open | Fresh child and `session/load {sessionId,cwd,mcpServers:[]}`. Buffer updates until load completes, validate identity, project replay before returning. Never send the previous prompt again. |
| List | Public CLI cwd envelopes, not unadvertised `session/list`. Filter strictly to `source === "v2"`: the real engine-v2 catalog also returned incompatible `classic` rows. Cold web bindings remain listed by the existing service. Historical and nonempty v2 replay remain real-canary gates. |
| Prompt | Idle, nonempty text only. `session/prompt {sessionId,prompt:[{type:"text",text}]}` returns a dispatch receipt with `acknowledgement:"not-exposed"`. The outstanding RPC response is the end of the turn, not immediate admission. No native execution ID is invented. |
| Stop | Required matching host guard, then `session/cancel` **notification**. Receipt acknowledges host dispatch, not native acknowledgement. Keep the guard and busy state until the prompt response arrives. |
| Decisions | Exact pending `session/request_permission` → server-owned opaque web choices → exact offered native `optionId`, or `{outcome:{outcome:"cancelled"}}`. |
| State, messages, subscribe | Cached DTO projection and pending interactions through the existing service/host relay. Last-viewer disconnect intentionally cancels pending decisions; reload hydration is tested with another viewer still connected. |
| Dispose | Cancel owned work and pending callbacks, close stdin, drain/discard stderr, await exit, bounded TERM/KILL of the owned process group including wrapper descendants. No session deletion. Windows process-tree parity is unverified. |

The public catalog has `updatedAt`, not `createdAt`. `AdapterSessionInfo.created`, `SessionInfoDto.created` and the web binding field are honestly optional. Existing sorting uses `modified`; unknown creation time stays absent across a cold binding reload. A host-created binding may record its known web creation time; native discovery never invents native creation time.

The source filter is evidence-driven, not inferred from the engine flag. A separate real probe created one unprompted session, found its ID under `source: "v2"`, closed the child and loaded that exact ID in a fresh child. That proves the bridge for this new empty session; it does not prove all historical sessions or nonempty content replay. The fixture now uses the same envelope fields, including `status` (not interpreted by the adapter), and persists empty sessions immediately.

Control requests retain at most 4,096 seen native IDs per child; crossing the limit closes that child safely. Permission requests expire after 120 seconds by default. Initialization/load requests default to 45 seconds and public metadata commands to 30 seconds; prompt responses deliberately have no short uniform timeout. Linux disposal allows one second before TERM and two before KILL while the leader is alive, then also cleans remaining owned descendants after leader exit.

## Content, settlement and decisions

| Native surface | Web projection |
| --- | --- |
| `agent_message_chunk` | Ordered text parts; keyed deltas rather than repeated accumulated prefixes or repeated input envelopes |
| `agent_thought_chunk` | Thinking parts only when native content is exposed |
| `user_message_chunk` | User history during load replay; live dispatched input is correlated by the host |
| `tool_call`, `tool_call_update` | Exact `toolCallId` correlation, sparse absent/null optional updates, supplied raw input only, running/completed/error status |
| Tool text and inline image content | Existing tool result parts; no local file reads or terminal execution to fill content |
| Diff `{path,oldText,newText}` | Existing `details.diff`, with full old/new text and path when safe to display |
| `plan` | One contextual system message replaced by each plan update |
| Commands and additive unknown variants | At most 32 metadata-only observations containing bounded method/variant names and byte counts; no arbitrary native envelope persistence |
| Required unknown request | Explicit JSON-RPC error and matching-execution cancellation, or connection cleanup when no session correlation exists; never silent approval |

Prompt responses retain **`end_turn`, `cancelled`, `max_tokens`, `max_turn_requests`, and `refusal`** in `MessageDto.stopReason`, including a content-free terminal response. Cancelled responses retain partial content and close unfinished tool presentation as cancelled. An unfinished tool at another terminal boundary is not invented as successful output. RPC failure on a usable child produces an error state; process loss produces unavailable state. Passive polling does not respawn; explicit reopen loads native history without prompt replay.

Native message IDs are used when supplied. Otherwise keys are deterministic replay-local ordering, not durable native turn IDs. Replay has no general per-message timestamp, so none is fabricated. ACP v1 does not put an execution ID on every notification or permission request: pending callbacks use the captured host execution, process ownership and exact tool/request IDs. Known old-tool requests and duplicate/resolved request IDs cannot affect a newer execution. This does not invent a native replay cursor or guarantee identification of every possible misordered future frame.

Only `allow_once` and `reject_once` options are exposed as accept/decline with scope `once`. `allow_always` and `reject_always` are omitted because their persistence scope has not been verified; they are never relabeled as session scope. Decline continues the turn. Stop or dialog cancellation resolves the native permission callback as cancelled and sends cancel for its owning execution. Timeout, disconnect and disposal follow the same no-grant rule. Stale answers cannot cancel newer work.

Consent context uses the existing complete, reversible JSON review principles from Codex, bounded at **32 KiB UTF-8** for the entire rendered context. Sparse requests may join only their exact live tool context. Missing input, unsupported tool kind, credential-like values, concealed text, excessive depth/collections or oversized context cannot grant. Unsafe tool input is withheld from the alternate transcript surface too. Kiro's arbitrary raw-input JSON additionally checks the full rendered object for credential-bearing keys, not just individual string values; this leaf-only check does not change Codex. Conflicting live request IDs invalidate the owned connection instead of leaving old grant buttons usable. The native permission engine still owns enforcement; this is not a second policy evaluator.

## Capability and acceptance boundary

All optional capabilities are false: queues, steering, follow-up, thinking-level control, tree, compaction, retry, shell, extensions, models, context, attachments and history fork. Interactions are true. Unsupported operations reject at the service and adapter boundaries. Effective `models.currentModelId` and `modes.currentModeId` returned by new/load are read-only display values, never Pi defaults or native mutation requests. Captured v2 responses have no `configOptions`; the adapter does not infer effort from the startup metadata's list of supported levels.

**Supported (deterministic peers)** means the production adapter, LocalSessionService, HTTP/WS and real browser exercised a synthetic executable. Real zero-model captures establish the new/load/settings/startup shapes, but do not establish prompt-turn or permission frames. The audit found public Kiro documentation using `session/notification`, `TurnEnd` and prompt `content`, whereas the pinned ACP v1 schema uses `session/update`, a prompt response with `stopReason`, and prompt `prompt`. Only the pinned dialect is implemented; a real canary must resolve this drift.

Still **Unverified: real canary pending**:

- Actual once-option payloads and remembered permission scopes.
- Nonempty or historical v2 history replay and compaction identity changes. One new empty session's source-to-load bridge is proven separately.
- Real prompt/cancel sequencing, authentication refresh and inference entitlement.
- Native agent, hook, tool and MCP inheritance with the exact startup inputs.
- Canonical macOS and Windows launch/cleanup behavior.
- Usage scope, cost/currency and context occupancy; no guessed accounting is shown.

Ephemeral creation rejects with 400 and expired ephemeral open with 410. Output images do not enable uploads. Native filesystem access is distinct from host Files/Git features. Pi extensions, worker tools and settings remain Pi-only.

## Reproducible zero-model validation

Run in an isolated owned checkout, not the live server. The synthetic executable requires `PI_WEB_KIRO_PEER_DIR`, checks metadata/ACP argv, records both wire directions, and accepts atomically numbered command files under `peers/<pid>/commands`. No prompt string selects a scenario. Its `synthetic-sessions` directory is explicitly fixture persistence, not a native private store. Controls include streaming updates, sparse tools, permissions, terminal responses, process exit, raw bytes, stderr flooding and owned descendants. See `tests/fixtures/kiro-peer-control.ts`.

Implementation commands executed without real model calls:

```sh
npm ci
# Internal registry credentials expired during dependency install. Refresh only npm auth:
harmony npm
npm install --save-exact @agentclientprotocol/sdk@1.5.0 zod@4.4.3
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck server/session/adapters/kiro/index.ts
npm run build
npx vitest run tests/kiro-transport.test.ts tests/kiro-adapter.test.ts \
  tests/kiro-service.test.ts tests/session-kiro-http.test.ts
PLAYWRIGHT_BROWSERS_PATH=/home/ashwinpc/.cache/ms-playwright PLAYWRIGHT_PORT=23896 \
  npx playwright test tests/e2e/native-harness.spec.ts --grep Kiro \
  --project=mobile --project=tablet --project=desktop --retries=0 --repeat-each=2
```

Build the changed frontend **before** the browser command: production `server.ts` serves `dist`, and an old bundle does not know Kiro. The first browser attempt exposed that stale-bundle setup error; the next exposed a test assumption about reloading the last viewer. The final test keeps another real viewer connected for hydration, while separate adapter tests assert last-viewer cancellation. The settings assertion dismisses by clicking visible native prose, avoiding both the retained desktop drawer edge and mobile compact-toggle behavior.

The full gate is **`npm test`**, not selected suites or `test:serial`. Use the allowlisted disposable HOME/state recipe in [native compatibility](native-compatibility.md#deterministic-full-gate--no-real-models), explicit `PLAYWRIGHT_BROWSERS_PATH`, and free static ports. The implementation run uses offset `14000` and Playwright port `23896` in separate, non-overlapping jobs. Never reuse public ports 8787/8788 or restart the running checkout.

No actual Kiro executable was started by the implementation validation commands: every Kiro create/load/prompt path used the synthetic executable. Separate zero-model evidence from 2026-09-24 informs that peer without mixing actual capture content with synthetic transcript data. A real canary is a separate authorized phase with a persistent budget, native configuration intact and an explicit allowance for native session/log writes. Green deterministic tests grant no inference budget or deployment permission.

## Recorded producer gate — 2026-09-24

The frozen tested code is **`9dcc6f3b3f27360d682f36499b3cb8bdf13fffa2`**, on the accepted three-harness base `28ae094`. Node 24.15.0 and npm 11.12.1 were used. Documentation-only changes after this pin do not change the tested source.

| Check | Result |
| --- | --- |
| Project typecheck, strict standalone Kiro leaf check, complete build | Passed |
| Four focused native suites | **54 passed**, zero skips/failures |
| Kiro browser matrix, two repeats across three viewports | **12 passed**, zero skips/failures/retries |
| Scroll regression matrix, three repeats across three viewports | **27 passed**, zero skips/failures/retries |
| Complete parallel `npm test`, two shards and concurrency four | **853 unit passes / 2 skips; 897 browser passes / 55 skips; zero failures/retries**, 443.5 seconds |
| Existing snapshots | Unchanged |
| Native model canary | Unverified: real canary pending |

The two unit skips are the existing opt-in Claude configuration and synthetic-SSE actual-CLI cases. Browser skips are the same 55 existing conditional cases: 49 viewport-specific and six opt-in diagnostics. The full browser breakdown is mobile 302/9 skipped, tablet 271/40, desktop 305/6, and auth 19/0. Exact names are retained in the producer skip inventory; passing counts are per checkpoint, not additive.

The full gate exposed a **pre-existing** shared scroll race: explicit wheel intent was discarded while the programmatic-scroll reset was pending. Both the original renderer and original failing test were unchanged from the base. A deterministic browser probe reproduced it red, and `9dcc6f3` removes only that input-handler guard while preserving the separate guard on actual programmatic scroll events. The original selection assertion is unchanged. This repair is independently reviewable from the Kiro leaf and explains the three additional browser cases.

Producer receipts live under `.pi/web/artifacts/kiro-implementation/`: exact commands, source hashes, red/green evidence, full logs, skip inventory and cleanup. These are supplementary evidence, not required runtime/test inputs. Earlier setup failures and the inherited failing full run remain recorded; they are not counted as acceptance. All owned validation processes finished, owned ports were checked free, and scratch validation homes were removed. No live restart, push, native-home change or real model call was performed by this worker.

Primary protocol references: [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls), [Kiro ACP](https://kiro.dev/docs/cli/acp.md), [Kiro v3 migration](https://kiro.dev/docs/cli/v3.md). Live documentation is not immutable evidence of the pinned binary's post-initialize behavior.
