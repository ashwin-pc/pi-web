# Workspace shell prototype

This branch is an intentionally disposable architecture probe for making pi-web
workspace-first rather than session-first.

## Questions this prototype should answer

1. Can files, Git, artifacts, and future apps be addressed without an agent session?
2. Can Chat become a peer surface without regressing the mobile-first experience?
3. What is the smallest useful resource reference shared by direct manipulation and agents?
4. Does "surface" need a durable model, or is navigation state enough?
5. Which state is device-local (layout/focus) versus durable (workspace/activity)?
6. Which current APIs are accidentally Pi-harness-specific?
7. Can a second harness inhabit the same workspace without leaking harness semantics into the shell?
8. Can an MCP or generated UI be hosted as a peer surface without inventing a second extension runtime?

## Prototype rules

- Preserve the current mobile behavior. One primary surface on narrow screens is the baseline.
- Do not build a traditional window manager. Layout is a shell policy over surfaces.
- Do not build a large App SDK up front. Extract abstractions from Files, Git, and Chat.
- Workspace owns resources. Session owns agent/harness state.
- Prefer compatibility aliases while migrating existing session-scoped APIs.
- Optimize for discovering edge cases, not for preserving this branch as production architecture.

## Planned checkpoints

### P0 — Workspace identity

Expose a session-independent workspace descriptor and allow workspace IDs on file
and Git requests. Keep existing sessionId requests working.

Exit test: Files/Git APIs can be called using only workspaceId.

### P1 — Workspace-first shell

Make Chat, Files, and Git peer destinations. The active destination is URL/history
addressable. Mobile shows one primary destination; larger layouts may reuse the
existing panel manager.

Exit test: launch pi-web, enter Files or Git, and navigate without sending a prompt.

### P2 — Resource references

Introduce a minimal ResourceRef and a generic open-resource path. Files and Git
are the first handlers.

Exit test: a file/diff opened from chat and one opened from direct navigation
converge on the same resource identity.

### P3 — Focus and Ask Agent

Publish current resource/selection from Files and Git. "Ask agent about this"
moves to Chat with a structured resource context.

Exit test: select a file or diff on mobile, ask about it, then return via browser
Back without losing navigation state.

### P4 — Harness pressure test

Attach one non-Pi harness through the existing harness capability boundary. Do
not normalize away harness-specific features.

Exit test: two different harness sessions can operate in one workspace while
Files/Git remain unchanged.

### P5 — Foreign app pressure test

Host one non-built-in interactive surface (prefer MCP Apps if the host subset is
small enough) and one generated HTML app.

Exit test: shell navigation treats built-in and foreign surfaces consistently,
while sandbox/trust boundaries remain explicit.

### P6 — Activity spike

Only after the above, prototype Activity as a durable grouping of task context,
resources, and agent sessions. Keep layout/focus device-local unless the
prototype demonstrates a reason to persist them.

## Expected throwaways

Names and DTO shapes in this branch are not contracts. In particular, Workspace,
App, Surface, ResourceRef, Focus, and Activity should be renamed or collapsed if
the implementation does not justify them.

## Implementation journal

### P0 — Workspace identity (implemented)

`GET /api/workspaces` exposes known local roots and a current descriptor without
requiring a session ID. An optional `sessionId` resolves its workspace without
making the descriptor session-owned. All built-in Files and Git routes now accept
`workspaceId` (the file-write route accepts it in its body). Session-only and
unqualified requests remain compatibility aliases. Unknown workspace IDs return
404; contradictory workspace/session selectors return 409 instead of silently
redirecting a write. Existing revision checks and file containment remain intact.

Discovery: `server/workspace/registry.ts` existed but had no consumers. Its IDs
are hashes of resolved absolute paths, not physical filesystem IDs: symlink aliases
can still produce distinct workspaces. The registry is process-local and rebuilt
from server/session roots; it is not an authorization boundary or a durable list.
The server still creates its default Pi session at boot. Resource requests no
longer need that session, but session-free server startup is a separate refactor.
Git's repository selector currently checks lexical containment, unlike Files'
realpath checks; this warrants a symlink containment regression test before any
less-trusted runtime is connected.

