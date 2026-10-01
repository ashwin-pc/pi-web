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
- Workspace owns files and Git operations. Apps and pages retain connection or
  browser-session ownership. Session owns agent/harness state.
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

### P6 — Work in the real shell (implemented on the Pi adapter)

The latest product direction asks for real multitasking before another harness
adapter is available. The UI calls the grouping **Work**: a named goal can include
several project folders, saved file/app references and multiple conversations. It
can exist without a conversation. Records and registered project roots live in an
atomic, revision-checked catalogue; `PI_WEB_WORK_STATE_FILE` overrides its location.
This changes the original P6 ordering deliberately. P4 remains open: these are real
Pi conversations, not a second harness or a claim of harness independence.

The Work drawer is the only goal switcher. Bottom tabs are the files, apps and pages
open in that goal. Files and Git occupy the main area; Pi uses the existing transcript,
composer, queue, model controls, extensions and conversations in a floating panel.
The UI shares Pi Web's colours, density, typography and icons. `?shell=chat` or the
browser preference `pi-web.shell=chat` restores the existing chat layout. Existing
session pins are kept as data; the Work layout uses its bottom bar for open items.
No standalone mock, walkthrough, recording or export script is retained.

Layout, active/companion tabs, pins, draft text and cursor positions stay in each
browser window's sessionStorage. A goal's references are durable, while closing a
tab does not delete the reference or discard an unsaved draft. New windows can open
those references with their own arrangements. File identity always includes its
project ID; two identically named files from different projects have independent
editors, versions, selections and save targets. Switching goals or projects keeps
live editors, and reload recovers dirty drafts. Cancelling a reload leaves their
DOM attached. Saved files are refreshed from disk when reopened; dirty drafts keep
their original disk revision so conflicting saves fail rather than overwrite.

Desktop supports a primary and companion view, including two files. It moves the
same editor into the companion pane rather than cloning buffers. Narrow layouts
show one view; selecting the companion tab swaps roles while keeping both editors.
Same-kind foreign apps and Git views currently share one renderer and cannot both
be shown together. Opening another such item selects it. Browser and MCP instances
keep their own ownership; they do not acquire file permissions by being in Work.

### Real browser and MCP Apps binding

`workspace_browser` uses isolated Chromium contexts, actual navigation, rendered
text, screenshots, selector clicks and typing. The browser tab displays and sends
input to that same page. Its screenshot transport is a prototype browser control,
not a complete local-browser replacement: scrolling, downloads, popup handling,
password management and accessibility mirroring are unfinished. Each context is
owned by one Work, expires after 30 idle minutes, and requires installed Chromium
(`npx playwright install chromium` or `PI_WEB_BROWSER_EXECUTABLE`). Browser runtime
IDs do not survive a server restart. Closing a tab hides it; the browser tool's
close action ends its runtime. URLs use http(s), without embedded credentials.
Proxy settings and TLS verification remain in force.
Browser and MCP transport libraries load on first use rather than adding their
initialization cost to every server start and supervised restart.

MCP connections use the SDK's Streamable HTTP transport. The Open > Apps picker
connects a real endpoint and discovers tools advertising `ui.resourceUri` (or the
legacy `ui/resourceUri`). Calling a tool passes its actual arguments and results
to the advertised HTML resource through the MCP Apps `AppBridge`. The iframe has
an opaque origin and a host CSP based on declared resource/connect domains. Tool
visibility is checked for model and app callers; app calls stay within their own
connection. Links open in the real browser. Hidden or background apps cannot initiate
host tool calls. Generated saved HTML retains its separate, network-free sandbox;
trusted Pi extension panels retain their existing host-DOM trust boundary.

Connections persist independently of app frames. API `headersEnv` maps header names
to environment variable names; secret values are neither returned nor saved. The
initial binding does not implement OAuth discovery, stdio transports, disconnect
management, file uploads, app permissions or arbitrary resource proxying. Only the
advertised app resource can be read through its bridge. Third-party endpoints and
Chromium need the deployment's ordinary network and certificate configuration.
Manual app launch currently accepts tool arguments as JSON. The agent can supply
those arguments through `workspace_mcp`; generating forms from tool schemas is a
follow-up for the direct-launch UI.

