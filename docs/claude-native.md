# Claude native integration

Tracked by [#92](https://github.com/ashwin-pc/pi-web/issues/92) and [#14](https://github.com/ashwin-pc/pi-web/issues/14). Use the native Claude Agent SDK behind the same session service/UI as Pi and Codex. Do not translate private native transcript stores or add a second session manager.

**Current implementation: a lazy native adapter behind the common service/host path, with SDK/process ingress, transcript projection, approval handling and supported native history readers.** Deterministic adapter/service evidence and the no-LLM CLI configuration canary are distinct from browser/authenticated generation evidence. Neither substitutes for the Pi+Codex vertical validation gate.

## Version pins

| Component | Pin |
|---|---|
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.270` (exact dependency) |
| Bundled native CLI | Claude Code `2.1.270`; every platform optional dependency is `0.3.270` |
| SDK peer dependencies resolved in lockfile | `@anthropic-ai/sdk@0.125.0`, `@modelcontextprotocol/sdk@1.30.0`, `zod@4.4.3` |
| Pi SDK | Unchanged `0.84.1`; Pi's Anthropic client stays `0.91.1` in its own dependency subtree |

The installed system `claude` was `2.1.226` during validation. It was **not** updated, replaced, or used with the newer SDK. An exact matching SDK `0.3.226` exists, but lacks several newer correlation, approval-hint, and permission-denial fixes. The integration uses its own matching bundled binary; report that integration version separately from the user's system CLI.

The matching platform package must be installed; do not use `npm ci --omit=optional`. The SDK selects the native platform package itself. No global installation is needed.

Primary sources:
- [TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript), plus `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for the exact pin.
- [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [user input](https://code.claude.com/docs/en/agent-sdk/user-input).
- [Native configuration](https://code.claude.com/docs/en/agent-sdk/claude-code-features) and [system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).

## Preserve native behavior

`server/session/adapters/claude/index.ts` exports `createClaudeAdapter({ pathToClaudeCodeExecutable })`. Construction only checks installation readiness: it never starts a native process or loads native auth/settings/models for the catalog. The handle starts a query on explicit input; opening/listing uses supported SDK readers. Explicit executable overrides are version-checked before user input is sent; availability is not proof of credentials or inference.

`native.ts` is the sole process entry point. It uses the SDK's public `query()` and documented `spawnClaudeCodeProcess` seam, not an untyped transport or private SDK option. `transcript.ts` only projects native content; `approvals.ts` owns native permission choices. Neither is a second service or session manager.

- Use `systemPrompt: { type: "preset", preset: "claude_code" }`. The SDK's omitted prompt is a **minimal** prompt, not the CLI's full tool/safety/environment instructions.
- Load user, project, and local setting sources. Keep native auth, model selection, tools, sandbox enforcement, hooks, instructions, skills, commands and plugins in the CLI; don't reconstruct their settings in pi-web.
- Do not add tool allowlists, `skills: "all"` (which auto-allows Skill), strict MCP configuration, bare/safe mode, new instructions or a relocated native home merely to make tests pass.
- Native overrides are explicit. SDK `env`, when supplied, replaces rather than extends the inherited environment. Production should normally leave it omitted; the custom spawner forwards the environment provided by the SDK.
- The custom spawner drains stderr without retaining arbitrary native debug/auth text. Ingress diagnostics contain only bounded message metadata, never credentials, prompts, tool bodies or native-home contents.

### One necessary permission-mode mitigation

SDK `0.3.270` inserts `--permission-mode default` even when no mode was requested. That would override native `permissions.defaultMode`, including a user's restrictive `dontAsk` mode.

Only in inherited-mode operation, the public spawn seam removes the **single exact SDK-generated** `--permission-mode default` pair. Unexpected, missing, combined, or duplicate mode arguments reject **before process spawn**. Explicit `permissionMode` is preserved; every unrelated argument/guardrail is unchanged. Raw extra mode arguments are rejected rather than guessed at.

The native CLI then resolves its own policy and trust tiers. Do not substitute the hidden runtime-only `resolvePermissionModeInCli` option or alpha `resolveSettings()`; the latter cannot reproduce policyHelper and fresh server-managed policy behavior. This mitigation is version-specific and is covered both by deterministic SDK ingress tests and a separate actual-CLI, no-LLM configuration canary.

Headless Claude still differs from its interactive terminal: its help states that workspace-trust dialogs are skipped and invalid settings files are ignored. Execute only in an explicitly user-selected/trusted cwd; do not claim terminal trust-dialog parity.

## Native semantics and applicability

These are public native capabilities, not claims that all controls are exposed in pi-web. Unsupported controls must stay disabled at both UI and service boundaries.

| Feature | Public native behavior | Integration treatment |
|---|---|---|
| Create/resume/list/history | `query`, `resume`, `listSessions`, `getSessionInfo`, `getSessionMessages`. Native UUID can be preassigned; empty sessions need not be materialized. History is a chronological conversation chain, not a Pi tree. | Implemented and tested through the common service. Cached unmaterialized/unavailable status is not authority: persistent IDs are checked with native info/history before rejection. No recreated session, prompt replay or invented `sessionFile`. |
| Text/thinking/tools | Partial API events plus one complete assistant message **per content block**. Several blocks share API `message.id` but have distinct wrapper UUIDs. Tool IDs join tool results, progress and approvals. | Implemented: stable ordered parts, partial/final reconciliation, tool-call/result IDs and structured tool-result details. Redacted thinking is metadata, never invented text. Live native timestamps are preserved; cold SDK history lacks a general timestamp field, so none is fabricated. |
| Send/lifecycle | User replay can acknowledge receipt. Optional `user_message_uuid(s)` correlates replies/results. Result closes a turn; `session_state_changed: idle` is authoritative settlement. Success subtype can still have `is_error: true`. | Implemented: dispatch returns pending until native evidence exists; replay/first-reply evidence produces the correlated user message. Native errors before acknowledgement resolve the client error without inventing accepted history. Only authoritative idle after the current result settles the handle. |
| Interrupt/steering | Public `Query.interrupt()` targets the current query, not a supplied execution ID. Its `still_queued` receipt means queued input can survive. | Implemented host execution/query-generation guards, bounded interrupt acknowledgement and duplicate/late final/idle handling. Only mode `prompt` is accepted; concurrent input and explicit steering/followUp reject. No queue manager or untyped SDK methods. |
| Approval | `canUseTool` receives only unresolved native asks, not every tool. Request/tool/agent IDs, native permission suggestions/scopes, cancellation signal and caution flags are preserved. Deny can continue; `interrupt: true` is different. | Implemented: exact allow-once/suggested-update/deny/deny-and-stop choices, caution hints, timeout/disconnect/native cancellation and duplicate/late handling. Reused request IDs with changed input cannot inherit an approval. Never use `bypassPermissions` to turn tests green. |
| Questions/MCP elicitation | AskUserQuestion uses validated updated input; MCP elicitation has separate accept/decline/cancel meanings. Unknown declared dialog kind must be cancelled. | AskUserQuestion is implemented with validated question/option IDs and original native labels. Unsupported MCP elicitation is explicitly declined; no unimplemented dialog kinds are declared. |
| Fork | `forkSession(id,{upToMessageId})` is inclusive, creates a new session and fresh copied message UUIDs, source unchanged. No file checkpoints copied. `resumeSessionAt` is a distinct truncating resume. | Disabled until exact boundary/copy/source/lineage tests and a consumer exist. No fake tree navigation or filesystem rewind. |
| Models/effort | `supportedModels`, `setModel`, initial thinking/effort, `applyFlagSettings({effortLevel})`; availability varies by model. | Inherit native choices; expose only validated native settings, not Pi's model registry. |
| Compaction | Native automatic compaction; `/compact` for manual compaction. No compact boundary can mean a successful no-op, not compaction success. | Automatic native behavior remains; typed native commands follow the ordinary prompt path. Dedicated compaction/context-switch UI is disabled. `/clear`, `/resume`, `/fork`, `/new` reject; unexpected native conversation resets fail visibly rather than corrupt identity/history. No Pi retry/compaction impersonation. |
| Subagents | Native agents, task events, `stopTask`, `backgroundTasks`, supported subagent history readers. Nested complete messages available; token-level deltas are main-session only. | Preserve native activity. No fake Pi worker lineage or direct host-side agent steer. Declare per-task stop affordance only with an actual stop UI. |
| Checkpoints | `enableFileCheckpointing` and `rewindFiles`; tracked Write/Edit/NotebookEdit changes only, not Bash writes or ordinary subagent edits. Conversation unchanged. | Separate optional, disabled until tested; not implied by a history fork. |
| MCP/hooks/skills/plugins | Native configuration; in-process SDK MCP optional. Native filesystem hooks coexist with SDK callbacks. Commands from native discovery/change events. Skills have no programmatic registration API. Explicit plugins support local paths. | Native tool/config sets remain intact; Pi extensions remain Pi-only. Filesystem hook/skill preservation is canary-tested below. Other management controls and rich task/MCP/plugin panels are deferred and disabled. |
| Usage | Query-cumulative `modelUsage`/estimated cost; per-turn main-loop `usage`. Resumes/clear can reset totals; helper calls can be excluded. | Current-query reported usage/cost only; never sum cumulative results or present it as a full-history bill. Unknown cost is omitted, and fatal zeroed results do not erase known running totals. New native processes reset the observed accounting scope. |
| Unknown native ingress | SDK passes additive info through; consumes required controls and errors on unknown subtypes; skips malformed non-JSON lines. | Observe before SDK consumption. Metadata-only observation buffers at most 64 KiB per line; large real output is still forwarded intact. |

For forks, checkpointing, tools, commands and richer controls, native support alone is not a pi-web implementation. Add a consumer and both deterministic/actual evidence before enabling a capability.

## Validation

### Deterministic, LLM-free SDK ingress

```sh
npm ci
npx vitest run tests/claude-native.test.ts tests/claude-native-cli.test.ts \
  tests/claude-adapter.test.ts tests/claude-session-service.test.ts
npm run typecheck
npm run build
npm run test:unit
```

`tests/fixtures/claude-native-peer.ts` exports `ClaudeNativePeer`, a controllable `SpawnedProcess` used by the **real pinned SDK**. It exposes `send`, `sendRaw`, `received`, `nextInput`, `exit`, and `fail`. It is not a Pi-shaped fake session or alternate adapter.

For real `server.ts` browser tests with `PI_WEB_MOCK` **off**, `tests/fixtures/claude-native-cli.mjs` wraps the same peer in a real child process. Set the server's `PI_WEB_CLAUDE_EXECUTABLE` to its absolute path and `PI_WEB_CLAUDE_PEER_DIR` to an isolated scratch directory. No HTTP fixture controller or `route.fulfill` is needed.

The fixture creates `<scratch>/peers/<pid>/ready.json` with `pid`, `directory`, `nativeSessionId` and `cwd`. `observed.jsonl` records `{direction, message}` for client/server/control traffic. Write numbered JSON files atomically into `commands/` (write a `.tmp` file, then rename):

```json
{"action":"emit","message":{"type":"system","subtype":"session_state_changed","state":"idle"}}
```

Other commands are `{"action":"raw","data":"..."}` and `{"action":"exit","code":42}`. Ordinary emitted frames receive missing session/UUID envelope fields. The fixture automatically answers SDK initialization, echoes native user acknowledgement and running state, and acknowledges interrupt **without** manufacturing a result or idle event. Tests inject text/tool/approval/result/idle frames separately. The process ends on stdin EOF, explicit exit, or its finite 120-second lifetime (`PI_WEB_CLAUDE_PEER_MAX_MS`, capped at 300 seconds).

This executable does not create fake private native session files. Supported SDK list/history readers are a separate ingress; do not claim native persisted history from the executable peer alone.

Covered: native invocation/config preservation, six unexpected argv shapes failing closed, exact pin, unknown required-control error, additive info, malformed/oversized/redacted observation, split UTF-8, duplicate approval IDs/scopes/caution flags, cancellation, native interrupt receipt, and process failure. This is synthetic protocol evidence, not native generation evidence.

### Actual CLI configuration canary — opt-in, no LLM

```sh
PI_WEB_CLAUDE_CONFIG_CANARY=1 DISABLE_TELEMETRY=1 \
  npx vitest run tests/claude-native-config.test.ts
```

This uses the real bundled CLI in a disposable HOME/config with a synthetic API key and an unreachable localhost API endpoint. A fresh-session `/compact` is the documented no-op with nothing to summarize. Assertions require a successful result with **zero model turns, zero cost and empty model usage**. No real credentials/providers or user's native home are touched.

Verified: native `dontAsk` from settings survives the mitigation; explicit `plan` is retained; a native filesystem SessionStart hook runs; a project skill is discovered; public `Query.readFile()` permits an allowed fixture and respects a native Read deny rule. This does **not** validate native user authentication, generation, tools, sandbox dependencies, history recovery or the browser.

A programmatic SessionStart callback did not fire on the local-command path during investigation. The canary deliberately verifies the native filesystem hook and reads effective mode from public `system/init`, rather than claiming callback execution from registration alone.

### Remaining application and actual-generation gates

The adapter/service tests cover native acknowledgement vs settlement, partial/final/tool correlation, validated approvals/questions, cancellation/timeouts, unknown ingress, process failure, and persistent native acceptance racing the host binding write. Normal HTTP/WebSocket desktop/mobile workflows and actual authenticated generation remain separate gates. Run `npm test` (the full parallel/sharded runner); the unit suite is not a full-suite waiver.

Actual generation canaries must be separately enabled, budgeted and run in a trusted disposable cwd with native auth/config/permissions intact. Verify visible text/tool/approval/interrupt/resume/restart paths; record blocked credentials/sandbox cases as blocked, not passed or inapplicable. Never auto-approve to make a canary pass.

Validation on 2026-09-14: native SDK, executable-peer, adapter and service/host tests passed, including the opt-in no-LLM actual configuration canary. Strict native-module typecheck, repository typecheck and build passed. System CLI remained `2.1.226`. `bwrap` and `socat` were not on PATH; sandbox enforcement was not canary-tested.

The full command `PI_WEB_E2E_PORT_OFFSET=40000 PI_WEB_E2E_SHARDS=2 npm test` **ran and failed** on this private checkout with core `76693db` and without the separately owned UI/core follow-ups. Build/typecheck/unit passed (622 unit tests, 1 opt-in skipped at that run). Desktop and one tablet shard passed. The other browser shards reported 16 failures: mobile/tablet `retry-errors.spec.ts:7`, `send-stop.spec.ts:25`, two mobile `minimal-visual.spec.ts` screenshots, and ten mobile `visual.spec.ts` screenshots. The mobile touch-swipe case was flaky. These suites run the existing mock/Pi path with native harnesses disabled; they are recorded failures, **not waived or claimed fixed** by the Claude leaf. Shared/UI owners must reconcile them on the assembled integration before merge. Native browser and actual-generation gates remain separate.

SDK distribution documentation restricts third-party claude.ai login offerings and prefers “Claude Agent” branding. Preserve server-side native credentials; don't add a new login flow or expose SDK account/auth-output objects to the browser.