Validation: typecheck and production build pass. The workspace-only API exit test
passes against the real HTTP routes: tree/read/write, revision conflicts, Git
repos/status/log/diff, unknown IDs, traversal rejection, and the session alias.

### P1 — Workspace-first shell (implemented)

Chat, Files, and Git are persistent peer destinations in a 44px touch navigation
bar. `?surface=files` and `?surface=git` launch directly; transitions preserve
session citations and unrelated URL parameters. Reload and browser Back restore
the destination. The existing panel manager supplies overlay/split policies;
only one primary resource surface is shown on narrow screens. Settings and
session drawers remain transient panels. Built-in Files/Git requests, including
Git image diffs and file writes, use cached workspace descriptors and workspace
IDs. Extension tabs and artifact routes retain session IDs pending their own
migration. Switching agent sessions in the same cwd preserves file tabs/edits.

Discovery: panel navigation already had history state, but no URL representation.
Surface is a small optional registration property, not a durable object. The
navigation bar reserves 44px on all layouts rather than overlapping file headers
or the composer. The server still bootstraps Chat alongside resource surfaces;
this spike proves prompt-independent navigation, not lazy agent startup.

### P2–P3 — Resource references, Focus and Ask Agent (implemented)

The shared `ResourceRef` union distinguishes workspace files from working-tree
or staged diffs. Diff identity includes repository-relative root and stagedness;
selection and session IDs are deliberately absent. Parsers reject absolute,
traversing, control-character and backslash paths and normalize redundant `.`
segments. Generic resource URLs keep existing citations/query parameters. Direct
navigation, same-origin links in Chat, and `pi-web-open-resource` events use one
opener. Resource deep links restore after boot; file tabs retain editor state.

Files publishes current resource and bounded CodeMirror line selection; Git
publishes the selected diff. `pi-web-resource-focus` is device-local. Ask Agent
adds a structured resource attachment (up to 16,000 selected characters), switches
to Chat, and preserves the source history entry. Browser Back restores the same
editor or selected diff. Reopening Git now prefers the selected file instead of
unconditionally choosing the first changed file. Resource context passes through
the existing attachment codec, transcript DTO, and model prompt serialization;
submitted Chat context includes a link back through the same resource opener.

Discovery: the current composer context type was a GitHub-only alias. Extending
that small union and existing codec was sufficient; no separate context protocol
was needed. Resource references are pointers, not uploaded snapshots or read
permissions. Unsaved edits are included only if selected; an unselected file
reference points to disk. Selection is bounded context, not a durable cursor or
layout record. Historical commit diffs, binary selection, renamed-path pairs,
and agent tool-output links are not represented by this minimal union yet.

Validation: resource normalization/identity and attachment round-trip/rejection
unit tests pass; API, direct resource links, reload, mobile selection → Ask Agent
→ browser Back → submitted context → Chat resource link pass. Git selection
retention has an explicit second-file regression test.

### P4 — Harness pressure test (assessed; exit test not yet met)

The capability DTO is agent-neutral, but the implementation boundary is not.
`LocalSessionFactory.create` must return `PiWebSession`; the service always binds
the Pi web-UI bridge and assumes a Pi SessionManager, ModelRuntime, context/tree
projection, extension runner and Pi event subscription. The existing factory is
one service-wide override, not a per-session harness router. The `HarnessAdapter`
/ `AgentSessionHandle` seam in `docs/multi-harness-design.md` is a design, not code.
A Codex CLI is present in this environment, but the CLI's presence does not provide
a binding that can inhabit this service. Pretending a constrained mock is a second
harness would not meet the checkpoint.

