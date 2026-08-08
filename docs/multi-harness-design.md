# Multi-harness session design

Companion to [`runtime-binding-design.md`](./runtime-binding-design.md). Tracked by issue #92; event-contract spec in the [#92 Track-0 comment](https://github.com/ashwin-pc/pi-web/issues/92). Runtime and harness are orthogonal session attributes: the runtime is *which box* a session runs on; the harness is *which agent* runs it. One binding record, one router, one typed contract.

## Product invariants

- pi remains the in-process, full-capability reference harness. Adding harnesses never reduces pi's feature surface.
- **Runtime axis:** transport never changes behavior. Parity by construction; no capability flag may excuse transport drift (unchanged from the runtime design).
- **Harness axis:** harnesses genuinely differ, so per-session capability flags gate the UI. Capabilities come only from the harness, never from the transport. The Stage-3 parity ratchet asserts identical behavior *and identical capability set* for the same implementation in-process vs over stdio.
- Nothing is silently dropped. Unmapped harness events cross the wire as opaque `harness_event` values; unknown union variants are tolerated by every consumer.
- Harness session stores are never parsed as a persistence contract (`~/.codex/sessions`, `~/.claude/projects`, `~/.hermes/state.db` are all declared internal upstream). pi-web persists harness session IDs plus its own metadata, including fork lineage.
- Credentials never reach the browser. Harness homes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`) are per-trust-domain.

## The contract (Track 0)

The `SessionService` boundary from the runtime design becomes agent-neutral through four amendments, made once, before the Stage-3 runner protocol freezes:

1. **Typed event union** replacing verbatim `pi_event` payloads. All 21 pi `AgentSessionEvent` types map (full disposition table in the #92 comment). Rules: everything crosses the wire typed; heavy payloads slim to references (`turn_end`, `message_start`) because content flows once via deltas; persistence-shaped payloads translate to DTOs (`entry_appended` → `committed_message` with `{entryId, parentId?, kind}`); `message_update` carries deltas only (#79). Turns are deliberately first-class: they are the cross-harness lifecycle unit (codex `turn/*`, ACP prompt-turn, Claude per-turn results) and the boundary where steering lands.
2. **`capabilities` block** in the session state DTO; harness-specific fields (`queue`, `thinkingLevel`, tree ops) become optional. pi reports the full set.
3. **Generic interaction request/respond channel**, generalizing the extension-UI inversion: one pending-request map and wire shape for extension dialogs, tool approvals, and clarify/sudo/secret prompts. Deny on timeout and disconnect.
4. **Binding store schema** `sessionId → { runtimeId, harnessId }` (Stage 4), even if harness routing lands after runtime routing.

### Loss-prevention mechanics

- The pi adapter maps events in one exhaustive `switch` over `AgentSessionEvent["type"]` ending in a `never` assertion (`server/session/piEventMap.ts`). A pi upgrade that adds an event type fails `typecheck` until explicitly mapped or opaque-wrapped.
- Replay fixtures: recorded pi event logs run through the mapper and snapshot-compare, so payload drift inside `any`-typed fields (tool `args`/`result`) surfaces as a reviewable diff.
- The union is additive-only; the `harness_event` escape hatch plus unknown-variant tolerance means "unsupported" degrades to *invisible but present*, never *lost*.

## The `AgentAdapter` seam (Track H1)

`PiWebSession` + `LocalSessionFactory` dissolve into a designed two-level interface. `SessionService` keeps everything generic — leases, idle cleanup, listing orchestration, realtime correlation — and delegates agent behavior:

```ts
interface HarnessAdapter {
  id: HarnessId;
  capabilities(): HarnessCapabilities;          // static per harness/version
  list(cwd: string): Promise<SessionInfoDto[]>;
  create(input: CreateInput): Promise<AgentSessionHandle>;
  open(ref: SessionRef): Promise<AgentSessionHandle>;
  remove(ref: SessionRef): Promise<RemovalDisposition>;
}

interface AgentSessionHandle {
  state(): AgentStateDto;                        // includes capabilities
  messages(): MessageDto[];
  prompt(text: string, opts: { mode: "normal" | "steer" | "followUp"; images?: ImageDto[] }): Promise<void>;
  abort(): Promise<void>;
  respondInteraction(id: string, response: InteractionResponseDto): void;
  subscribe(l: (e: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
  // capability-gated optionals:
  fork?(atEntryId?: string): Promise<SessionRef>;
  compact?(instructions?: string): Promise<void>;
  setModel?(ref: ModelRefDto): Promise<void>;
  models?(): ModelDto[];
  navigateTree?(...): Promise<...>;              // pi-only today
}
```

The pi adapter absorbs the pi-specific halves of `projection.ts`, the extension web-UI bridge, and the currently `any`-typed internals (`agent.state.messages`, retry-fallback privates, `getCwd`, `dispose`) so pi coupling is contained in one module. The mock harness becomes a `MockAdapter` through the same seam — fixing its current bypass of the event relay and making it the contract's first test double, used to build the approvals UI before any real harness lands.

## Harness bindings

Strategy: **ACP-first with selective native escalation** (evidence: Vibe Kanban ships ~4–5.5k LOC per native adapter vs 236 LOC for its ACP one over a shared ~1.9k client; Omnara deprecated PTY scraping as "unfeasible to maintain").

| Harness | First binding | Escalation (per-feature, optional) |
|---|---|---|
| Hermes (Nous) | native `hermes acp` — sessions list/load/resume/fork, model switch, permissions | TUI gateway WS (`hermes serve`, the Desktop protocol): first-class `session.steer`/`session.redirect`, prefix branching + lineage, approval/clarify/sudo/secret, memory/skills surfaces |
| Codex | `@agentclientprotocol/codex-acp` — no fork; steering via `_session/steering` | `codex app-server`: `thread/fork`, `turn/steer`, `model/list`; version-pinned binary + generated TS types |
| Claude Code | `@agentclientprotocol/claude-agent-acp` — full-session fork; steering ext | `@anthropic-ai/claude-agent-sdk`: at-message `forkSession`, `canUseTool`, in-process MCP tools; SDK patch pins CLI patch |

First cut requires pre-authenticated CLIs (`hermes setup`, `codex login`, claude login); "not authenticated" is a typed error state, not a wedge. Claude subscription login is a local-dev convenience only — distributed deployments use API-key/Bedrock paths and avoid "Claude Code" branding (upstream ToS).

## Differentiator features

Two-tier rule for features beyond core chat:

1. **Cross-harness semantics get union variants.** Plans/todos (codex plan items, Claude TodoWrite, Hermes plans) → one `plan_update` variant. Subagent lifecycle (Claude tasks + `parent_tool_use_id`, Hermes delegation/`subagent.*`, codex collaboration items) → `subagent_start/update/end` variants with a parent linkage field, rendered as a nested transcript/progress tree. Usage/cost → the existing stats DTO.
2. **Harness-unique surfaces ride the contribution kernel, not the core contract.** Adapters may register panels/actions through the same contribution system extensions use (#82/#84/#86): a Hermes **Memory** panel, a Claude **Subagents** browser, a codex **Review** tab. The core union stays lean; `harness_event` + contributions carry the rest.

### Cross-harness union variants (tier 1)

| Variant | pi | Codex | Claude Code | Hermes |
|---|---|---|---|---|
| `plan_update` (checklist + proposed-plan doc) | — | `turn/plan/updated` + plan items; standard ACP `plan`/`plan_update` | TodoWrite / TaskCreate-Update-List; standard ACP `plan` (adapter suppresses raw tool noise) | plan/todo updates via gateway events |
| `subagent_start/update/end` (+ parent linkage, optional child session ref) | — | `collabAgentToolCall` + `subAgentActivity`; `_meta.codex.subagent/.collaboration` | Agent tool + `parent_tool_use_id`, task events; `subagent-transcript` `_meta` ext | `subagent.start/thinking/text/tool/complete` (gateway) |
| interaction requests (approvals/clarify/secret) | extension dialogs | v2 approval flows incl. session-scoped grants, MCP elicitations (form/URL) | `canUseTool`, `ExitPlanMode` plan review | `approval/clarify/sudo/secret.request` |
| compaction + usage (existing variants/stats) | native | `contextCompaction` item, `thread/tokenUsage/updated` | `compact_boundary`, `getContextUsage` | compression + lineage (`parent_session_id`), `session.usage` |

Subagent **rendering** is tier-1 (all harnesses emit lifecycle + linkage); subagent **control** is capability-gated per adapter: Hermes has `subagent.steer`/`subagent.interrupt`; Claude has `stopTask`/`backgroundTasks` (no host-side steer — a "message agent" control must honestly relay via the parent); Codex exposes child threads to open, no direct control RPC.

### Harness-unique surfaces (tier 2 — contribution-kernel panels)

| Harness | Panel/feature | Backing surface | Works on stock ACP? |
|---|---|---|---|
| Hermes | Memory activity toasts ("remembered/updated/forgot") | `memory` tool calls in the event stream | **Yes** |
| Hermes | Memory drawer (raw `MEMORY.md`/`USER.md`, budgets 2,200/1,375 chars, pending approvals, learned-node graph, stale-snapshot warning) | gateway `learning.*` RPCs or dashboard REST `/api/memory*`, `/api/learning*` | No — side channel |
| Hermes | Skills manager; **Automations** (cron jobs — invisible to ACP); SOUL/effective-context inspector | `skills.manage`/REST `/api/skills*`; `cron.manage`/REST `/api/cron*`; `project.facts` + `/api/profiles/{name}/soul` | No — side channel |
| Claude | Background-task drawer + Stop; context meter breakdown; checkpoint dry-run + files-only rewind + branch-at-turn; workflows run cards; plugins/output-styles | `Query` methods: `backgroundTasks`/`stopTask`, `getContextUsage`, `rewindFiles` + `resumeSessionAt`+`forkSession`, Workflow tool + task events | No — `Query`-bound (see below) |
| Codex | Review action (target picker); quota/account center; aggregate turn diff; goal chip | `review/start` (slash-command form works on ACP today); `account/rateLimits/*` (app-server only); `turn/diff/updated` (adapter ignores it); `_session/goal` extension (**version-negotiated, adoptable now**) | Partial |

"Dynamic workflows" (Claude 2.1.154+) and codex `dynamicTools` / Cloud Best-of-N are deliberately deferred: young, high-churn, experimental surfaces. Render launches generically; add management only when public contracts stabilize.

### Side-channel shapes per harness

The escalation path differs structurally, which matters for adapter design:

- **Hermes — side server.** Gateway/REST share `state.db` with the ACP process, so the differentiator client attaches *alongside* stock `hermes acp` without touching the conversation transport.
- **Claude — same-process object.** The imperative controls live on the live `Query`; a side channel cannot be bolted on from outside the subprocess. The moment tier-2 Claude features are wanted, the adapter flips to Agent-SDK-direct (or an extended fork of `claude-agent-acp`) — plan for this flip rather than accreting adapter patches.
- **Codex — same server, more methods.** The extras live on the app-server the ACP adapter already drives. Preferred order: upstream small `codex-acp` enhancements (forward plan `explanation`, web-search `results`, aggregate diff, rate-limit snapshots), then app-server-direct only for host `dynamicTools`, background-terminal management, and account APIs.

Full audit evidence: three differentiator reports under the #92 research set (claude/hermes/codex), each with per-feature programmatic surfaces, ACP availability, and maintenance-risk ratings.

## Delivery plan

Track 0 (contract) → R1 (Stage-3 shim + ratchet) → then in parallel:

- **Runtime track:** R2 Stage-4 fail-closed router with `{runtimeId, harnessId}` bindings → R3 Stage-5 providers (cherry-picked from PR #43's salvage list).
- **Harness track:** H1 `AgentAdapter` seam (pi passes full E2E unchanged) → H2 approvals/interaction UI (built against `MockAdapter`) → H3 Hermes via ACP → H4 codex-acp + claude-agent-acp → H5 native escalations as separate issues.

Convergence is free: a harness-in-sandbox session is the runner shim hosting a harness adapter; the ratchet already proves the transport can't change its capability set.

## Validation

- Contract suite (`describeSessionService`) runs in-process and over the runner; asserts JSON round-trip stability, unknown-variant tolerance, and capability-set equality across transports.
- Black-box adapter suite runs against every adapter in CI: prompt→stream→idle, tool ordering, approval allow/deny/cancel/timeout, abort mid-tool, resume after restart, unknown-enum tolerance, crash recovery, two-session interaction isolation.
- Per-adapter version pins with capability probes at init; upgrades gated on replay-fixture diffs.
