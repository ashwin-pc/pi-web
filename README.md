# pi-web

A minimal, mobile-first local/Tailscale web UI for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

pi-web is designed to feel like the core pi agent in a browser: small, direct, self-aware about its environment, and focused on helping you work with code rather than becoming a heavyweight IDE. It runs locally, works comfortably from a phone over Tailscale, and gives pi the web-specific context it needs to render artifacts, images, sessions, diffs, and tool output clearly.

| Desktop | Mobile |
| --- | --- |
| ![pi-web desktop showcase](tests/e2e/visual.spec.ts-snapshots/hero-showcase-desktop.png) | ![pi-web mobile showcase](tests/e2e/visual.spec.ts-snapshots/hero-showcase-mobile.png) |

## Why pi-web?

- Mobile-first: use pi from a phone, tablet, or desktop browser
- Minimal by design: a focused agent UI, not a full IDE replacement
- Local-first: run it on your machine and optionally expose it through Tailscale
- Self-aware: pi-web injects web UI context so sessions understand artifacts, images, restarts, and browser-specific behavior
- Code-review friendly: inspect tool output, edits, Git status, commits, and diffs
- Session-oriented: manage ongoing work with tabs, drawers, pins, buckets, filters, and conversation navigation

## What changed in 0.4.0?

0.4.0 focuses on visual polish and a more compact default workflow:

- The default dark theme is now a more neutral black/gray palette
- Active tabs use a dark gray fill with the legacy blue top border, while marked tabs keep their marker-colored border
- Inactive marked tabs are brighter so bucket colors are easier to scan
- The composer collapses to a compact inactive bar with model/reasoning and attach controls visible
- Running sessions can still be stopped directly from the compact composer
- Context utilization over 50% uses the legacy blue context bar
- README-backed visual snapshots were refreshed for the current UI

See the [0.4.0 release notes](docs/releases/0.4.0.md) for the fuller changelog.

## Install

For development:

```bash
npm install
```

From npm:

```bash
npm i -g @ashwin-pc/pi-web
pi-web
```

From a GitHub release asset:

```bash
# Download pi-web-<version>.tgz from the release page, then:
npm install -g ./pi-web-*.tgz
pi-web
```

`pi-web` starts the production server on `http://127.0.0.1:8787` by default. It runs Pi in the directory where you call the command; override with `PI_WEB_CWD=/path/to/project pi-web`.

## Run locally with Vite HMR

```bash
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

The session UI is built for small screens first, then scales up to desktop. Tabs, the session drawer, pinned sessions, bucket filters, and conversation navigation are designed to keep long-running pi work reachable from a phone without hiding the desktop workflow.

### Diffs and tool review

A shared diff viewer supports side-by-side or stacked layouts with intraline highlighting. It is used by both edit tool cards and Git diffs, so code review feels consistent across agent changes and repository history.

### Git status, graph, and commit diffs

The Git button in the header opens a responsive Git panel for repo status, commit history, per-file diffs, per-commit diffs, and sync with `fetch` + rebase pull.

### Self-aware pi context

`contexts/web-ui.md` is injected into agent sessions so pi understands pi-web behavior such as artifact links, image rendering, and supervised restarts. Bundled pi extensions add pi-web defaults, including automatic session naming from the first prompt.

### pi-web extensions

pi-web supports browser-specific extensions in `.pi/web/extensions` and `~/.pi/web/extensions`. These use pi's extension runtime with a typed pi-web UI API, including `ctx.ui.web.setFooter(...)` for rendering text or trusted HTML between the composer and pinned session tabs.

See [pi-web extensions](docs/pi-web-extensions.md) for locations, types, and examples, including the live git footer in [`examples/pi-web-extensions/git-footer.ts`](examples/pi-web-extensions/git-footer.ts).

## Screenshots

The README references the same deterministic Playwright visual snapshots used by `tests/e2e/visual.spec.ts`. Desktop and mobile captures are shown side by side, and when visual snapshots are intentionally updated, these images update with them.

### Diff review

| Desktop | Mobile |
| --- | --- |
| ![pi-web diff review desktop](tests/e2e/visual.spec.ts-snapshots/diff-review-desktop.png) | ![pi-web diff review mobile](tests/e2e/visual.spec.ts-snapshots/diff-review-mobile.png) |

### Session workspace

Tabs, pinned sessions, bucket colors, running indicators, and the session drawer are designed to stay usable on mobile while expanding naturally on desktop.

| Desktop | Mobile |
| --- | --- |
| ![pi-web session workspace desktop](tests/e2e/visual.spec.ts-snapshots/sessions-drawer-desktop.png) | ![pi-web session workspace mobile](tests/e2e/visual.spec.ts-snapshots/sessions-drawer-mobile.png) |

### Git panel

Desktop uses a split master/detail layout; mobile switches between status, graph, diff, and commit detail views.

| Desktop | Mobile |
| --- | --- |
| ![pi-web Git commit diff viewer desktop](tests/e2e/visual.spec.ts-snapshots/git-diff-viewer-desktop.png) | ![pi-web Git commit diff viewer mobile](tests/e2e/visual.spec.ts-snapshots/git-diff-viewer-mobile.png) |

### Conversation tree

Navigate in-file pi session branches with a compact tree drawer. The default view keeps tool noise hidden, while the full session structure remains available from the filter.

| Desktop | Mobile |
| --- | --- |
| ![pi-web conversation tree desktop](tests/e2e/visual.spec.ts-snapshots/conversation-tree-desktop.png) | ![pi-web conversation tree mobile](tests/e2e/visual.spec.ts-snapshots/conversation-tree-mobile.png) |

## Production build

```bash
npm run build
npm start
```

`npm start` serves the compiled `dist/` app and API from one process.

## Run on Tailscale with MagicDNS

Recommended: keep the Node app localhost-only and expose it with Tailscale Serve.

```bash
npm run build
PI_WEB_TOKEN="$(openssl rand -hex 32)" \
PI_WEB_CWD=/Users/ashwin/projects/comfy-lan-webapp \
HOST=127.0.0.1 \
PORT=8787 \
npm start
```

In another terminal:

```bash
tailscale serve --bg http://127.0.0.1:8787
```

Then open:

```text
https://<machine-name>.<tailnet>.ts.net
```

Click **Token** in the UI and paste the `PI_WEB_TOKEN` value.

## Direct Tailnet bind

You can also bind directly to your Tailscale IP:

```bash
PI_WEB_TOKEN="$(openssl rand -hex 32)" \
HOST="$(tailscale ip -4)" \
PORT=8787 \
npm start
```

Then open:

```text
http://<machine-name>:8787
```

## Environment variables

- `HOST` - bind host, default `127.0.0.1`
- `PORT` - bind port, default `8787`
- `PI_WEB_TOKEN` - optional bearer token for API/WebSocket access
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

This app can drive Pi tools such as `bash`, `write`, and `edit`. Use Tailscale ACLs and set `PI_WEB_TOKEN`.