Next concrete increment: implement the two-level adapter seam, keep Pi's native
features in its adapter, then route session creation/open by a stored harness
binding. Preserve the capability DTO and opaque event escape hatch. This spike
leaves the real two-harness exit test open; resource APIs/UI no longer depend on
which eventual adapter supplies Chat.

### P5 — Foreign app pressure test (implemented through existing extension runtime)

Trusted rendered extension panels are now URL-addressable `surface=app&app=<key>`
destinations, discoverable beside built-ins in shell navigation. They retain the
existing action/form invocation protocol and session-scoped contribution lifecycle.
The host explicitly labels them “Trusted extension”: their HTML runs in the host
DOM, so they are not an isolation boundary. An unavailable contribution does not
become an executable URL payload. Existing `#panel:` links continue to work.

A generated HTML document can be launched from Files with Run App, or with
`surface=preview&workspaceId=<id>&appPath=<workspace-relative HTML path>`. It runs
in an `allow-scripts` iframe with an opaque origin, no same-origin grant and no
host/tool bridge. A host-supplied CSP blocks network connections, external assets,
forms and base-URL changes. This intentionally supports self-contained inline
HTML/CSS/JS apps; relative assets and network-dependent apps are outside the probe.
The document is loaded through the workspace Files API, not an arbitrary URL.
Closing it destroys the frame; Back reexecutes it rather than persisting app state.
The host reads saved disk content, not unsaved editor text.

Discovery: the contribution runtime already hosts interactive foreign panels.
Reusing it plus a separate untrusted document container is enough for this probe;
a full MCP Apps transport/tool/result protocol would be a separate binding, not a
small shell abstraction. No App SDK or second trusted extension runtime was added.
Surface remains navigation state, while installed contributions belong to sessions.

Validation: trusted app form invocation, reload and Back pass on mobile/desktop.
A generated counter runs and handles clicks; attempts to access the parent document
fail, the iframe has exactly `sandbox="allow-scripts"`, and Chat → Back reopens it.
The wider suite also caught a desktop CSS specificity collision under the 44px bar;
resource panel positioning now overrides that legacy selector consistently.

### P6 — Activity spike (deferred behind P4)

Per the planned ordering (“Only after the above”), durable Activity is not added
while the second-harness ownership model remains untested. Existing session activity
summaries are transcript presentation, not a workspace task grouping. A future
Activity should reference workspace ResourceRefs and harness-bound sessions, without
persisting panel widths, active surface, editor cursors or current focus. The current
URL/history and localStorage layout policies provide no evidence those belong in a
durable Activity record.

### Containment follow-up

The P0 Git discovery above is now covered and fixed: nested repository selectors
and working-tree image previews check realpath containment as well as lexical
containment. Symlink escapes are rejected while a harmless `..valid` directory
name is accepted. Existing Git helper regression tests continue to pass. Workspace
IDs themselves are still derived from resolved path spelling; symlink aliases of
a workspace root remain a registry identity question, separate from containment.

Cross-workspace follow-up: an explicit open-resource event for another workspace
now invalidates same-name file tabs before reuse. Saves capture the source
workspace ID, and late file/image/language loads cannot repopulate a switched
workspace. A browser regression test opens `README.md` in two different roots and
asserts both displayed content and write routing remain isolated. Git's Ask Agent
button is disabled while showing a commit/extension view because the minimal
ResourceRef intentionally covers only working-tree/staged diffs.

Validation follow-up: the full matrix found an existing tablet test assuming that
session drawers remain panes above 700px. The shared responsive policy has used
overlays through 1024px, so the test now reads that policy rather than using a
second breakpoint. Resource/foreign-surface checkpoint tests pass on mobile and
desktop, including Files → Run App → Back. Screenshot baselines have been updated
for the persistent shell bar and reviewed for mobile editor and desktop Git layout.

