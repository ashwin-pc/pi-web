# Pi Web: work, open tabs and floating Pi

This standalone interactive concept has two sample projects and five pieces of
work. **Coordinate the release** combines Pi Web's checklist with Trail Notes'
roadmap. Files and apps are available before starting a conversation. A floating
Pi chat can open them, inspect a preview, answer from planner data, and edit a
sample draft. Files, pages, the app connection and the agent are explicitly demos;
there is no Pi Web server, live MCP connection, LLM or real filesystem write here.

## Try it

From the repository root:

```sh
python3 -m http.server 8790 --bind 127.0.0.1 --directory docs/prototypes/multitasking-shell
```

Open `http://127.0.0.1:8790/?work=coordinate-release`. For a portable HTML with
embedded styles, script and mascot:

```sh
node scripts/export-multitasking-prototype.mjs /tmp/pi-web-workspace.html
```

Local-file persistence depends on the browser's storage policy. Reset demo clears
only `pi-web.multitasking-probe.v3/`; earlier v1/v2 drafts are left intact without
silent migration or deletion. No authentication or external requests are needed.

## One end-to-end flow

1. Add a note to the release checklist. Choose **Ask Pi**, then send:

   > Open the Pi Web preview in a browser and the release planner. Compare them
   > and tell me what is missing for the launch.

   Pi reads the planner and inspects the sample page's actual rendered DOM. It
   opens Browser and Release planner beside each other on desktop. The checklist
   remains in its bottom tab. The answer reports the missing compact map check
   and the preview's three 44px controls.
2. In the planner, mark the compact map ready and ask what is still missing.
   Pi's next answer reflects the changed app data. Mark it missing again to
   explore the edit flow.
3. Send:

   > Add the missing check to the Pi Web checklist, keep the planner pinned,
   > and close the browser.

   Pi appends the check to the Pi Web draft, preserving your note and leaving
   Trail Notes' roadmap unchanged. The checklist and planner become visible;
   Browser closes. **Save in Pi Web** commits only the sample browser-local draft.
4. Minimize Pi and continue working. Reopen Pi and **Restore my previous view**
   to restore the earlier arrangement without undoing the document edit. Pinned
   tabs survive agent cleanup; a user's × can close them. Pi can also explicitly
   unpin and close an app when asked.
5. Start another check and switch to **Explore usage** in Work. Its dashboard
   and filter stay in place when Pi finishes. **Updates** lets you return to the
   original work and answer. If you begin editing instead, Pi's suggested tabs
   wait behind **Show**, preserving the editor's focus, selection and draft.

The sample agent is a bounded deterministic prompt router. It supports these
opening/comparison/checklist operations and simple close/unpin/show-only requests;
unsupported questions explain the available demo rather than inventing results.
The planner and page observations are read at run time, not baked into the video.

## What the controls mean

- **Work** is the single drawer for choosing what to work on across projects.
  A row is a goal with its own tabs and optional chat. No separate activity rail,
  bottom activity shelf, scene menu or resource vocabulary is exposed.
- **Bottom tabs** switch among the actual files, apps and pages open in that work.
  Pin protects an item from agent cleanup. Open and the mascot launcher lead to
  concrete Files, Apps and Browser choices. Closing a tab retains its reference
  in the work; reopening uses the same file buffer.
- **Pi** is a floating chat with Pi Web's message/composer styling. Minimize keeps
  a running job alive; **Stop** cancels it and prevents late edits/view commands.
  On larger desktops there is room reserved beside the current files for the
  popup. Smaller screens show it over one primary file or app.
- **Split / Single view** chooses one or two items within the current work on
  desktop. Phones/tablets retain the companion but show one item at a time. A
  goal does not require a full-screen display or an open conversation.
- **Context** discloses the execution project and selected read roots. One work
  can span several projects without merging their files or implicitly granting
  permissions. Navigation never changes the scope of an already submitted job.

## Ownership and view policy

Internally the existing Activity concept groups references around a goal without
a single workspace parent. Its user-facing label is Work. Files belong to
`(workspaceId, path)`; a connected app belongs to its connection; a browser page
belongs to its browser session. App/page identity must not require a fabricated
workspace filepath. The one tab strip can present all three kinds.

Two goals referencing a file share its draft; same-named files in different roots
stay separate, including save routing. Active divergent drafts from another tab
are kept with an explicit recovery choice. Shared roots still share their Git
checkout: activities alone do not isolate writes or create atomic multi-root
transactions. References are pointers, not permissions.

