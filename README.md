# pi-web

**The best interface for working with your agents.**

[Website](https://ashwin-pc.github.io/pi-web/) · [Getting started](https://ashwin-pc.github.io/pi-web/getting-started/) · [Extensions](https://ashwin-pc.github.io/pi-web/extensions/)

pi-web is a focused browser workspace for substantial, inspectable agent work across mobile, desktop, and tablet. [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is its current default and full-capability reference harness; the architecture is being designed to support additional harnesses without reducing what pi can do.

It keeps the surrounding work visible—sessions, rich artifacts, files, diagrams, tool output, diffs, and extension-built workflow UI—without trying to become a full IDE.

| Desktop | Mobile |
| --- | --- |
| ![pi-web desktop showcase](tests/e2e/visual.spec.ts-snapshots/hero-showcase-desktop.png) | ![pi-web mobile showcase](tests/e2e/visual.spec.ts-snapshots/hero-showcase-mobile.png) |

## Why pi-web?

- Every-device UI: a responsive experience for phone, tablet, and desktop browsers
- Minimal by design: a focused agent UI, not a full IDE replacement
- Self-aware: pi-web injects web UI context so sessions understand artifacts, images, restarts, and browser-specific behavior
- Code-review friendly: inspect tool output, edits, Git status, commits, and diffs
- Session-oriented: organize ongoing work with reorderable pinned tabs, drawers, colors, filters, metadata, and conversation navigation
- Rich output: preview artifacts and open Mermaid diagrams in a full-screen viewer

## What changed in 0.6.0?

0.6.0 adds native browser login and Security management, including password and passkey enrollment, revocable browser sessions, device handoff, and named API tokens. New installations default to authenticated access and print a single-use setup link; existing authentication policy is not changed automatically.

Trusted server-side extensions can now request short-lived, route- and session-scoped HTTP clients from core. The bundled session orchestrator uses this facility instead of a legacy browser token, so password/passkey-only deployments can spawn, monitor, steer, and interrupt visible worker sessions.

The workspace also gains Minimal transcript density, prompt provenance and session details, customizable buckets, worker grouping, persistent notes, mark-unread actions, inline audio previews, and authenticated artifact downloads.

See the [0.6.0 release notes](docs/releases/0.6.0.md), [authentication guide](docs/passkey-auth.md), and [scoped extension HTTP guide](docs/extension-http.md) for details.

## Install

Requires Node.js 24 or newer. pi-web currently uses [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) as its agent harness; pi-web 0.6.0 bundles Pi 0.84.1, so a separate global Pi install is not required.

Install and run pi-web from npm:

```bash
npm i -g @ashwin-pc/pi-web
pi-web
```

Or run pi-web without a global install:

```bash
npx -y @ashwin-pc/pi-web@latest
```

From a GitHub release asset:

```bash
# Download ashwin-pc-pi-web-<version>.tgz from the release page, then:
npm install -g ./ashwin-pc-pi-web-*.tgz
pi-web
```

`pi-web` starts on `http://127.0.0.1:8787` and runs Pi in the directory where you invoke it; override that workspace with `PI_WEB_CWD=/path/to/project pi-web`. On a genuinely unconfigured installation, the terminal prints a single-use, ten-minute setup URL for enrolling a browser password or passkey.

Provider credentials and pi-web login serve different purposes. Configure model-provider credentials locally through Pi. For interactive provider login, install and launch the Pi terminal CLI:

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Run `/login` inside that terminal CLI, complete provider authentication, then exit Pi. pi-web uses the same local provider credentials. Separately, use pi-web's browser sign-in and **Settings → Security** to control access to the web application. See [authentication and recovery](docs/passkey-auth.md) for browser setup, migration, and recovery.

## Run locally with Vite HMR

Clone the repository and install its dependencies first:

```bash
git clone https://github.com/ashwin-pc/pi-web.git
cd pi-web
npm install
npm run dev
```

This starts a stable TypeScript supervisor on `8787` and a restartable child server on `8788`. The public URL still serves:

- Vite frontend with HMR
- Pi API routes under `/api/*`
- Pi WebSocket at `/ws`

The supervisor also exposes:

- `POST /api/restart` - restart the child server safely
- `GET /__supervisor/status` - inspect child PID/generation

Open:

```text
http://127.0.0.1:8787
```

Edit files under `src/` and Vite will update the UI live. If the agent edits `server.ts`, call `POST /api/restart` instead of killing the public server; the supervisor stays alive and the browser reconnects.

By default, Pi operates in the directory where you start this server. To point Pi at another project:

```bash
PI_WEB_CWD=/Users/ashwin/projects/comfy-lan-webapp npm run dev
```

## Core features

### Mobile-first sessions

The session UI is built for small screens first, then scales up to desktop. Session lanes keep active work **Pinned**, paused work **Parked**, and useful references in **Bookmarks**. The dedicated lane drawer supports notes, bucket markers, stale parked-session badges, and drag-and-drop ordering within or across lanes, while pinned sessions remain immediately available in the tab bar.

Right-click a session—or long-press it on touch devices—to open the Inspector Card and change its lane, bucket, or optional note. Keyboard shortcuts cover pinning (`Ctrl/Cmd+Shift+P`), parking (`Ctrl/Cmd+Shift+K`), bookmarking (`Ctrl/Cmd+Shift+B`), and cycling through the focused lane (`Ctrl/Cmd+Shift+←/→`).

### Workspace Explorer

The responsive Explorer opens the active session's working directory as a lazy-loaded file tree and a full CodeMirror editor. A dedicated Artifacts scope presents generated project output as a visual gallery, with large interactive previews for images, sandboxed HTML, rendered Markdown, video, and PDFs—without digging through Pi's internal storage folders. Workspace and Artifacts each preserve their folder, scroll, and preview state when switching views or reopening the panel. Browser Back returns an open file or artifact to its prior tree or gallery before closing the panel on the next step. The Explorer supports syntax highlighting, multiple closeable tabs, conflict-aware saves, search and editor shortcuts, line wrapping, pinch or slider font resizing, and a resizable or collapsible tree. Desktop keeps chat, tree, and editor visible together; phones and touch-first foldables switch cleanly between the tree and editor without summoning the keyboard until the editor is tapped.

File access stays scoped to the session working directory. The server rejects path traversal and escaping symlinks, detects binary and oversized files, writes atomically, and uses revisions to prevent silently overwriting changes made elsewhere.

### Diffs and tool review

A shared diff viewer supports side-by-side or stacked layouts with intraline highlighting. It is used by both edit tool cards and Git diffs, so code review feels consistent across agent changes and repository history.

### Git status, graph, and commit diffs

The Git button in the header opens a responsive Git panel for repo status, commit history, per-file diffs, per-commit diffs, and sync with `fetch` + rebase pull.

### Self-aware pi context

`contexts/web-ui.md` is injected into agent sessions so pi understands pi-web behavior such as artifact links, image rendering, and supervised restarts. Bundled pi extensions add pi-web defaults, including automatic session naming from the first prompt.

### pi-web extensions

pi-web supports browser-specific extensions in `.pi/web/extensions` and `~/.pi/web/extensions`. These use pi's extension runtime and a typed contribution API for footers, actions, panels, settings, artifact previews, and Git tabs.

Trusted server-side extensions can also use core-managed, short-lived HTTP clients whose routes and session targets are checked by pi-web. These capabilities reduce credential exposure but do not sandbox installed extension code. See [pi-web extensions](docs/pi-web-extensions.md) and [scoped extension HTTP](docs/extension-http.md), including the bundled [multi-agent session orchestrator](examples/pi-web-extensions/session-orchestrator.ts).

## Screenshots

The README references the same deterministic Playwright visual snapshots used by `tests/e2e/visual.spec.ts`. Desktop and mobile captures are shown side by side, and when visual snapshots are intentionally updated, these images update with them.

### New session

New sessions open with a lightweight animated empty state and a compact working-directory control. The visual baseline waits for the animation’s settled final frame so screenshot comparisons stay deterministic.

| Desktop | Mobile |
| --- | --- |
| ![pi-web new session desktop](tests/e2e/visual.spec.ts-snapshots/new-session-desktop.png) | ![pi-web new session mobile](tests/e2e/visual.spec.ts-snapshots/new-session-mobile.png) |

### Workspace Explorer

The Explorer uses the same session-scoped file tree and CodeMirror editor on every device. Desktop keeps the conversation and workspace side by side, while mobile switches to a focused editor view with a compact back control and touch-safe keyboard behavior.

| Desktop | Mobile |
| --- | --- |
| ![pi-web Workspace Explorer desktop](tests/e2e/visual.spec.ts-snapshots/workspace-explorer-desktop.png) | ![pi-web Workspace Explorer mobile](tests/e2e/visual.spec.ts-snapshots/workspace-explorer-mobile.png) |

### Diff review

| Desktop | Mobile |
| --- | --- |
| ![pi-web diff review desktop](tests/e2e/visual.spec.ts-snapshots/diff-review-desktop.png) | ![pi-web diff review mobile](tests/e2e/visual.spec.ts-snapshots/diff-review-mobile.png) |

### Session lanes

Pinned, Parked, and Bookmarks form a persistent session workspace. The same lane manager becomes a desktop drawer or mobile bottom sheet, with flat session rows, optional notes, bucket markers, timestamps, drag handles, and quick access to the Inspector Card.

| Desktop | Mobile |
| --- | --- |
| ![pi-web session lanes desktop](tests/e2e/visual.spec.ts-snapshots/session-lanes-desktop.png) | ![pi-web session lanes mobile](tests/e2e/visual.spec.ts-snapshots/session-lanes-mobile.png) |

### Git panel

Desktop uses a split master/detail layout; mobile switches between status, graph, diff, and commit detail views.

| Desktop | Mobile |
| --- | --- |
| ![pi-web Git commit diff viewer desktop](tests/e2e/visual.spec.ts-snapshots/git-diff-viewer-desktop.png) | ![pi-web Git commit diff viewer mobile](tests/e2e/visual.spec.ts-snapshots/git-diff-viewer-mobile.png) |

### Conversation tree

Navigate even elaborate, nested pi session branches with a compact tree drawer. Alternate paths stay grouped beside their fork, globally packed graph lanes keep nested branch fans from colliding, and the highlighted current path remains easy to follow. The default view keeps tool noise hidden, while the full session structure remains available from the filter.

| Nested branches · Desktop | Nested branches · Mobile |
| --- | --- |
| ![pi-web conversation tree desktop](tests/e2e/visual.spec.ts-snapshots/conversation-tree-desktop.png) | ![pi-web conversation tree mobile](tests/e2e/visual.spec.ts-snapshots/conversation-tree-mobile.png) |

## Production build

```bash
npm run build
npm start
```

`npm start` serves the compiled `dist/` app and API from one process.

## Remote access

pi-web binds to localhost by default. Remote browser login—especially passkeys—needs a secure HTTPS origin. Keep the app on loopback behind a TLS-terminating reverse proxy or secure-networking proxy, set `PI_WEB_AUTH_ORIGIN` to the exact public origin, and restrict direct backend access. Keeping the application listener on loopback also supports the scoped HTTP client used by server-side extensions; a direct non-loopback-only bind does not.

For example, Tailscale Serve can provide HTTPS while Node remains localhost-only:

```bash
PI_WEB_AUTH_ORIGIN=https://your-machine.your-tailnet.ts.net \
PI_WEB_CWD=/path/to/project \
HOST=127.0.0.1 \
PORT=8787 \
pi-web
```

In another terminal:

```bash
tailscale serve --bg http://127.0.0.1:8787
```

Open the configured HTTPS origin. On a new installation, follow the single-use setup URL printed by `pi-web`; no legacy token is needed. Existing legacy installations should enroll and verify a replacement in **Settings → Security** before retiring legacy. For exact proxy-header requirements, authentication migration, recovery commands, and alternative methods, follow the [authentication guide](docs/passkey-auth.md).

## Environment variables

- `HOST` - bind host, default `127.0.0.1`
- `PORT` - bind port, default `8787`
- `PI_WEB_TOKEN` - deprecated legacy credential; removable after replacement login is verified
- `PI_WEB_AUTH_POLICY` - `authenticated` or deliberately `open`
- `PI_WEB_AUTH_METHODS` - comma-separated `passkey,password,legacy,external`; saved Settings configuration takes precedence after enrollment/configuration
- `PI_WEB_AUTH_MODE` - compatibility preset translated into the canonical policy/method defaults
- `PI_WEB_AUTH_ORIGIN` - exact public origin for login/WebAuthn/CSRF, including HTTPS and port
- `PI_WEB_AUTH_RP_ID` - WebAuthn RP ID, defaults to origin hostname
- `PI_WEB_AUTH_TRUSTED_HEADER` - verified proxy identity header; requires a restricted backend
- `PI_WEB_AUTH_STORE` - authentication database path (default `~/.pi/agent/web/auth.json`); independent dev/production instances must use different paths, otherwise policy and revocation changes are shared live
- `PI_WEB_AUTH_PROXY_PEERS` - exact socket IPs trusted to supply one strictly parsed `X-Forwarded-Host` and a sanitized single-IP `X-Forwarded-For`; the proxy must overwrite caller headers and backend access must be restricted (unset by default)
- `PI_WEB_CWD` - project directory Pi should operate in, default current directory
- `PI_WEB_NO_SESSION=1` - use in-memory sessions only
- `PI_WEB_CHILD_HOST` - supervised child bind host, default `127.0.0.1`
- `PI_WEB_CHILD_PORT` - supervised child port, default `PORT + 1` (for example `8788` when `PORT=8787`)
- `PI_WEB_RESTART_GRACE_MS` - delay between child stop/start, default `250`

## Development architecture

The app is TypeScript end-to-end:

- `supervisor.ts` is a small stable dev supervisor that owns the public port and restarts the app server safely
- `server.ts` is the restartable Pi API/WebSocket server, run directly with `tsx`
- `src/main.ts` bootstraps the modular Vite frontend with HMR; see [docs/frontend-architecture.md](docs/frontend-architecture.md)
- in dev, `server.ts` embeds Vite middleware while `supervisor.ts` proxies API, WebSocket, and HMR traffic
- `AGENTS.md` provides normal project-specific pi instructions when the target cwd is this repo

## Security

This app can drive Pi tools such as `bash`, `write`, and `edit`. Restrict network access and use authenticated access over HTTPS. Human logins share revocable browser sessions; named API tokens are separate machine credentials. See [security design, recovery, and migration](docs/passkey-auth.md).