### Agent requests, foreground policy and draft changes

Real Pi sessions register `workspace_view`, `workspace_draft`, `workspace_browser`
and `workspace_mcp`. A prompt captures its Work, submitting browser client, local
arrangement revision, selected projects and bounded open drafts. A running
conversation retains that origin; another goal or browser cannot retarget its
queued run. The agent can list project paths, request files/diffs/apps, call connected
MCP tools or use the real browser. A view request acknowledges a request, not that
the user has already seen it.

Only the submitting, visible window applies a view while that goal and revision
remain current and the user is not editing or composing. Background goals, other
windows, changed arrangements and typing defer requests to Updates > Show. Commands
are applied in order, pins protect tabs from agent closure, and Restore my previous
view restores the arrangement before the first agent change. View events omit the
captured draft contents. Abort cancels later view/draft requests; native tools also
check the run's abort signal after long browser/MCP calls.

Draft tools read the prompt's exact open-buffer snapshots and propose append/replace
changes. Automatic application requires the captured buffer version. A later user
edit keeps the proposal for review. Explicit append preserves the current draft;
replacement of a changed draft requires manual merging. Saving remains explicit
and uses the original project and disk revision. Context is bounded to eight small
open drafts (7,000 characters each); large files remain disk references. This scope
controls the new workspace tools, not filesystem authorization for Pi's existing
native tools or the capabilities of a connected MCP server.

The catalogue is durable; view/draft requests and MCP results are runtime records.
They survive websocket reconnection within the same server process, with local
receipts preventing repeated application. Restarting the server loses pending
requests and browser contexts. A full harness adapter, durable run journal and
conflict-aware document collaboration remain separate work.

### Validation of the real implementation

Automated checks cover catalogue restart and lost updates, root-scoped identities,
immutable run origins, cancellation, snapshot draft proposals, native Pi tool
execution, real Chromium interaction, and HTTP MCP discovery/resource/tool/result
flow with caller and connection restrictions. Browser tests use isolated real
project folders and the product UI across phone, tablet and desktop. They verify
multi-project drafts, explicit saves, goal switching/reload, split ownership, mobile
role swaps, floating Pi context and deferred/pinned view requests. Existing chat
regressions run with the compatibility layout selected explicitly.
Native tool tests execute the registered definitions with a Pi extension context;
the browser UI tests use deterministic session events rather than a paid model run.

Final checkpoint validation: `npm run build` and `npm run typecheck` pass. The full
sharded `npm test` run passes 548 unit tests and 1,000 browser tests across phone,
tablet, desktop and authenticated servers, with 67 platform/capability skips and
no retries. Standalone prototype files, export/check scripts, recordings, narration
and temporary scene helpers have been removed.

Additional edge cases: revision checks serialize mutations within one server;
sharing the same catalogue between several server processes is unsupported. A
running conversation keeps the initial read scope and draft snapshots for queued
prompts; send an idle prompt or use another conversation for a fresh capture.
Session deep links open floating Pi in their owning Work, and late file responses
cannot replace a newer goal or file selection. Editing project membership removes
associations and filters old tabs while preserving files, drafts and conversations.
The catalogue still stores opaque Pi session IDs; membership validation resolves
their project from live/saved metadata without loading an agent runtime. Editing a
Work prunes its deleted conversations and their extension-app references; new
unknown conversations and conversations from excluded projects are rejected. A
lightweight harness descriptor is part of the remaining P4 adapter work.

Authentication discovery: the initial state fetch can finish by presenting a token
overlay. Starting Work from that promise incorrectly treated this as a successful
sign-in and did not retry after entering a token. Work now starts only after an
authenticated state snapshot, with an idempotent guard for conversation refreshes.
The first-sign-in regression checks incorrect and correct tokens, mobile chat,
project context and the desktop layout. The existing FAB also measured labels with
a different font from its buttons; it now uses the computed button font so width
ordering stays consistent.

Recording discovery: goal rows replaced the shared button class instead of adding
their row class. This dropped the flex layout and ran the goal, project and status
labels together. Rows now retain both classes so their labels stack and the shared
button sizing, focus and hover styles apply.