Packaging discovery: the new browser/server shared ResourceRef module lives outside
both `src/` and `server/`. The npm package uses an explicit files allowlist, so
`shared/` must be listed or installed server builds would lose the attachment
codec dependency. `npm pack --dry-run --json --ignore-scripts` verifies that
`shared/resourceRef.ts` is included; no package was published.

## Final validation — 2026-09-30

`PI_WEB_E2E_SHARDS=3 PI_WEB_E2E_CONCURRENCY=4 npm test` passes completely:
typecheck, production Vite build, 541 unit tests, and 969 browser tests across
mobile/tablet/desktop/auth. No retries or flaky results in the final run.
`npm run build` also passes the extension declaration build. The npm package
allowlist check and Git containment regression pass. P0–P3 and the existing-runtime
P5 probe meet their implemented exit tests; P4 remains an adapter architecture gap,
and P6 remains explicitly behind it. No main merge or deployment is performed.

## Workspace-first multitasking design probe — 2026-09-30

The desktop scene variations exposed a more fundamental issue: choosing an
arrangement around a conversation still makes Chat the organizing construct.
The user works on several activities within several projects at once. The shell
must let those contexts exist, resume, and remain visible independently of agents.

The [interactive multitasking probe](prototypes/multitasking-shell/README.md) now
starts with two workspaces and four activities, with no Chat open. A workspace
rail selects projects; an activity list resumes work within a project; a grouped
Ctrl/Cmd K switcher reaches any activity or keeps one alongside another. Two
desktop contexts can belong to different workspaces. On mobile/tablet, one
resource is primary and the same grouped switcher remains available. The narrated
walkthrough follows one session across the contexts rather than presenting more
disconnected layout alternatives.

Each document buffer belongs to `(workspaceId, path)`. Activities reference
resources; an agent session is an optional resource within an activity. Every
mutation captures its source activity and workspace. The selected context is
window-local URL state, not a global current-workspace variable. Background
results update badges and become available under their original activity; opening
their report is an explicit navigation choice. Closing Chat keeps a job running.
Switching retains local drafts, cursor/scroll positions, filters, and selected
resources. None of those local scene preferences should be confused with durable
Activity content.

Architectural findings for the integrated shell:

- A project catalogue must exist without agent sessions. Current workspace
  discovery draws from Pi's cwd, known cwds, and session-service roots; it still
  needs a deliberate way to register or select a workspace before starting an
  agent. The sample catalogue in this probe supplies that missing UI context.
- Durable Activity owns resource references and optional harness bindings.
  Scene/focus/layout stay per device or window. This probe's localStorage model
  proves interactions only; P6 remains deferred behind P4.
- Session-owned extension contributions from P5 need a workspace app catalogue
  if apps are to remain available without a selected session. That ownership
  change is separate from rendering an app as a peer surface.
- Jobs need owner-qualified event/result routing. Their completion should not
  select a workspace or open a surface. Another browser window must receive
  progress without inheriting the other window's current context.
- Activities sharing one workspace also share files and a Git checkout. Parallel
  write isolation requires explicit worktrees or write coordination, not merely
  different activity IDs. A live buffer needs revision checks and conflict
  recovery. The probe demonstrates a visible choice for divergent tab drafts;
  localStorage still cannot provide atomic multiwriter transactions.
- Side-by-side activity contexts have explicit workspace headers and action
  targets. Each shows its selected resource at this density; one desktop activity
  can show several peer resources. Shrinking to mobile hides the companion
  without deleting its state or stopping background work.

Validation: `node scripts/check-multitasking-prototype.mjs` passes context ownership,
same-name file isolation, state restoration, optional Chat, independent tabs,
background completion with editor selection and focus preserved, explicit result
review, history/reload, draft conflict recovery, mobile/tablet single-resource
views, and 44px controls. The production build also passes. No production runtime
code is changed by this probe; sample resources and simulated review are labeled
in its UI and documentation. It does not claim a real second harness, durable
Activity implementation, or real filesystem writes.

