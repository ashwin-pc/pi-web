# Claude native integration

Tracked by [#92](https://github.com/ashwin-pc/pi-web/issues/92) and [#14](https://github.com/ashwin-pc/pi-web/issues/14). Use the native Claude Agent SDK behind the same session service/UI as Pi and Codex. Do not translate private native transcript stores or add a second session manager.

**Current implementation: pinned native SDK ingress and controllable peers. Application adapter/UI wiring is not yet complete.** Passing these tests is not a claim of Claude browser support or a substitute for the Pi+Codex vertical validation gate.

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

`server/session/adapters/claude/native.ts` is the process entry point. It uses the SDK's public `query()` and documented `spawnClaudeCodeProcess` seam, not an untyped transport or private SDK option.

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
| Create/resume/list/history | `query`, `resume`, `listSessions`, `getSessionInfo`, `getSessionMessages`. Native UUID can be preassigned; empty sessions need not be materialized. History is a chronological conversation chain, not a Pi tree. | Separate web identity from native UUID/process generation. Use only supported readers. No invented `sessionFile`. Adapter wiring pending. |
| Text/thinking/tools | Partial API events plus one complete assistant message **per content block**. Several blocks share API `message.id` but have distinct wrapper UUIDs. Tool IDs join tool results, progress and approvals. | Reconcile partial and complete blocks; don't deduplicate entire messages by API message ID. Expose only actual thinking, not invented text. |
| Send/lifecycle | User replay can acknowledge receipt. Optional `user_message_uuid(s)` correlates replies/results. Result closes a turn; `session_state_changed: idle` is authoritative settlement. Success subtype can still have `is_error: true`. | No receipt synthesized from an SDK input write. No idle inferred just from result or `queued_turn_count: 0`. |
| Interrupt/steering | Public `Query.interrupt()` targets the current query, not a supplied execution ID. Its `still_queued` receipt means queued input can survive. | Stale execution/query-generation guards in the handle. Initially reject concurrent/steering sends; don't build a queue manager or call untyped SDK methods. |
| Approval | `canUseTool` receives only unresolved native asks, not every tool. Request/tool/agent IDs, native permission suggestions/scopes, cancellation signal and caution flags are preserved. Deny can continue; `interrupt: true` is different. | Native decisions through the contextual UI; bounded deny on timeout/disconnect; duplicate/late response handling. Never use `bypassPermissions` to turn tests green. |
| Questions/MCP elicitation | AskUserQuestion uses validated updated input; MCP elicitation has separate accept/decline/cancel meanings. Unknown declared dialog kind must be cancelled. | Don't map every interaction to a generic allow. Declare only dialogs the UI implements. |
| Fork | `forkSession(id,{upToMessageId})` is inclusive, creates a new session and fresh copied message UUIDs, source unchanged. No file checkpoints copied. `resumeSessionAt` is a distinct truncating resume. | Disabled until exact boundary/copy/source/lineage tests and a consumer exist. No fake tree navigation or filesystem rewind. |
| Models/effort | `supportedModels`, `setModel`, initial thinking/effort, `applyFlagSettings({effortLevel})`; availability varies by model. | Inherit native choices; expose only validated native settings, not Pi's model registry. |
| Compaction | Native automatic compaction; `/compact` for manual compaction. No compact boundary can mean a successful no-op, not compaction success. | Preserve native automatic behavior. Use the native command path, not Pi compaction/retry machinery. |
| Subagents | Native agents, task events, `stopTask`, `backgroundTasks`, supported subagent history readers. Nested complete messages available; token-level deltas are main-session only. | Preserve native activity. No fake Pi worker lineage or direct host-side agent steer. Declare per-task stop affordance only with an actual stop UI. |
| Checkpoints | `enableFileCheckpointing` and `rewindFiles`; tracked Write/Edit/NotebookEdit changes only, not Bash writes or ordinary subagent edits. Conversation unchanged. | Separate optional, disabled until tested; not implied by a history fork. |
| MCP/hooks/skills/plugins | Native configuration; in-process SDK MCP optional. Native filesystem hooks coexist with SDK callbacks. Commands from native discovery/change events. Skills have no programmatic registration API. Explicit plugins support local paths. | Don't replace native tool/config sets or advertise Pi extension portability. Native filesystem hook/skill preservation is canary-tested below; other rich consumers are pending. |
| Usage | Query-cumulative `modelUsage`/estimated cost; per-turn main-loop `usage`. Resumes/clear can reset totals; helper calls can be excluded. | Never sum cumulative result totals or present estimates as billing. |
| Unknown native ingress | SDK passes additive info through; consumes required controls and errors on unknown subtypes; skips malformed non-JSON lines. | Observe before SDK consumption. Metadata-only observation buffers at most 64 KiB per line; large real output is still forwarded intact. |

For forks, checkpointing, tools, commands and richer controls, native support alone is not a pi-web implementation. Add a consumer and both deterministic/actual evidence before enabling a capability.

## Validation

### Deterministic, LLM-free SDK ingress

```sh
npm ci
npx vitest run tests/claude-native.test.ts
npm run typecheck
npm run build
npm run test:unit
```

`tests/fixtures/claude-native-peer.ts` exports `ClaudeNativePeer`, a controllable `SpawnedProcess` used by the **real pinned SDK**. It exposes `send`, `sendRaw`, `received`, `nextInput`, `exit`, and `fail`. It is not a Pi-shaped fake session or alternate adapter. A browser test's existing mock controls can drive that peer while using normal application HTTP/WebSocket/session paths; no extra fixture server is needed.

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

Complete the common adapter's lifecycle/approval/recovery tests, normal HTTP/WebSocket desktop/mobile workflows, and `npm test` (the full parallel/sharded runner). The unit suite is not a full-suite waiver.

Actual generation canaries must be separately enabled, budgeted and run in a trusted disposable cwd with native auth/config/permissions intact. Verify visible text/tool/approval/interrupt/resume/restart paths; record blocked credentials/sandbox cases as blocked, not passed or inapplicable. Never auto-approve to make a canary pass.

Validation on 2026-09-14 before application wiring: 17 native-ingress tests passed; no-LLM actual configuration canary passed; typecheck/build passed; full unit suite 597 passed, 1 opt-in skipped. System CLI remained `2.1.226`. `bwrap` and `socat` were not on PATH; sandbox enforcement was not canary-tested.

SDK distribution documentation restricts third-party claude.ai login offerings and prefers “Claude Agent” branding. Preserve server-side native credentials; don't add a new login flow or expose SDK account/auth-output objects to the browser.
