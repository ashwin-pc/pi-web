# Native harness compatibility and validation

The core opt-in path is in `server/session/{adapter,service,dto}.ts`; protocol implementations live under `server/session/adapters/`. **Core fixtures, native protocol peers, real browser workflows, and actual model/tool canaries are different evidence.** Do not count one as another.

## Capability and ownership matrix

| Area | Pi | Codex / Claude initial boundary |
| --- | --- | --- |
| Create, open, list | Existing public UUIDs and Pi history preserved | Independent web UUID + native reference; supported native discovery/resume APIs only |
| Prompt / streamed content | Existing SDK behavior and Pi fidelity fallback | Native dispatch/acknowledgement separated; ordered keyed text/thinking/tool/image projection |
| Activity / settlement | Retry, compaction, queue and `agent_settled` retained | Native authoritative phase/activity; final item/message is not idle |
| Interrupt | Pi abort with optional host stale guard | Required host expected-execution guard; Codex exact real turn ID, Claude live Query only |
| Queue / follow-up | Pi-only, preserved | Deferred and disabled; concurrent ordinary input rejected |
| Steering | Pi-only legacy semantics preserved | Disabled initially; enabling requires native precondition and stale-guard tests |
| Approvals / questions | Pi extension dialogs preserved, pending/resolved lifecycle added | Native request-scoped offered choices; adapter-owned validation and fail-closed unsupported controls |
| History tree / edit / rerun | Existing Pi tree behavior preserved | Disabled; no implied native tree or filesystem rewind |
| New-session history fork | Existing supported Pi behavior only; extension-initiated fork remains unsupported | Deferred and disabled; provenance is not a history fork |
| Retry / manual compaction | Pi-only, preserved | Host controls disabled; native automatic retry/compaction stays native |
| Model / thinking / provider auth | Existing Pi registry and defaults preserved | Read-only observed native settings initially; no Pi provider/default substitution |
| Skills / commands / instruction files | Existing Pi discovery preserved | Native discovery/configuration remains native; no extra Pi loader or generic command API |
| Tools / MCP / permissions / sandbox | Existing Pi tools/extensions preserved | Native execution and enforcement; host does not replace tools or broaden grants |
| Pi-native extensions / dialogs / custom renderers | Preserved inside Pi | No portability claim; Pi-dependent browser contributions disabled |
| Worker spawning / notepad / delegation spool | Pi-only; public UUID compatibility preserved | Deferred and disabled; native subagent observations are not pi-web worker obligations |
| Files / Git / built-in artifacts | Existing host routes preserved | Available as host features, not replacements for native sandboxed tool execution |
| Attachments | Pi attachment markup preserved | Disabled unless an adapter explicitly supports and tests them |
| Usage / cost | Existing Pi accounting preserved | Native observations only; missing cost is unknown, not $0 |
| Completion notifications | Existing Pi behavior preserved | Deferred; native idle also follows interruption, so core does not invent successful completion |
| Restart / process cleanup | Existing Pi re-open and extension shutdown retained | Durable exact native resume; no replay of prompts; ephemeral handles expire after process loss |
| Removal | Existing native Pi trash/delete | Removes the pi-web binding only; native history remains intact |
| Runtime transports | Local in-process service | Child processes are implementation details of native adapters; ACP/runner/remote/container bindings are not included |

All Pi-only controls are rejected at the service boundary for native handles, not merely hidden in the browser. Native adapters must independently validate supported control choices, timeout/disconnect behavior, and native correlation. Unknown informational ingress requires bounded/redacted observations; unknown required controls must not silently approve or hang.

## Reproducible checks

Follow repository instructions for complete validation:

```sh
npm ci
npm run typecheck
npm run build
npm test
```

`npm test` is the parallel/sharded runner. Use `PI_WEB_E2E_PORT_OFFSET=<unused offset>` and isolated state directories when running alongside another checkout. Do not use a real server's authentication or UI-state files.

Focused core checks:

```sh
npm run test:unit -- tests/session-service.test.ts tests/session-adapter-service.test.ts \
  tests/session-projection.test.ts tests/pi-event-map.test.ts tests/extensions.test.ts tests/context.test.ts
```

The new `session-adapter-service` fixture proves core routing/admission and metadata behavior only. Codex/Claude protocol fixtures must enter the production native process/SDK seam; browser evidence must launch the real `server.ts` with `PI_WEB_MOCK` off. Native executable/peer configuration is server-side only. A missing native installation is an unavailable catalog entry, never Pi fallback.

## Core integration evidence

The core checkpoint integrates the native Codex leaf and canonical frontend. Claude's leaf/dependencies and the final full-suite/native-browser verification remain separately integrated work; the policy matrix above is not a claim that those checks have run here.

- `npm run typecheck`: passed, including all present native adapter sources.
- `npm run build`: passed (existing large-chunk advisory only).
- Full unit suite: **662 tests passed across 65 files**.
- Pi desktop browser regression subset: **24 passed** (send/stop, stale runtime, steering/follow-up queues and reconnect, thinking, and both session-creation contribution flows). The stale-runtime adversary now uses explicit `/api/mock/event`, not a mock broadcast bypass; the frontend guard was fixed without weakening the assertion.
- `tests/pi-adapter-sdk.test.ts`: actual **Pi SDK 0.84.1**, isolated credentials/home, startup extension binding, command handling, shutdown notification, and `ctx.sessionManager` UUID matching the public ID. No inference was requested.
- `tests/native-bindings.test.ts`: partial-write/rename failures preserve memory and disk; own temporary files are removed; concurrent duplicate native identities reject at commit; a later queued candidate cannot leak into an earlier snapshot; retry succeeds.
- `tests/session-service.test.ts`: defaults and delayed-finalizer SDK/state events cannot publish early, while a startup confirmation can still be answered. Pi's existing behavior assertions remain.
- `tests/session-adapter-service.test.ts`: failed creation has no registration-snapshot binding leak; explicit persistent recovery is coalesced and never replays prompts; failed recovery cannot repeatedly respawn on state polls; unavailable ephemeral handles remain 410.
- `tests/session-codex-http.test.ts`: real `server.ts`, HTTP and WebSocket, `PI_WEB_MOCK=0`, production native Codex adapter, and a synthetic native process. Covers catalog/create, independent IDs, native settings inheritance, prompt acknowledgement, ordered text/thinking/tool output, native approval request ID `0` and decline/continue, authoritative final replacement, exact native interrupt, terminal-versus-idle, process death, and explicit resume with durable transcript keys/content and no prompt replay. This is application/production-ingress evidence, **not an actual-model canary**.

Reproduce the application vertical:

```sh
npm run test:unit -- tests/session-codex-http.test.ts
```

The test creates only scratch metadata/native-peer files and an owned loopback server. Its child environment is allowlisted and never inherits live credentials, agent homes or UI state. Host execution guards and live observation timestamps are not durable native replay guarantees. Historical timestamp presentation remains adapter-owned review work; the recovery assertion requires native IDs, ordered content, tool results, and error state to survive.

Full `npm test`, integrated native browser workflows, and actual native model/tool/approval canaries are **not replaced** by these focused results. Their reports must state exact pins, commands, results, and blockers separately before the #92 merge gate.
