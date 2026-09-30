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
