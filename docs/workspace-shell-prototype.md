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
