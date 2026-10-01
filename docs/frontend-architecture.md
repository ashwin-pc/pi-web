# Frontend architecture

The frontend is intentionally plain TypeScript on top of Vite. It is organized as small feature controllers instead of a framework component tree.

## Entry point

`src/main.ts` should stay a composition/bootstrap file. It is responsible for:

1. importing global CSS;
2. creating shared objects (`elements`, `state`, `api`);
3. constructing feature controllers;
4. wiring cross-controller callbacks; and
5. starting the initial state refresh and WebSocket connection.

Avoid adding feature logic directly to `main.ts`. If a change needs more than a small wiring callback, put it in the feature module that owns the behavior.

## Shared app objects

- `src/app/elements.ts` - all required DOM lookups and viewport-height syncing.
- `src/app/types.ts` - shared frontend state and API/event types.
- `src/app/api.ts` - auth headers and WebSocket URL construction.
- `src/app/icons.ts` - shared Lucide icon helpers.

Feature modules receive the pieces they need explicitly. Prefer passing `state`, `elements`, `api`, and callbacks over importing another feature module's internals.

## Feature modules

- `src/composer/composer.ts` - prompt form, slash commands, image attachments, queue mode, stop/send buttons, token form, editor expansion.
- `src/messages/messageList.ts` - chat message rendering, streaming assistant deltas, message history refresh.
- `src/messages/content.ts` - raw Pi message content parsing helpers.
- `src/markdown/render.ts` - Markdown sanitizing, syntax highlighting, lazy rendering, copy buttons.
- `src/components/imageActions.ts` - image fullscreen/download/open controls used by messages and Markdown.
- `src/tools/toolCards.ts` - running and historical tool cards.
- `src/models/modelSettings.ts` - model/reasoning popover and model selection API calls.
- `src/status/statusBar.ts` - session title/path display, title rename flow, WebSocket connection status UI.
- `src/sessions/sessionDrawer.ts` - sessions drawer, cwd grouping, new/open session flows, folder picker, empty-cwd chooser.
- `src/realtime/realtime.ts` - WebSocket lifecycle and Pi event dispatch.
- `src/git/*` - Git panel API, state, and views.

## State and data flow

`AppState` in `src/app/types.ts` contains the shared mutable UI state. Controllers update it directly when they own the relevant interaction, then call the smallest UI update function needed.

Common shared callbacks are defined in `main.ts`:

- `updateMeta(data)` updates model/session/cwd metadata and delegates summary/status rendering.
- `refreshMessages()` reloads history and asks the tool-card controller to clear active cards.
- `refreshState()` reloads server state, model metadata, messages, and the session title.

When adding a new feature, keep ownership clear:

- rendering for a UI area should live with that area's controller;
- server calls should live in the controller that owns the user interaction;
- cross-feature updates should go through narrow callbacks passed from `main.ts`.

## Testing expectations

After TypeScript or frontend behavior changes, run:

```bash
npm run typecheck
npm run build
```

For behavior changes, also run the relevant tests or the full suite:

```bash
npm run test:unit
npm run test:e2e
# or
npm test
# Concurrent worktrees: offset all E2E matrix ports to avoid collisions.
PI_WEB_E2E_PORT_OFFSET=12000 npm test
```
