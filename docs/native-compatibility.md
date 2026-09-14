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

## Extraction checkpoint evidence

At the core extraction checkpoint:

- `npm run typecheck`: passed.
- `npm run build`: passed (existing large-chunk advisory only).
- Focused six files / 70 tests: passed, including shared lifecycle/identity tests and existing Pi/extension regressions.
- Full unit run before moving one context-source assertion: 579/580 passed; that assertion now points to the Pi adapter and passes in the focused run. Re-run the full suite after integration.
- Pi browser extraction check: 23/24 passed. The SDK mock no longer broadcasts browser events directly. Moving the existing stale-runtime adversary to explicit `/api/mock/event` injection exposed a delayed-stale-runtime frontend guard bug; the frontend owner is fixing it without weakening assertions.
- Native actual-model/tool canaries and full integrated native browser validation are **not established by this checkpoint**. Per-adapter native reports and the final integrated verification must state exact pins, commands, outcomes, and limitations separately.

This is a local implementation checkpoint, not the #92 merge gate. Keep this evidence updated as actual adapters and frontend changes integrate.