## Multiworkspace activities and resource-first presentations — 2026-10-01

The user's follow-up corrected the previous catalogue assumption: an activity
must be able to span projects. The earlier workspace-scoped activity list was a
presentation convenience, not a suitable ownership model. The
[multitasking probe](prototypes/multitasking-shell/README.md) now has five goals,
including **Coordinate the release**, which references Pi Web's checklist and
Trail Notes' roadmap. An existing activity can also gain another workspace by
attaching one of its resources. There is no scalar `activity.workspaceId`.

A workspace remains the owner of a resource and the target for reads/writes.
Workspace navigation is a catalogue filter: the same shared activity appears
under either root, and the global switcher lists it once. Document identity remains
`(workspaceId, path)`, including two same-named files within one shared activity.
Closing a resource closes its surface but retains its activity reference. A goal
can span roots without copying their files or granting access to them.

An activity also does not prescribe a full-screen arrangement. The probe can
present related resources together, focus one resource with an activity card
docked beside it, or keep several activities as compact pills. Inspecting another
card keeps the primary resource in place. Expanding restores open resources and
editor positions. Mobile/tablet keep one primary resource and present activity
details as a bottom sheet. A retained desktop companion is hidden while focusing
one resource or on narrow viewports, and reappears in the expanded arrangement.
These choices belong to a local scene, not to the durable Activity record.

Agent context cannot be inferred from whichever workspace happens to be visible.
The form explicitly selects an execution workspace and read-context roots. Jobs
capture those choices and owner-qualified resource snapshots at submission. A
run may execute in one root while reading selected context from another; this
mock's review is read-only. Its report keeps the submitted scope even if resource
references later change. No completion selects a project, opens a surface or
steals a foreground document's cursor. Real multi-harness sessions will need the
same explicit binding and permission checks behind P4's adapter seam.

Design discovery: Pi Web already provides suitable primitives for this direction.
The separate mock now reuses its default black/charcoal and gold tokens, typography,
Lucide icons, neutral drawer row styling, compact worker pills and existing mascot
fan launcher. It embeds the mascot in its portable export. The styles are copied
component idioms rather than a new production design-system package, and do not
inherit live theme settings. The mock remains independent of the production UI.

Edge cases and remaining boundaries:

- A shared activity is an association graph, not a combined filesystem. Cross-root
  mutations need owner-qualified operations; multi-root commits cannot be assumed
  atomic. Multiple activities over one checkout still need write coordination or
  explicit worktrees for isolation.
- Activity references do not grant read/write permission. Production root
  registration, permission revocation, missing roots and moved files need handling
  per resource, independently of activity membership.
- The URL can address an activity without a workspace parent. A supplied workspace
  filter must include that goal; an unattached resource is rejected without
  automatically adding it. Added references remain browser-local in this probe,
  so their URLs alone cannot reconstruct them in another browser.
- Job execution/read scopes must remain captured facts, distinct from the
  activity's current root membership. An unchecked read root contributes no
  snapshots; an empty read selection disables submission.
- This revision uses the v2 demo storage namespace, preserving earlier v1 drafts
  instead of silently migrating or deleting them. It still has localStorage
  multiwriter races, fixed sample goals and one optional mock session per activity.
  Detaching a reference, editing the catalogue and durable synchronization are not
  implemented; closing a view should not be confused with those operations.

Validation: the focused browser check passes cross-workspace attachment and saves,
same-name file isolation in one activity, shared-goal deduplication, explicit
execution/read scope selection and submitted snapshots, dock/compact/expanded
restoration, history/reload, foreground focus during completion, independent tabs
and conflict recovery, dense desktop, mobile bottom sheets and one primary
resource with 44px controls. The portable export is self-contained. Production
build passes; this increment changes only the mock, its exporter/check and docs.
P4 and durable P6 remain open. No main merge or deployment is performed.
