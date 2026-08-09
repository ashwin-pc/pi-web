# Multi-harness session design

Companion to [runtime-binding-design.md](./runtime-binding-design.md). Tracked by issue [#92](https://github.com/ashwin-pc/pi-web/issues/92).

Runtime and harness are orthogonal: runtime selects where a session executes; harness selects which agent executes it. The eventual binding is `sessionId -> { runtimeId, harnessId }`, resolved by one fail-closed router.

## Invariants

- Pi remains the in-process, full-capability reference harness.
- Transport does not alter behavior or capabilities.
- Harness capabilities may differ and are declared per session by the harness, never by its transport.
- Typed events are additive. Unknown harness events remain present through `harness_event`; consumers tolerate unknown variants.
- Harness persistence files are private upstream formats. Pi-web stores only harness references and its own metadata.
- Credentials remain server-side and harness homes are isolated by trust domain.

## Track 0 contract

`SessionService` establishes the agent-neutral boundary before the runner protocol freezes:

1. `server/session/piEventMap.ts` exhaustively maps every published pi `AgentSessionEvent`. `message_update` is delta-only; heavy turn/message-start payloads become references; `entry_appended` becomes durable linkage on `committed_message`.
2. Session state includes harness-owned `capabilities`. Pi reports its complete feature set.
3. `interaction_request` and `/api/interactions/respond` form one request/respond channel for extension dialogs, approvals, clarify, sudo, and secret prompts. Requests deny/cancel on timeout, abort, or disconnect.
4. Runtime bindings reserve both `runtimeId` and `harnessId`.

The mapping switch ends in a `never` assertion, making new pi events a compile-time migration. Recorded replay fixtures snapshot the mapped JSON shapes. The generic `{ type: "harness_event", harness, payload }` variant keeps future and harness-specific events visible without leaking persistence formats.

`agent_end` is not an idle boundary. Pi may still process extension handlers, retries, compaction, queued messages, or post-run continuation. `agent_settled` is the authoritative prompt-safe transition.

## Adapter seam

Track H1 replaces `PiWebSession` with two levels:

- `HarnessAdapter`: list/create/open/remove and static capabilities.
- `AgentSessionHandle`: state/messages/prompt/abort/interactions/events plus capability-gated operations such as fork, compact, model selection, and tree navigation.

The pi adapter contains pi-specific projection and compatibility logic. The mock implements the same seam and serves as the first approvals test double.

## Bindings

Initial integrations are ACP-first:

| Harness | Initial binding | Optional escalation |
|---|---|---|
| Hermes | `hermes acp` | Hermes gateway/REST for steering, memory, skills, cron, and richer interactions |
| Codex | `codex-acp` | app-server for fork, steer, model/account, diff, and review features |
| Claude Code | `claude-agent-acp` | Agent SDK for message forks, approvals, tasks, and checkpoints |

Cross-harness concepts such as plans and subagents become typed union variants. Harness-unique surfaces use the contribution kernel rather than expanding the core contract.

## Delivery

1. Track 0: typed contract, capabilities, interactions, binding schema, pi 0.84.x.
2. R1: Stage-3 runner shim and transport/capability parity ratchet.
3. In parallel: runtime router/providers and H1 adapter seam.
4. Approvals UI against the mock adapter.
5. Hermes, Codex, and Claude ACP adapters.
6. Native escalations only as separately justified features.

## Validation

- Run the same `SessionService` contract in-process and over the runner, including capability equality.
- Snapshot recorded event mappings and JSON round trips.
- Require every adapter to pass prompt/stream/settle, tool ordering, interactions, abort, resume, unknown-event, crash-recovery, and multi-session isolation tests.
- Version-pin adapters and review replay diffs on every upgrade.
