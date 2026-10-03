# Owned Pi runtime slice

`LocalSessionService` admits live sessions and keeps one `PiSessionHandle` per Pi
session object. The handle owns runtime subscription release and Pi shutdown / SDK
disposal, and provides prompt, interrupt, state and message operations. State
requested during extension binding uses the same handle later admitted to the live
entry. Disposal is idempotent and preserves shutdown-hook → unsubscribe → SDK
disposal ordering, including best-effort cleanup after hook failures.

This isolates the operational slice of PR145's `SessionHandle` and
`adapters/pi/index.ts` `PiSessionHandle` draft: raw-session encapsulation,
`projectSessionState` / `projectMessages` projection, subscriptions and runtime
lifetime. It intentionally does not bring over the draft's harness registry,
execution receipts, snapshot fields, native adapter configuration or bridge sinks.
The current service's lease/correlation/event behavior remains canonical rather
than copying the draft's alternate implementations.

The host still owns web identity, prompt admission/correlation, work and viewer
leases, event mapping/decoration, bridge interactions, capture lifetime, defaults,
storage discovery and creation. Retry compatibility (including private Pi SDK
fallback), configuration, tree navigation, compaction and extension operations
remain explicitly Pi-specific in the service. Existing APIs that expose a
`PiWebSession` are unchanged. Handle events and projections still depend on Pi
and the existing DTOs: this prerequisite is not a harness-neutral service and
introduces no public wire contract.
