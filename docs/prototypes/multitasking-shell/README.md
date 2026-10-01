# Universal workspace multitasking probe

This browser-only concept starts with the user's work, across projects, with Chat
available when needed. It has two sample workspaces and five activities, including
**Coordinate the release**, which combines resources from Pi Web and Trail Notes.
It does not connect to the Pi Web server, read project files, or run an agent.

## Try it

From the repository root:

```sh
python3 -m http.server 8790 --bind 127.0.0.1 --directory docs/prototypes/multitasking-shell
```

Open `http://127.0.0.1:8790`. For a portable copy with embedded styles, script and
mascot, which can be opened directly in a browser:

```sh
node scripts/export-multitasking-prototype.mjs /tmp/pi-web-activities.html
```

Local draft persistence depends on the browser's storage policy for local files.
No authentication or network services are used. Reset demo clears only the current
`pi-web.multitasking-probe.v2/` namespace. The earlier v1 drafts are left intact:
they are not silently reinterpreted as the new activity model or deleted.

## Three changes to explore

1. Resume **Coordinate the release**. The Pi Web checklist and Trail Notes roadmap
   share one activity. Each resource names its workspace in its header and save
   footer. Workspace buttons are filters into the activity catalogue; the shared
   activity appears under either workspace as the same record. The global switcher
   lists it once under **Across workspaces**.
2. In **Workspace navigation**, choose **Resources** and add **Analysis notes**
   from Trail Notes. Adding that reference extends the activity across projects.
   Existing drafts stay in their original workspaces. Closing a resource closes
   its view; its reference remains attached to the activity.
3. Choose the activity details icon to dock a summary beside the current resource.
   **Keep compact** leaves a pill on the bottom shelf. Inspect another activity
   from the sidebar without navigating away from the current resource. Click a
   resource in a card to focus it; **Show related resources** expands the arrangement
   again. Drafts, cursors, filters and previously open resources are retained.

An activity is a goal and its context, not a screen-size requirement. Expanded
resource groups, a docked summary and compact pills are presentations of the same
activity. On phones and tablets, the card is a bottom sheet over one primary
resource. A desktop companion or dock is retained when the viewport shrinks and
shown again when there is room; the activity card remains accessible from the
shelf. Focusing one resource also retains an existing companion for the expanded
arrangement, rather than deleting it.

**Ask agent** opens an optional session. Choose **Run in** and the **Read-only
context** workspace checkboxes before starting a simulated review. At least one
read scope is required. The run target can differ from the selected read scope.
Close Chat and continue elsewhere. A result adds a ready badge and becomes
available in its activity; it opens only when explicitly selected. The prototype's
review is read-only sample data and never writes files.

## Model under test

- **Workspace** owns resource identity and is the target for file/Git operations.
- **Activity** groups resources and optional agent sessions around a goal. It has
  workspace references, without a single workspace parent. This probe combines
  initial references with roots inferred from attached resources.
- **Resource** retains its workspace and path when referenced by several activities.
  An agent session belongs to its activity; its execution workspace is chosen
  explicitly. A report retains its submitted job's execution and read scopes.
- **Scene** describes this window's resource arrangement, cursor/scroll positions,
  filters and focus. Compact/docked/expanded presentations are local preferences.
- **Surface** presents one resource or session. Closing it neither deletes the
  activity nor stops its jobs.

Document buffers are keyed by `(workspaceId, path)`. Two activities referencing
one file share its buffer; two `README.md` files in different roots stay distinct,
including when opened within one activity. A reference is neither a copy of the
file nor an access grant. Production permissions must still be checked per root
and resource. A multiworkspace goal does not imply a combined filesystem or an
atomic transaction across roots.

Jobs capture `activityId`, `executionWorkspaceId`, selected `workspaceIds` for
read context, and owner-qualified resource snapshots at submission. Future view
switches and attached references do not retarget an existing job. A background
completion updates availability and status, preserving the foreground document,
selection and URL. Windows share mock job progress without inheriting each other's
selected activity.

The URL can address `?activity=coordinate-release` without a workspace selector.
An optional `workspace` is a catalogue filter and must include that activity.
`view=resource&resource=…&card=…` restores a resource and docked card; `beside`
retains a second activity. An unknown or unattached resource is rejected rather
than being attached implicitly by a URL. References are browser-local, so another
browser cannot recover additions from the URL alone. History remains per window;
last-workspace activity and compact shelf preferences are browser-local defaults.

If two tabs edit one document, an active divergent draft is kept with a visible
choice of which draft to use. This is a demonstration of the ownership problem,
not a production synchronization protocol. Concurrent localStorage writers can
still race, as can mock job-list updates. Activities sharing a root also share
its checkout; isolated writes require worktrees or explicit write coordination.
The current catalogue has fixed sample goals: create/rename/delete activity,
detach resources, root registration, workspace permissions and multiple parallel
agent sessions per goal remain outside this probe.

## Pi Web design sources

The shell uses the default tokens, typography and background from
`src/styles/base.css`, neutral drawer rows from `sessions.css`, compact gold worker
pills from `activeWorkerDock.css`, and the mascot fan launcher from
`actionLauncher.css`. Lucide icons come from the existing MIT-licensed dependency.
`mascot.png` is a copy of `public/pi-mascot-avatar.png`, included to keep this
standalone directory and its exported HTML self-contained. These styles are a
snapshot of the default theme; changing Pi Web's live theme or density preference
does not automatically change this separate mock.

## Validation and boundaries

```sh
node scripts/check-multitasking-prototype.mjs /tmp/pi-web-multitasking-check
npm run build
```

The Playwright check serves its own temporary local server. It verifies shared
activity deduplication, cross-root attachment and save routing, same-name file
isolation within one activity, execution/read target selection, immutable job
snapshots, expanded/docked/compact presentations, inspecting without navigation,
background completion without focus changes, optional Chat, history/reload,
drafts/cursors/filters, independent windows, conflicting drafts, dense desktop,
mobile/tablet single-resource views, bottom sheets, and 44px controls. It saves
screenshots of the overview, cross-root resources, dock, compact view and mobile.

Resource IDs and persistence here are sample data, not the production ResourceRef
DTO or a durable Activity API. `window.piWebDemo` provides a small deterministic
recording/check driver. This concept does not satisfy P4's real second-harness
test or P6's durable Activity checkpoint. The main checkpoint journal describes
those remaining runtime changes.
