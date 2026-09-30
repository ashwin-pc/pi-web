# Workspace-first multitasking probe

This browser-only concept follows the desktop scene sketches. Its starting point
is the user's work across projects, rather than an agent conversation. It uses
two sample workspaces and four activities; it does not connect to the Pi Web
server, read project files, or run an agent.

## Try it

From the repository root:

```sh
python3 -m http.server 8790 --bind 127.0.0.1 --directory docs/prototypes/multitasking-shell
```

Open `http://127.0.0.1:8790`. For a portable, single-file copy:

```sh
node scripts/export-multitasking-prototype.mjs /tmp/pi-web-multitasking.html
```

The exported file can be opened directly in a browser. Local draft persistence
depends on the browser's storage policy for local files. Reset demo clears only
this concept's storage namespace. No authentication or network services are used.

## One end-to-end session

1. Resume **Pi Web / Workspace navigation**. Edit its document beside the sample
   app. There is no Chat open.
2. Choose **Ask agent**, request a review, then close the agent surface. A simulated
   read-only job keeps running and finishes after about 45 seconds.
3. Switch to **Prepare the release** and edit its checklist.
4. Use **Switch work** or Ctrl/Cmd K to open **Trail Notes / Explore usage**. Select
   the seven-day dashboard and write an observation. The other activity's agent
   does not redirect this context.
5. Visit **Plan the next release**, then return to the earlier activities. Drafts,
   selected resources, filters, editor positions, and board choices are retained.
6. From the release activity, use **Keep beside** in the switcher to display Trail
   Notes alongside Pi Web. Each pane names its workspace and activity.
7. Open **Updates** when the review is ready. The update names its originating
   workspace and activity. Choose **Go to activity and review** to open the report
   while retaining the other workspace beside it. Chat can remain closed.

On a phone or tablet, the context button opens the same grouped switcher, with one
primary resource visible at a time. A desktop companion is retained in local state
when the viewport shrinks, but hidden until the viewport has room for it again.

## Model under test

- **Workspace** owns resources and is the boundary for read/write routing.
- **Activity** groups resource references and optional agent sessions for a piece
  of work. It exists before and after a Chat view.
- **Scene** is this window's arrangement and focus within an activity. Positions,
  filters, and open views are local preferences rather than durable task facts.
- **Surface** presents a resource or an optional session. Closing a surface does
  not delete an activity or cancel its jobs.

Documents are keyed by `(workspaceId, path)`, not by filename or active activity.
Activities in the same workspace share a document buffer. Agent requests capture
their activity, workspace, and referenced resource snapshots at submission. A result
becomes available in its owner's activity without opening a surface or stealing
editor focus. Current context lives in the window's URL; another tab's updates do
not select a different project in this window.

If two tabs edit one document, an active divergent draft is kept with an explicit
choice of which draft to use. This is a demonstration of the ownership problem,
not a production document synchronization or revision protocol. Simultaneous
localStorage writers can still race, as can mock job-list updates. Shared folders
and Git branches are also shared across activities: activity grouping does not
provide filesystem isolation.

## Validation and boundaries

```sh
node scripts/check-multitasking-prototype.mjs /tmp/pi-web-multitasking-check
```

The Playwright check runs its own temporary local server and verifies workspace
and activity routing, same-name resource isolation, drafts/cursors/filters,
side-by-side contexts, background completion without focus changes, optional
Chat, browser history/reload, independent windows, conflicting drafts, and
mobile/tablet resource selection and 44px controls. It saves four screenshots.

The code uses sample resource IDs and browser storage, not the production
ResourceRef DTO or a durable Activity API. The agent timer and report are mock
data. `window.piWebDemo` provides a small deterministic recording/check driver.
This is a design probe for the multitasking contract; it does not satisfy P4's
second-harness test or P6's durable Activity checkpoint. The main checkpoint
journal describes the remaining server and extension ownership changes.