Jobs capture work ID, execution workspace, selected read roots, original document
revision/draft, originating window and submitted view revision. The worker can
automatically arrange tabs only while that work is still current, its view has
not changed, and no document is being edited or composed with an IME. Otherwise
the command remains available through Show or Updates. A changed or active draft
gets a proposed addition; **Add to my current draft** appends against the latest
buffer. It never replaces newer text with the submitted snapshot.

Results and progress are shared mock data. Applying or restoring a view has a
per-window receipt: another window receives the answer without inheriting its
neighbor's navigation. Layout, cursor/scroll and filters live in an in-memory
scene with browser-local reload defaults, not a durable Activity record. URLs use
`?work=coordinate-release&tab=pi-release-doc&beside=release-planner&chat=1`.
Unattached/unknown tabs are rejected rather than attached by a URL. Earlier
`activity`/`resource` query aliases are accepted where applicable. Added references
are local to this browser, so a URL alone cannot reconstruct them elsewhere.

## MCP app and browser boundary

Release planner runs in an opaque-origin `sandbox="allow-scripts"` iframe. Its
narrow demo JSON-RPC bridge supports `ui/initialize`, `tools/call` and
`ui/notifications/tool-result`; it advertises `protocolVersion: "demo"`. This is
an MCP-style hosting experiment, **not** a complete MCP Apps transport or a live
server. The app and agent call the same local `get_launch_plan` backend. The app
can also call the allowlisted `set_launch_status`; arbitrary file tools are denied.
The host validates frame identity and filters planner records to that work's
roots. Agent reads use the narrower roots selected in Context. Context selection
does not change what the already-open app displays.

Browser has an address bar and two `.example` pages. The agent inspects the same
sample document generator in a separate sandbox at a 393px viewport, independent
of whether its visible tab is open. Inspection results are checked against frame
identity, job nonce and page ID. The app cannot access the parent DOM; a browser
frame cannot impersonate the app bridge. Host CSP blocks network, external
assets, forms and base URL changes in these guests.

A production MCP binding still needs discovery, protocol negotiation, connection
permissions, teardown and real tool/result routing. A real browser needs an
isolated browser service or suitable WebView plus navigation/session controls;
arbitrary websites often forbid iframe embedding. A browser tab's display lifetime
and an agent's browser runtime lifetime also need separate policies. This probe
does not imply that an iframe is a general-purpose browser implementation.

## Pi Web design sources

The mock uses the default black/charcoal/gold palette and typography from
`src/styles/base.css`, session drawer rows and bottom tab idioms from
`sessions.css`, message styling from `messages.css`, composer
styling from `composerFrame.css`, and the mascot fan from `actionLauncher.css`.
Lucide icons use the existing MIT-licensed dependency. `mascot.png` copies
`public/pi-mascot-avatar.png` for the standalone/exported version. These are style
snapshots rather than shared production components; live theme/density preferences
do not propagate into the mock.

## Validation and remaining limits

```sh
node scripts/check-multitasking-prototype.mjs /tmp/pi-web-multitasking-check
npm run build
```

The check starts a temporary local server and covers the prompt-to-browser/app
flow, actual DOM inspection, interactive app data affecting answers, scoped edits
and preserved notes, pin/close/restore, read-only requests, cancellation, source
and tool isolation, narrow context, same-name files, deferred commands during
editing or other work, per-window view application, conflicting drafts,
history/reload, mobile/tablet one-item presentation and 44px targets, and dense
desktop layouts. It also rejects external requests and saves screenshots.

`window.piWebDemo` supplies a deterministic check/recording driver. `setAutoFinish`
can pause completion so the recording can visibly switch work before `finishJob`.
The video is one continuous tested walkthrough with natural synthetic narration,
sentence captions and chapter markers. It is a concept demonstration.

This revision changes only the standalone probe, its check and documentation.
The fixed catalogue has no create/rename/delete work, reference removal, root
registration, permissions or multiple simultaneous agent sessions per goal.
localStorage is not transactional: concurrent drafts, job lists and defaults can
race despite visible conflict recovery. Closing a guest re-creates its frame on
return; the sample planner's backend persists, arbitrary app JS state does not.
Missing connections/roots, moved files and permission revocation need production
handling. P4's real second harness and P6's durable Activity checkpoint remain
open in the main architecture journal.
