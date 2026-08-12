# pi-web website phase one: discovery and content architecture

**Status:** implementation source of truth for the first GitHub Pages release  
**Scope:** discovery, claims, information architecture, and future screenshot production only  
**Not in this phase:** Astro/frontend work, dependencies, deployment configuration, or new captures

## 1. Decisions and content thesis

### Positioning

Use this as the canonical product sentence:

> **pi-web is the best interface for working with your agents.**

Support it with an outcome, not a list of UI nouns:

> Give agents meaningful work, keep parallel efforts understandable, inspect what they produce, and shape the interface around your workflow—from any device.

The website should sell **getting more work done with agents**. Sessions, lanes, branches, artifacts, files, Git, models, and tool cards are proof of that outcome, not the opening pitch. “Coding” can appear where a feature is inherently technical (Git, diffs, workspace files), but it must not define the product.

### Audience

Primary audience: people who want an agent to perform substantial, inspectable work rather than merely answer in a chat box. They are comfortable running a local tool, value control over files and context, and want to adapt the interface to their own process.

Secondary audience: current `pi` users looking for a browser interface across desktop, tablet, and phone.

### Narrative order

1. **Outcome:** get more work done with agents.
2. **Working model:** keep work in sessions and lanes while agents run.
3. **Proof:** inspect rich results, tools, files, branches, and Git state.
4. **Agency:** choose models, interrupt or steer work, and control access.
5. **Adaptability:** ask the agent to build a pi-web extension for the workflow.
6. **Direction:** `pi` is the current full-capability reference harness; the architecture is moving toward additional harnesses, but none are shipping yet.

### Claim rules

- Say **“agents”** in product copy and explain that **`pi` is the current default and reference harness** near the first technical explanation.
- Do not say or imply that Codex, Claude Code, Hermes, remote runtimes, multi-user hosting, approvals, or supervised workflows ship today.
- Do not call pi-web a hosted service. It runs on the user's machine; access from another device requires the user's secure network or reverse proxy.
- Do not promise blanket “secure remote access.” pi-web offers an optional bearer token; the user remains responsible for transport and network controls.
- Do not say the Git UI commits or pushes. It currently inspects status/history/diffs and can perform fetch plus rebase pull sync.
- Do not describe current pi-web extensions as harness-neutral. Both regular and browser-specific extensions currently run through `pi`'s extension runtime.
- Do not describe the session-orchestration example as core or enabled by default. It is an opt-in, explicitly experimental extension/skill example.
- Treat the source tree as newer than the 0.5.0 release prose where they conflict. Before launch, reconcile the release baseline; see [Owner decisions](#10-owner-decisions).

## 2. Audit method and status vocabulary

This audit covers:

- [README](../README.md), [package metadata](../package.json), and all [release notes](releases/)
- Current architecture and product design docs: [frontend architecture](frontend-architecture.md), [runtime binding](runtime-binding-design.md), and [multi-harness design](multi-harness-design.md)
- [pi-web extension documentation](pi-web-extensions.md), every [extension example](../examples/pi-web-extensions/), and the [orchestration skill](../examples/pi-web-skills/session-orchestration/SKILL.md)
- Relevant current frontend/server source and unit/E2E tests, including capabilities, sessions, files, artifacts, Git, notifications, access, settings, extension UI, and deterministic visual fixtures
- Open roadmap issues, especially [#92 multi-harness](https://github.com/ashwin-pc/pi-web/issues/92), [#3 runtimes/container access](https://github.com/ashwin-pc/pi-web/issues/3), [#35 workflows](https://github.com/ashwin-pc/pi-web/issues/35), [#45 multi-user](https://github.com/ashwin-pc/pi-web/issues/45), [#89 extension requirements](https://github.com/ashwin-pc/pi-web/issues/89), and [#94 artifact cards](https://github.com/ashwin-pc/pi-web/issues/94)

Inventory granularity is the **marketing capability**, not each button. Sub-controls are recorded with the capability they support.

Other open issues were reviewed but are not promoted into standalone marketing capabilities:

- [#14 Claude Code](https://github.com/ashwin-pc/pi-web/issues/14) is superseded in product direction by the adapter plan in #92; it is not shipping support.
- [#27 offline Mermaid for standalone artifacts](https://github.com/ashwin-pc/pi-web/issues/27) and [#29 opt-in visual-explainer skill](https://github.com/ashwin-pc/pi-web/issues/29) are planned enhancements, not current artifact claims. In-chat Mermaid rendering is available; an arbitrary standalone HTML artifact cannot yet rely on a stable locally served Mermaid URL.
- [#72 attachment resizing](https://github.com/ashwin-pc/pi-web/issues/72) is planned optimization; current attachment support should not be described as automatically resizing images before provider delivery.
- [#101 stale production builds](https://github.com/ashwin-pc/pi-web/issues/101), [#91 load FOUC](https://github.com/ashwin-pc/pi-web/issues/91), [#79 streaming efficiency](https://github.com/ashwin-pc/pi-web/issues/79), [#65 Bedrock error serialization](https://github.com/ashwin-pc/pi-web/issues/65), [#63 stalled runtimes](https://github.com/ashwin-pc/pi-web/issues/63), [#51 retry/runtime state](https://github.com/ashwin-pc/pi-web/issues/51), [#50 post-compaction output](https://github.com/ashwin-pc/pi-web/issues/50), [#23 iOS clipping](https://github.com/ashwin-pc/pi-web/issues/23), [#16 new-session folder selection](https://github.com/ashwin-pc/pi-web/issues/16), [#7 Codespaces recovery](https://github.com/ashwin-pc/pi-web/issues/7), and [#6 dev HMR reloads](https://github.com/ashwin-pc/pi-web/issues/6) are bugs, performance work, or developer experience. They constrain absolute reliability/compatibility claims but do not add routes.

**Availability vocabulary**

- **Available** — implemented and user-visible in the current repository. “Opt-in example” means source ships but the user must install it.
- **In progress** — enabling implementation/design has landed or an implementation exists outside main, but the complete user outcome is not shipping.
- **Planned** — documented in an open design/issue without a shipping user surface.

**Screenshot coverage vocabulary**

- **D/M** — deterministic desktop and mobile visual snapshots exist.
- **D/M (weak)** — captures exist but should not be used for marketing without replacement.
- **None** — no deterministic marketing-ready capture exists.

## 3. Feature inventory by user outcome

### A. Work from anywhere

| Capability and concise user benefit | Availability | Evidence | Existing coverage | Best destination |
|---|---|---|---|---|
| **Responsive browser workspace** — use the same agent workspace on desktop, tablet, and phone, with layouts that turn side panels into focused mobile views. | **Available** | [README: every-device UI](../README.md#why-pi-web), [responsive E2E suite](../tests/e2e/pi-web.spec.ts), [mobile file behavior](../tests/e2e/files.spec.ts) | D/M across hero, new session, Explorer, artifacts, lanes, tree, Git | `/features/work-from-anywhere/` |
| **Installable PWA shell** — open pi-web as a standalone app and receive automatic service-worker updates without a separate native client. | **Available** | [PWA manifest/config](../vite.config.ts), [service worker tests](../tests/service-worker.test.ts), [update controller](../src/app/sw-update.ts) | None | `/features/work-from-anywhere/` |
| **Completion alerts** — know when background work finishes through Web Push, an optional sound, and supported-device vibration; a notification opens the completed session. | **Available** (browser/HTTPS support required) | [notification settings](../src/settings/runNotifications.ts), [completion alert tests](../tests/completion-alerts.test.ts), [notification E2E](../tests/e2e/notifications.spec.ts) | None | `/features/work-from-anywhere/` |
| **User-managed remote access** — reach the local server through Tailscale or another secure proxy/network while keeping the app localhost-bound by default. | **Available** | [README: remote access](../README.md#remote-access), [README: security](../README.md#security) | None | `/getting-started/` and `/features/work-from-anywhere/` |
| **Bearer-token connection and device handoff** — protect API/WebSocket access, paste or scan a token QR, and explicitly generate a trusted-device QR/link from Settings. | **Available** | [token E2E](../tests/e2e/token.spec.ts), [token-sharing tests](../tests/token-share.test.ts), [Access settings](../index.html) | None | `/features/work-from-anywhere/` |
| **Continuity through links and reloads** — active-session URLs, browser history, saved drafts/attachments/quote replies, service reconnection, and state restoration return users to the same work. | **Available** | [0.3.0 continuity notes](releases/0.3.0.md), [composer and URL E2E](../tests/e2e/pi-web.spec.ts), [attachment restore tests](../tests/e2e/pi-web.spec.ts), [quote-reply tests](../tests/e2e/quote-replies.spec.ts) | Indirectly visible; no dedicated capture | `/features/work-from-anywhere/` |
| **Per-session local/remote or sandbox runtime choice** — run different sessions on different boxes without losing features. | **Planned**; local `SessionService` and neutral event boundary are enabling work, but runner/router/provider UI is not shipping | [runtime design, Stages 3–5](runtime-binding-design.md), [#3](https://github.com/ashwin-pc/pi-web/issues/3) | None; do not depict as available | `/principles/` only, under “Direction” |
| **Container runtime inspector and official container setup** — understand mounts, credentials presence, tools, and access boundaries. | **Planned** | [#3](https://github.com/ashwin-pc/pi-web/issues/3) | Current system-info D/M does **not** show this planned inspector | `/principles/` only if roadmap is mentioned |
| **Multi-user hub / organization deployment** — isolate one pi-web instance per user behind a router. | **Planned** | [#45](https://github.com/ashwin-pc/pi-web/issues/45) | None | Omit from first release; technical link from `/principles/` only if needed |

**Claim caveats:** “Work from anywhere” means the interface is device-responsive and can be exposed by the user. It does not mean pi-web supplies hosting, a relay, identity management, or a secure tunnel. Real-iPhone composer clipping remains open in [#23](https://github.com/ashwin-pc/pi-web/issues/23), and Codespaces auth-proxy recovery remains open in [#7](https://github.com/ashwin-pc/pi-web/issues/7); avoid “works perfectly in every browser/environment.”

### B. Do more without losing the thread

| Capability and concise user benefit | Availability | Evidence | Existing coverage | Best destination |
|---|---|---|---|---|
| **Persistent session drawer** — search, group by working directory, pin folders, create/resume/rename/delete sessions, and see running state without flattening all work into one chat. | **Available** | [README: sessions](../README.md#mobile-first-sessions), [drawer E2E](../tests/e2e/pi-web.spec.ts), [session lifecycle tests](../tests/session-list-lifecycle.test.ts) | D/M orphaned `sessions-drawer-*` snapshots; weak and no longer owned by `visual.spec.ts` | `/features/keep-the-thread/` |
| **Pinned quick tabs** — keep the small set of active sessions one tap away, reorder them by mouse or touch, color them, and retain a temporary current tab when unpinned. | **Available** | [0.5.0 highlights](releases/0.5.0.md), [session-bar E2E](../tests/e2e/session-bar.spec.ts) | Visible in hero D/M; current copy is weak | `/features/keep-the-thread/` |
| **Lanes: Pinned, Parked, Bookmarks** — separate active work, paused work, and references; add notes, bucket colors, ordering, and stale parked badges. | **Available** | [README: lanes](../README.md#mobile-first-sessions), [lane behavior E2E](../tests/e2e/session-bar.spec.ts) | D/M `session-lanes-*`; UI is clear but fixture names are generic and background is dim | `/features/keep-the-thread/` |
| **Background state and unread awareness** — see which session is running, when it completed, and what became unread across multiple browser views. | **Available** | [background/unread E2E](../tests/e2e/session-bar.spec.ts), [activity tests](../tests/e2e/activity-progress-video.spec.ts) | Partly visible in drawer/hero; no focused capture | `/features/keep-the-thread/` |
| **Steering and follow-up queues** — redirect a running agent or queue the next request, inspect pending messages before delivery, and stop a run. | **Available** for `pi` | [0.5.0 highlights](releases/0.5.0.md), [send/stop/queue E2E](../tests/e2e/send-stop.spec.ts) | None | `/features/keep-the-thread/` |
| **Conversation branches and precise continuations** — search/filter a compact branch graph, move to an earlier point, edit and rerun a user message, or continue from an assistant response. | **Available** for `pi` | [README: conversation tree](../README.md#conversation-tree), [tree E2E](../tests/e2e/conversation-tree.spec.ts), [message actions](../tests/e2e/message-actions.spec.ts) | D/M `conversation-tree-*`; strong UI, development-specific fixture copy | `/features/keep-the-thread/` |
| **Linked quote replies** — select exact text in an agent response, attach one or more questions to it, and preserve the links through reload and submission. | **Available** | [quote-reply E2E](../tests/e2e/quote-replies.spec.ts), [controller](../src/quotes/quoteReplies.ts) | None | `/features/keep-the-thread/` |
| **Context and recovery controls** — monitor context use, compact/cancel compaction, stop work, retry model failures, continue an incomplete tool turn, or switch models. | **Available** for `pi` | [compaction E2E](../tests/e2e/pi-web.spec.ts), [retry E2E](../tests/e2e/retry-errors.spec.ts), [context meter tests](../tests/ui-polish.test.ts) | Diff D/M shows incomplete-turn recovery, but the failure dominates the image | `/features/stay-in-control/` |
| **Visible multi-session orchestration** — let one session spawn, monitor, steer, read, and interrupt ordinary visible worker sessions, with durable completion wakeups. | **Available as an opt-in experimental extension + skill example**, not core | [extension docs](pi-web-extensions.md#example-multi-agent-session-orchestration), [example source](../examples/pi-web-extensions/session-orchestrator.ts), [skill](../examples/pi-web-skills/session-orchestration/SKILL.md), [tests](../tests/session-orchestrator.test.ts) | None | `/extensions/examples/` |
| **Supervised workflow scripts** — run auditable, cancellable scripts that coordinate sessions. | **Planned** | [#35](https://github.com/ashwin-pc/pi-web/issues/35) | None | Omit from first-release feature claims; optional roadmap link from `/principles/` |

### C. Rich, inspectable results

| Capability and concise user benefit | Availability | Evidence | Existing coverage | Best destination |
|---|---|---|---|---|
| **Rich transcript rendering** — read sanitized Markdown, syntax-highlighted code with copy actions, long-response disclosure, thinking cards, custom extension messages, and provider errors without raw event noise. | **Available** | [Markdown/message E2E](../tests/e2e/pi-web.spec.ts), [thinking E2E](../tests/e2e/thinking-and-stop-reason.spec.ts), [custom messages](../tests/e2e/custom-messages.spec.ts) | Hero D/M shows Markdown/code but is coding-positioned | `/features/rich-results/` |
| **Inspectable tool activity** — follow running tools, partial output, elapsed/quiet/stale state, arguments, results, images, and errors in compact expandable cards. | **Available** | [tool-card source](../src/tools/toolCards.ts), [tool-card E2E](../tests/e2e/pi-web.spec.ts), [unit tests](../tests/tool-cards.test.ts) | Hero and diff D/M; current scenarios are code-only | `/features/rich-results/` and `/features/stay-in-control/` |
| **Mermaid diagrams** — render diagrams inline and open them in a dedicated full-screen viewer with zoom/reset/source controls. | **Available** | [0.3.0 diagram notes](releases/0.3.0.md), [0.5.0 viewer notes](releases/0.5.0.md), [diagram E2E](../tests/e2e/pi-web.spec.ts) | None | `/features/rich-results/` |
| **Interactive inline HTML previews** — view agent-produced interactive figures in a sandbox with sizing and source controls. | **Available** | [HTML preview E2E](../tests/e2e/pi-web.spec.ts), [web UI context](../contexts/web-ui.md#rich-visual-responses) | Hero includes an image artifact, not an HTML-preview widget | `/features/rich-results/` |
| **Artifact links in conversation** — preview images, rendered Markdown, sandboxed HTML, and video directly from agent responses; open or download outputs. | **Available** | [README: rich output](../README.md#workspace-explorer), [artifact-link E2E](../tests/e2e/pi-web.spec.ts), [web UI context](../contexts/web-ui.md#user-visible-artifacts) | No dedicated in-chat artifact-card visual snapshot | `/features/rich-results/` |
| **Artifacts gallery and large previews** — browse generated images, HTML, Markdown, videos, PDFs, files, and folders as deliverables rather than hunting through internal storage. | **Available** | [artifact browser](../src/files/artifactBrowser.ts), [files/artifacts E2E](../tests/e2e/files.spec.ts), [README](../README.md#workspace-explorer) | D/M `artifacts-explorer-*` and `artifact-preview-*`; strongest current non-coding coverage | `/features/rich-results/` |
| **Image and file attachments** — drag/drop or pick generic files, preview images, send attachment-only prompts, restore drafts, and inspect image/tool output full-screen or download it. | **Available** | [composer](../src/composer/composer.ts), [attachment E2E](../tests/e2e/pi-web.spec.ts), [attachment tests](../tests/attachments.test.ts) | Session/Explorer fixtures mention attachment support, but no focused attachment workflow | `/features/rich-results/` |
| **Workspace Explorer** — browse the active session directory, open multiple files, edit with syntax/search, resize or wrap text, preview images, and save with revision conflict detection. | **Available** | [README: Explorer](../README.md#workspace-explorer), [files E2E](../tests/e2e/files.spec.ts), [server safety tests](../tests/workspace-files.test.ts) | D/M `workspace-explorer-*`; useful but explicitly says “coding agent” in fixture | `/features/stay-in-control/` (secondary mention on rich results) |
| **Shared diff viewer** — review edit-tool and Git changes in stacked or side-by-side layouts with intraline highlighting. | **Available** | [README: diffs](../README.md#diffs-and-tool-review), [diff E2E](../tests/e2e/pi-web.spec.ts), [diff unit tests](../tests/git-diff.test.ts) | D/M `diff-review-*` and Git capture; current diff fixture includes an alarming incomplete response | `/features/stay-in-control/` |
| **Improved framed/collapsible in-chat artifact cards** — avoid nested-scroll traps and minimize or expand previews in the conversation. | **In progress**; implemented in a downstream fork but open upstream | [#94](https://github.com/ashwin-pc/pi-web/issues/94) | Do not show proposed chrome as shipping | Future update to `/features/rich-results/` after landing |

### D. Stay in control

| Capability and concise user benefit | Availability | Evidence | Existing coverage | Best destination |
|---|---|---|---|---|
| **Git status, graph, history, and diffs** — inspect repository state, changed files, branches/merges, per-file diffs, and per-commit diffs without leaving the session. | **Available** | [README: Git](../README.md#git-status-graph-and-commit-diffs), [Git E2E](../tests/e2e/git.spec.ts), [shared Git tests](../tests/shared-server-modules.test.ts) | D/M `git-diff-viewer-*`; good control proof but coding-specific | `/features/stay-in-control/` |
| **Git sync** — fetch and rebase-pull with explicit progress/error handling. | **Available** | [Git API route](../server.ts), [Git panel tests](../tests/e2e/git.spec.ts) | None | `/features/stay-in-control/` |
| **Session-scoped file safety** — reject traversal/escaping symlinks, binary or oversized edits; write atomically and prevent silent revision conflicts. | **Available** | [README: Explorer safety](../README.md#workspace-explorer), [workspace-file tests](../tests/workspace-files.test.ts) | Workspace D/M shows editor, not the safety behavior | `/features/stay-in-control/` |
| **Model and reasoning control** — choose a model and reasoning level per session and save model/reasoning defaults for future sessions. | **Available** for models exposed by `pi` | [model E2E](../tests/e2e/pi-web.spec.ts), [settings source](../src/settings/settings.ts) | `model-picker-*` are tiny element snapshots, not useful marketing assets | `/features/stay-in-control/` |
| **Direct commands** — discover web/extension/prompt/skill slash commands and run `!` shell commands either in or outside agent context. | **Available** for `pi` | [composer](../src/composer/composer.ts), [shell E2E](../tests/e2e/composer-shell.spec.ts), [slash-command E2E](../tests/e2e/pi-web.spec.ts) | None | `/features/stay-in-control/` |
| **Fine-grained run control** — stop a live turn, choose steer vs follow-up, pause stream-follow by scrolling, jump to latest, compact context, and retry or switch model after failures. | **Available** for `pi` | [send/stop](../tests/e2e/send-stop.spec.ts), [stream-follow](../tests/e2e/stream-follow.spec.ts), [retry errors](../tests/e2e/retry-errors.spec.ts) | None as a coherent control story | `/features/stay-in-control/` |
| **Session and system visibility** — copy session ID/cwd, see real Git change stats, inspect pi/pi-web/host versions, copy a system report, and open durable diagnostics. | **Available** | [session info E2E](../tests/e2e/session-info.spec.ts), [system info E2E](../tests/e2e/system-info.spec.ts), [diagnostics settings](../index.html) | D/M `system-info-*`; operational, not a lead marketing image | `/getting-started/` or support copy, not a feature-page hero |
| **Local-first trust model** — bind to localhost by default, optionally require a token, keep credentials server-side, and scope workspace/artifact access. | **Available**, with user-managed network security | [README: install/remote/security](../README.md#security), [token tests](../tests/e2e/token.spec.ts), [artifact API tests](../tests/api.test.ts) | None | `/principles/` and `/getting-started/` |
| **Generic interaction/approval channel** — present and resolve extension dialogs, approvals, clarify, sudo, and secret requests consistently. | **In progress** at contract level; extension interaction plumbing exists, but the multi-harness approval experience is not shipping | [multi-harness Track 0](multi-harness-design.md#the-contract-track-0), [interaction API route](../server.ts), [#92](https://github.com/ashwin-pc/pi-web/issues/92) | None; do not market approvals | `/principles/` only as direction |
| **Modern device-session authentication** — pairing, cookies, revocable device sessions, and managed API tokens instead of a static bearer token. | **Planned** | [#85](https://github.com/ashwin-pc/pi-web/issues/85) | None | Omit from first release; current docs must describe bearer token honestly |

### E. Make pi-web work your way

| Capability and concise user benefit | Availability | Evidence | Existing coverage | Best destination |
|---|---|---|---|---|
| **Regular `pi` extensions in the web UI** — reuse tools, commands, prompts, event handlers, and permission gates that also run in the `pi` TUI. | **Available** for `pi` | [extension docs](pi-web-extensions.md#regular-pi-extension-in-pi-web), [extension loader tests](../tests/extensions.test.ts) | None | `/extensions/` |
| **Browser-specific pi-web extensions** — add workflow UI from project-local or user-global TypeScript files while keeping it out of the terminal UI. | **Available** for `pi`; trusted-code model | [extension docs](pi-web-extensions.md#pi-web-extension), [locations](pi-web-extensions.md#pi-web-extension-locations) | None | `/extensions/` |
| **Contribution kernel** — add footers, header actions, artifact actions, Git tabs, right panels, FAB launchers, effects, invalidations, and interactive trusted HTML through one typed API. | **Available** | [contribution API](pi-web-extensions.md#contribution-api), [web panel E2E](../tests/e2e/web-panel.spec.ts), [Git extension E2E](../tests/e2e/git.spec.ts), [footer E2E](../tests/e2e/web-footer.spec.ts) | None | `/extensions/` |
| **Extension-contributed settings and health** — render validated schemas, migrate/persist values, report runtime errors, and retry extensions without restarting pi-web. | **Available** | [settings API](pi-web-extensions.md#settings-api), [settings tests](../tests/extension-settings.test.ts), [resilient loader tests](../tests/resilient-extension-loader.test.ts) | None | `/extensions/` |
| **Ask the agent to build the workflow UI** — describe a panel/action/settings workflow and have the agent create the TypeScript extension in `.pi/web/extensions`, using the shipped docs and examples; reload and inspect it in the same app. This is a usage pattern, not a dedicated generator button. | **Available as an agent-assisted `pi` workflow**, because extension source is ordinary project code. The recommended prompt must point the agent to `docs/pi-web-extensions.md` and the installed examples; the website must show the concrete prompt/files/reload loop rather than imply one-click generation or automatic API discovery. | [extension docs](pi-web-extensions.md), [web UI context](../contexts/web-ui.md), [examples](../examples/pi-web-extensions/) | None; highest-priority missing capture | `/extensions/` |
| **Shipped examples** — install a live Git footer, GitHub PR/issue tab, artifact download action, recap action, global notepad, or experimental session orchestrator. | **Available as opt-in source examples**; GitHub needs `gh`, orchestrator is experimental | [examples section](pi-web-extensions.md#example-github-prs-and-issues-tab), [example directory](../examples/pi-web-extensions/) | None | `/extensions/examples/` |
| **Capability discovery** — extensions can inspect the host API version, supported slots, kinds, and effects and degrade honestly. | **Available** | [capabilities docs](pi-web-extensions.md#contribution-api), [capability E2E](../tests/e2e/capabilities.spec.ts) | None | `/extensions/` technical section |
| **Declarative extension requirements** — skip incompatible extensions before executing them and report unmet capabilities. | **In progress / planned for main** | [#89](https://github.com/ashwin-pc/pi-web/issues/89) | None | Do not claim in first release |
| **Harness-neutral host add-ons and federated package discovery** — run UI add-ons independently of `pi`, target harness/runtime packages, and install from inspected sources/catalogs. | **Planned** as a later multi-harness extension model | [#92](https://github.com/ashwin-pc/pi-web/issues/92), especially its host-add-on design amendment | None | `/principles/` direction; current `/extensions/` must state the `pi` dependency |

## 4. Shipping capability versus roadmap direction

### What ships now

- One agent harness: **`pi`**.
- `pi` supplies the current session model, models/reasoning, tree navigation, steering/follow-up queues, compaction, slash commands, shell execution, and extension runtime.
- The browser UI, session workspace, rich transcript, artifact browser, file editor, diff/Git views, notifications, token access, settings, and pi-backed extension contribution surfaces are available in the current repository.
- An agent-neutral typed event/capability/interaction foundation is visible in source and tests, but that foundation is not itself multi-harness product support.

### What does not ship yet

- No Codex, Claude Code, or Hermes adapter or selector.
- No per-session runtime selector, runner transport, runtime router, Docker/SSH provider UI, or host model broker.
- No generic approvals UI proven across harnesses.
- No harness-neutral host add-on runtime or package marketplace.
- No multi-user hub.
- No built-in supervised workflow-script product.

### Approved future-facing language

Use one restrained statement, preferably on `/principles/` and optionally as a small home-page note:

> `pi` is pi-web's current default and full-capability reference harness. The session contract is being designed so additional harnesses can fit without flattening their differences or reducing what `pi` can do.

Link **“session contract”** to [multi-harness-design.md](multi-harness-design.md) or [issue #92](https://github.com/ashwin-pc/pi-web/issues/92). Do not pair the statement with Codex/Claude/Hermes logos, compatibility badges, “coming soon” cards, or a feature comparison; those treatments are too easily read as imminent or shipping support.

## 5. Deterministic screenshot audit

All tracked visual snapshots are under [`tests/e2e/visual.spec.ts-snapshots`](../tests/e2e/visual.spec.ts-snapshots/). The current deterministic suite uses the real app UI with routed APIs and frozen fixtures, disables motion for capture, and covers desktop/mobile (tablet is behavior-tested but intentionally omitted from visual baselines). That is the correct production method for the website; improve the fixtures rather than fabricate a separate site mockup.

| Snapshot pair | Current message | Marketing assessment and positioning conflict | Decision |
|---|---|---|---|
| `hero-showcase-*` | Full transcript, tool read/edit, code diff, image, app launcher, pinned tabs | **Direct conflict.** The assistant headline says **“Mobile-first coding UI”**; supporting copy discusses CSS and responsive snapshots. It frames pi-web as coding-specific, shows `Mock Model`, and leads with mechanics. Mobile is visually dense and begins mid-conversation. | **Do not use. Replace before launch.** |
| `new-session-*` | Clean empty state, working directory selector, composer, responsive header | Neutral and polished, but it proves onboarding rather than meaningful work. Desktop contains a large amount of empty space; `mock/model` undermines production feel. | Keep as secondary Getting Started image only after replacing mock labels/path. |
| `session-lanes-*` | Pinned/Parked/Bookmarks, notes, colors, stale badge | The lane UI communicates the concept well. Generic titles (`Session`, `Current mock session`) and implementation/release notes make it feel like a test fixture; desktop is a narrow sheet floating over a heavily dimmed coding transcript. | Re-capture with a meaningful non-coding work set. Existing mobile can serve as temporary documentation only. |
| `sessions-drawer-*` | Search, folders, filters/colors, running indicators, footer actions | Generic fixture copy and lots of dead space. More importantly, these files are **orphaned**: current `visual.spec.ts` does not generate them, so they are not trustworthy maintained baselines. | Do not use; either restore an owned visual test with a stronger fixture or remove from the marketing pool later. |
| `conversation-tree-*` | Dense branch graph with current path and filters | Strong proof of branching. Every label discusses implementing the conversation-tree layout, so it reads as a developer self-test rather than an adaptable agent workflow. Mobile panel-only crop is good; desktop wastes the left half on a dim generic transcript. | Re-capture with decisions/research alternatives. |
| `workspace-explorer-*` | Real split chat/tree/editor and focused mobile editor | Clear and credible, but the file says “web UI for the pi coding agent” and the entire scenario is code/README editing. Useful on control/technical pages, not the home hero. | May be used on `/features/stay-in-control/` with a precise caption; replace copy for broader positioning when convenient. |
| `artifacts-explorer-*` | Gallery of folders, HTML, image, Markdown, and video | **Best current broad-product asset.** It communicates deliverables rather than chat. `Constellation` is synthetic fixture content and desktop retains a dim coding-oriented transcript, but the visible gallery itself is non-coding and legible. | Use in first release on `/features/rich-results/` if no replacement is ready. Prefer a recorded real agent deliverable fixture later. |
| `artifact-preview-*` | Large interactive HTML result with Open/Download | Strong, focused outcome proof and non-coding content. The “live controls” wording is credible because scripts are allowed in the sandbox, though the frozen visual cannot show motion. Desktop again includes irrelevant dim transcript space. | Use on `/features/rich-results/`; mobile is strongest. Caption as an interactive HTML artifact, not a live demo. |
| `diff-review-*` | Responsive intraline edit diff plus incomplete-response recovery | The diff is clear, but the large red **“response incomplete”** card suggests unreliability and the source is code-only. | Do not use in overview/home. Re-capture a successful inspectable change for control page. |
| `git-diff-viewer-*` | Commit metadata, changed files, and split diff | Good evidence for advanced control, with a real-looking deterministic commit fixture. Inherently coding-specific and includes a mock-session background on desktop. | Acceptable on `/features/stay-in-control/`, never as general hero proof. |
| `system-info-*` | pi-web/pi/Node/host versions and copyable report | Accurate operational UI, but not a user outcome and the fixture shows mock host values. The mobile capture cuts off lower content. | Keep for docs/support, not marketing. |
| `model-picker-*` | Current model button only | These are 1126×40 and 111×38 element baselines, not screenshots that explain model control. | Never use on the website. |

### Cross-cutting screenshot problems

1. **Positioning:** the current hero and several fixture documents explicitly say “coding UI/agent.”
2. **Mock residue:** `Mock Model`, “mock session,” `/some/file.ts`, and generic `Session` labels reduce trust.
3. **Background waste:** many desktop side-panel captures devote half the canvas to a dim transcript unrelated to the feature.
4. **Test copy instead of user work:** tree, lane, Git, and Explorer fixtures describe pi-web's own implementation.
5. **Missing pillars:** no maintained visual baseline demonstrates extension-built workflow UI, queue steering/follow-up, quote replies, notifications/device handoff, Mermaid viewer, or visible worker-session orchestration.
6. **README incompleteness:** the README publishes hero/new/Explorer/diff/lanes/Git/tree pairs but omits the stronger artifacts gallery/preview pair.
7. **Release drift:** screenshots show v0.5.0/pi 0.82.0 in system info while current package dependencies are 0.84.1; do not infer current runtime versions from screenshot fixtures.

## 6. Screenshot production brief

### Fixture standard

For every new capture:

- Use the **real pi-web UI** and deterministic Playwright visual path, not a Figma/browser mockup.
- Prefer a **sanitized recorded real `pi` session** replayed through the mock harness. Freeze timestamps, paths, model labels, tool events, artifacts, and Git data in a dedicated marketing fixture.
- Where a live extension is the subject, install and execute the actual checked-in example (or a minimal checked-in marketing extension) against the test server; do not merely inject HTML that resembles an extension.
- Use product-neutral paths such as `/workspace/launch-plan` or `/workspace/research`, a credible non-`Mock` model label, and meaningful session names.
- Capture desktop at **1440×960 or 1440×1000** and mobile at **390×844**. Keep the current 393×727 baselines for regression if desired, but website captures need more vertical room on modern phones. Add a **1024×768 tablet** capture only for the responsive overview, not every feature.
- Disable animation only after the intended UI state is reached. Keep status, current path, and controls authentic.
- Store website-ready captures as outputs of named visual tests so they stay reproducible.

### Capture list, ordered by first-release priority

| Priority / capture | Scenario | Viewport(s) | Required UI state | Message it must communicate |
|---|---|---|---|---|
| **P0 — Home hero: meaningful work in progress** | A real recorded session turns a folder of customer notes into a launch brief and a visual summary. Other named sessions cover research, fact-checking, and reference material. | Desktop 1440×1000; mobile 390×844 | Final assistant response visible with a concise summary, one completed inspectable tool card, one artifact card/preview, credible model label, and named pinned tabs. On mobile, frame the result and compact launcher without beginning mid-sentence. | “This is an interface where agents do work and deliver results—not another chat box.” |
| **P0 — Extensions: ask, build, use** | User asks: “Add a project decision log panel with title, owner, and status.” The recorded agent writes a real `.pi/web/extensions/decision-log.ts`, reloads resources, and the actual contributed panel opens with two entries. | Desktop 1440×1000; mobile 390×844 | Split or sequential state: concise user request and completed tool cards remain visible beside the real panel; panel is launched through a real header/FAB contribution; extension health is ready. | “Describe the workflow you need; your agent can build it into pi-web.” |
| **P0 — Keep the thread: session workspace** | Four meaningful sessions: “Synthesize interviews” (running), “Draft launch brief” (current), “Check market claims” (parked with note), and “Source library” (bookmark). | Desktop 1440×1000; mobile 390×844 | Lanes open; Pinned/Parked/Bookmarks, notes, colors, stale marker only where semantically useful, unread/running indicator, and reordered pinned tabs visible. Avoid a fully dim, empty background. | “Parallel work stays organized and resumable.” |
| **P0 — Rich results: artifact gallery to preview** | The recorded launch-planning session produces a Markdown brief, interactive HTML timeline, chart image, PDF handoff, and short walkthrough video in `.pi/web/artifacts/`. | Desktop 1440×1000; mobile 390×844 | Capture one gallery frame and one large HTML or Markdown preview frame. Use real files from the frozen recorded run; Open and Download visible. | “Agent work becomes rich, inspectable deliverables.” |
| **P1 — Branch without losing decisions** | A research session explores three positioning directions, abandons one, and continues from the preferred branch. Labels describe user outcomes, not graph implementation. | Desktop 1440×1000; mobile panel crop 390×844 | Tree open, current path highlighted, two branch points, search/filter visible, selected node detail meaningful. | “Explore alternatives while preserving every path.” |
| **P1 — Steer work while it runs** | An agent is assembling a report. The user sends “Prioritize evidence from the last 12 months” as steering and “Export a one-page summary” as follow-up. | Desktop 1440×960; mobile 390×844 | Running state, Stop, steer/follow-up mode control, and both pending messages visibly separated above the composer. | “Redirect now, queue next, and always see what will happen.” |
| **P1 — Inspect and control a change** | A successful agent task updates a small data/report template and explains the result. Use a clean diff and Git status/history; no incomplete-response error. | Desktop 1440×1000; mobile 390×844 | One capture for edit diff, one for Git commit/file diff; successful final response and real-looking project names. | “See exactly what changed before moving on.” |
| **P1 — Reply to exact passages** | An agent returns a strategy draft. The user selects two claims and attaches separate questions. | Desktop 1200×900; mobile 390×844 | Highlight marks, numbered reply pins/notes, composer summary showing two linked replies. | “Give precise feedback without re-explaining context.” |
| **P1 — Visible worker sessions (example)** | The opt-in orchestrator delegates research and verification to two ordinary sessions and receives one durable wakeup. | Desktop 1440×1000; mobile 390×844 | Parent/child indentation in drawer, running/waiting indicators, linked worker chips, and wakeup card. Add an in-image or adjacent site label “Experimental extension example”; do not bake a fake core badge into pi-web. | “Delegated work stays visible, reviewable, and interruptible.” |
| **P2 — Work from another device** | Desktop Settings shows an explicitly generated token QR while the phone shows the connected session and a completion notification test state. | Desktop 1200×900; mobile 390×844 | Use real Access & sharing UI and token overlay/scan affordance; redact token/QR payload in public fixture while retaining structure. For notification, prefer browser-owned deterministic test UI; do not fake OS chrome. | “Connect a trusted device and return when the work is done.” |
| **P2 — Mermaid result viewer** | Agent produces a process map for the launch workflow. | Desktop 1200×900; mobile 390×844 | Rendered diagram and full-screen viewer controls/source toggle visible, using a real Mermaid message fixture. | “Complex results stay visual and inspectable.” |

The first release needs the four P0 stories. P1/P2 can reuse acceptable current captures or launch without an image; do not delay the whole site to illustrate every feature.

## 7. Route-level content outline

### `/` — Home

- **Purpose:** establish the category and move visitors to installation or an outcome they care about.
- **Audience question:** “Why should I use this instead of a chat UI or terminal-only agent?”
- **Headline direction:** **The best interface for working with your agents.**
- **Supporting line:** “Give agents meaningful work, keep every thread understandable, and inspect rich results from any device.”
- **Major sections:** hero with real-work capture; five outcome cards; “work, not just chat” proof strip; extensions pillar (“ask your agent to build the workflow UI”); current-harness statement (`pi` today, harness-neutral direction); local-first trust statement.
- **Primary CTA:** **Get started** → `/getting-started/`.
- **Secondary CTA:** **Explore features** → `/features/`; GitHub icon/link as tertiary.
- **Technical links:** [README](../README.md), [`pi` reference harness](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), [multi-harness design](multi-harness-design.md) only from the future-direction note.

### `/getting-started/`

- **Purpose:** get a qualified visitor from prerequisites to a first successful session without pretending there is a live demo.
- **Audience question:** “What do I install, where does it run, and how do I connect a model or another device?”
- **Headline direction:** **From install to your first agent session.**
- **Major sections:** Node 24+ prerequisite; recommended `npx -y @ashwin-pc/pi-web@latest`; global install alternative; run in the desired working directory / `PI_WEB_CWD`; first-run `pi` provider login; open localhost; optional token and Tailscale/reverse-proxy setup; first-session checklist; update/troubleshooting links; explicit “No live demo—pi-web works with your local projects and credentials.”
- **Primary CTA:** **Run pi-web** (copy command).
- **Secondary CTA:** **See what it can do** → `/features/`.
- **Technical links:** [README Install](../README.md#install), [provider onboarding notes](releases/0.4.1.md), [Remote access](../README.md#remote-access), [environment variables](../README.md#environment-variables), [Security](../README.md#security), [System information tests](../tests/e2e/system-info.spec.ts).

### `/features/` — Outcome overview

- **Purpose:** provide the scannable multi-page feature showcase without turning home into a catalogue.
- **Audience question:** “What outcomes does pi-web support?”
- **Headline direction:** **More work done. Every thread visible.**
- **Major sections:** one card/short proof for each outcome; availability legend (“Available now” vs “Direction”); compact capability index; “Current harness: `pi`” note.
- **Primary CTA:** **Choose an outcome** (first relevant detail page).
- **Secondary CTA:** **Install pi-web** → `/getting-started/`.
- **Technical links:** [README Core features](../README.md#core-features), [0.5.0 notes](releases/0.5.0.md).

### `/features/work-from-anywhere/`

- **Purpose:** show responsive continuity without suggesting hosted infrastructure.
- **Audience question:** “Can I check, steer, and resume agent work away from my desk?”
- **Headline direction:** **Your agent workspace, on the screen you have.**
- **Major sections:** responsive desktop/tablet/mobile layouts; installable PWA; URL/draft/session continuity; completion notifications; trusted-device token/QR; user-managed Tailscale/proxy pattern; limitations and secure deployment responsibility.
- **Primary CTA:** **Set up pi-web** → `/getting-started/`.
- **Secondary CTA:** **See session organization** → `/features/keep-the-thread/`.
- **Technical links:** [Remote access](../README.md#remote-access), [Security](../README.md#security), [PWA config](../vite.config.ts), [notification source](../src/settings/runNotifications.ts), [token tests](../tests/e2e/token.spec.ts).

### `/features/keep-the-thread/`

- **Purpose:** explain pi-web's session-first model as the answer to long-running and parallel agent work.
- **Audience question:** “How do I keep multiple efforts understandable and return to the right context?”
- **Headline direction:** **Do more without losing the thread.**
- **Major sections:** persistent sessions/drawer; pinned quick tabs; Pinned/Parked/Bookmarks lanes; notes/colors/stale/unread/running state; steer versus follow-up queues; branches and message actions; exact quote replies; experimental visible-worker example linked—not presented as core.
- **Primary CTA:** **Start a session** → `/getting-started/`.
- **Secondary CTA:** **See the orchestration example** → `/extensions/examples/#session-orchestration`.
- **Technical links:** [README Sessions](../README.md#mobile-first-sessions), [README Conversation tree](../README.md#conversation-tree), [session-bar tests](../tests/e2e/session-bar.spec.ts), [quote-reply tests](../tests/e2e/quote-replies.spec.ts), [orchestration skill](../examples/pi-web-skills/session-orchestration/SKILL.md).

### `/features/rich-results/`

- **Purpose:** demonstrate that agent output can be a deliverable, not only transcript text.
- **Audience question:** “Can I understand and use what the agent produces without opening a pile of raw files?”
- **Headline direction:** **Results you can see, inspect, and use.**
- **Major sections:** rich Markdown/code/thinking/tool output; Mermaid; interactive HTML previews; in-chat artifact links; Artifacts gallery; large previews for image/HTML/Markdown/video/PDF; open/download; image/file attachments; safety note for sandboxed HTML.
- **Primary CTA:** **Explore all features** → `/features/` or **Get started** if arriving from search.
- **Secondary CTA:** **Add an artifact workflow** → `/extensions/`.
- **Technical links:** [web UI context](../contexts/web-ui.md), [artifact browser](../src/files/artifactBrowser.ts), [files/artifact tests](../tests/e2e/files.spec.ts), [README Explorer](../README.md#workspace-explorer).

### `/features/stay-in-control/`

- **Purpose:** answer trust and inspectability concerns with concrete intervention/review surfaces.
- **Audience question:** “Can I see what the agent is doing, redirect it, and verify changes?”
- **Headline direction:** **Stay close enough to trust the work.**
- **Major sections:** live tool cards and progress; stop/steer/follow-up; model/reasoning choice; context/compaction/retry; Workspace Explorer and safe saves; shared edit/Git diffs; Git status/graph/history/sync; slash/shell commands; system/session diagnostics; local-first access boundary.
- **Primary CTA:** **Install and inspect a first run** → `/getting-started/`.
- **Secondary CTA:** **Read the principles** → `/principles/`.
- **Technical links:** [README Diffs](../README.md#diffs-and-tool-review), [README Git](../README.md#git-status-graph-and-commit-diffs), [workspace safety tests](../tests/workspace-files.test.ts), [retry tests](../tests/e2e/retry-errors.spec.ts), [Security](../README.md#security).

### `/extensions/` — “Make pi-web work your way” outcome page

- **Purpose:** make extensions a product pillar and reframe customization as something the user can ask an agent to implement.
- **Audience question:** “Can this interface adapt to my workflow without waiting for the core product?”
- **Headline direction:** **Describe the workflow. Ask your agent to add it.**
- **Major sections:** extension outcome examples; the ask → create `.pi/web/extensions/*.ts` → `/reload` → use loop; regular `pi` vs pi-web-only extension decision; project-local versus global scope; contribution surfaces visual index; settings/health; trusted-code warning; “currently powered by `pi`'s extension runtime” boundary; capability discovery; link to examples and complete API docs.
- **Primary CTA:** **Try an example** → `/extensions/examples/`.
- **Secondary CTA:** **Read the extension API** → repository docs.
- **Technical links:** [pi-web extensions](pi-web-extensions.md), [web UI context](../contexts/web-ui.md), [typed public API](../src/extensions.ts), [examples](../examples/pi-web-extensions/).

### `/extensions/examples/`

- **Purpose:** provide copyable starting points and prove the range of extension surfaces without claiming a marketplace.
- **Audience question:** “What can I add today, and how do I install or adapt it?”
- **Headline direction:** **Start with a working extension. Make it yours.**
- **Major sections:** filters/anchors by use case and surface; one card each for Global notepad, GitHub PRs/issues, Recap, Download artifact, Live Git footer, and Session orchestration; prerequisites; project/global install snippets; “Ask your agent to adapt this” prompt for each; labels for core dependency and maturity; removal/update instructions; trusted-source warning.
- **Primary CTA:** **Copy an install command** or **Open source** per example.
- **Secondary CTA:** **Build your own** → `/extensions/` API section.
- **Technical links:** each file under [examples/pi-web-extensions](../examples/pi-web-extensions/), [orchestration skill](../examples/pi-web-skills/session-orchestration/SKILL.md), [extension docs examples](pi-web-extensions.md#example-github-prs-and-issues-tab).

### `/principles/`

- **Purpose:** explain durable product decisions and place roadmap direction without contaminating shipping claims.
- **Audience question:** “What is pi-web optimizing for, and where is it going?”
- **Headline direction:** **Built for agents that do real work.**
- **Major sections:** outcomes over chat; session-first continuity; inspectable results; local-first/user-controlled access; minimal interface, not full IDE; adaptability through extensions; `pi` as current full-capability reference; harness-neutral direction and capability honesty; runtime/harness orthogonality; roadmap disclaimer.
- **Primary CTA:** **Get started** → `/getting-started/`.
- **Secondary CTA:** **Read the designs** → GitHub docs/issues.
- **Technical links:** [README Why pi-web](../README.md#why-pi-web), [runtime design](runtime-binding-design.md), [multi-harness design](multi-harness-design.md), [#92](https://github.com/ashwin-pc/pi-web/issues/92), [Security](../README.md#security).

## 8. Route overlap and missing-route decisions

### Resolve overlap

- **Do not create `/features/make-it-yours/`.** `/extensions/` is that outcome's detail page. The Features overview card should link there directly. If a uniform URL is desired, make `/features/make-it-yours/` a redirect, not duplicate content.
- **Explorer belongs primarily to Stay in control.** Rich results may mention opening generated files, but should not duplicate editor/safe-save detail.
- **Git belongs only to Stay in control.** The home page may show a small proof point, not a Git feature section.
- **Orchestration belongs to Examples.** Keep-the-thread can link to it as an experimental extension; it should not appear as a built-in feature.
- **Roadmap belongs to Principles.** Detail pages should not carry “coming soon” cards that blur availability.

### Routes intentionally absent from the first release

- **No live demo** route (already agreed).
- **No standalone roadmap** route; use Principles plus links to open designs.
- **No screenshot gallery**; images support specific claims on their pages.
- **No changelog/releases** page; link GitHub releases/repository release notes.
- **No blog, about, pricing, comparison, or showcase directory** until there is real content/user evidence.
- **No API-reference recreation.** Keep technical API detail in repository docs and let the site explain outcomes and the extension-building loop.

### Missing utility content

A global footer should link GitHub, npm, Getting Started, Extensions docs, Principles, License, and Security. Every page should display a small current-state label where relevant: **Available now**, **Opt-in example**, or **Direction**.

## 9. Minimum first-release scope

Ship the ten routes above, but keep each outcome page concise. This is the minimum that preserves the agreed multi-page feature showcase without creating duplicate sections:

1. `/`
2. `/getting-started/`
3. `/features/`
4. `/features/work-from-anywhere/`
5. `/features/keep-the-thread/`
6. `/features/rich-results/`
7. `/features/stay-in-control/`
8. `/extensions/`
9. `/extensions/examples/`
10. `/principles/`

### Required content/assets for launch

- Canonical positioning and claim rules from this document.
- One short content block per major section in the route outlines; no exhaustive control reference.
- Four new P0 deterministic capture stories: home hero, extension-built panel, meaningful session lanes, and real artifact gallery/preview.
- Acceptable reuse of current Git and Workspace Explorer captures on Stay in control if new P1 captures are not ready.
- Install command, Node requirement, first-run provider flow, localhost default, optional token, and remote-access responsibility.
- Clear `pi`-today / additional-harnesses-not-shipping statement.
- Per-example maturity and prerequisite labels.
- GitHub and npm CTAs; no newsletter, analytics-dependent content, or demo infrastructure.

### Explicit deferrals

- P1/P2 screenshot stories except where easy to add to the same deterministic fixture.
- Animated video hero, interactive site demos, comparison tables, testimonials, user logos, marketplace browsing, hosted-service language, and roadmap timelines.
- Building separate marketing-only UI mockups.

## 10. Owner decisions

Only these decisions require owner confirmation; all other content choices are resolved above.

1. **Launch claim baseline: current main or latest tagged package?**  
   The repository reports package version 0.5.0, but current dependencies/source include `pi` 0.84.1 and features not described by the 0.5.0 notes, while README/release copy still says 0.82.0 in places.  
   **Recommendation:** tie website launch to a new tagged release and validate the inventory against that tag. Until then, implementation should treat this document as “current main,” not promise that every row is in npm 0.5.0.

2. **Primary install CTA command.**  
   Options are `npx -y @ashwin-pc/pi-web@latest`, global npm install, or a GitHub release tarball.  
   **Recommendation:** make `npx -y @ashwin-pc/pi-web@latest` primary, global install secondary, release asset tertiary.

3. **How prominently to state harness-neutral direction.**  
   The factual boundary is fixed; the choice is prominence.  
   **Recommendation:** one small home note and a full Principles section. Do not name or logo Codex/Claude/Hermes in marketing surfaces before an adapter ships; retain names only inside linked technical design material.

4. **Mascot role in the website brand.**  
   The app uses the mascot prominently, but phase one has no agreed rule for whether it is the website hero mark, a supporting illustration, or app-only. This affects screenshot framing and headline hierarchy.  
   **Recommendation:** use the mascot as a supporting product cue, not as the primary hero message; the real app capture should remain the hero proof.

5. **Experimental orchestration example prominence.**  
   It strongly supports “agents doing meaningful parallel work,” but is opt-in and experimental.  
   **Recommendation:** feature it on `/extensions/examples/` and link it once from Keep the thread with an explicit **Experimental example** label; do not put it in the home feature grid as a shipping core capability.

## 11. Resolved recommendations

- **Voice:** concise, concrete, outcome-first; avoid “AI chat,” “copilot,” “IDE replacement,” and unexplained architecture jargon.
- **Product name:** use `pi-web`; use lower-case `pi` for the current harness unless quoting upstream package names.
- **Feature status:** default to no badge for available core features; visibly label opt-in examples and direction. Never use “coming soon” without a committed release.
- **Extensions:** lead with the user's request to the agent, then show the underlying TypeScript/API. Do not lead with “developer API.”
- **Proof:** screenshots should show completed or progressing real work. UI mechanisms should be explained by the outcome they protect.
- **Technical links:** link repository docs rather than copying detailed API reference into the site.
- **Security:** say local-first and user-controlled, then state the token/network responsibility. Never imply that a bearer token makes plain public HTTP safe.
- **Harness direction:** `pi` loses no capability as adapters are added; differing harness controls will be capability-gated rather than faked.
- **Screenshots:** deterministic app fixtures are canonical; the website should consume maintained outputs, not fork visual truth.

## 12. Unsupported-claim review

The document was reviewed against current repository evidence with these corrections applied:

- Alternate harnesses are marked planned, despite agent-neutral contracts and design docs already existing.
- Remote access is described as user-managed; no hosted relay or identity layer is claimed.
- Current extension UI is explicitly tied to `pi`'s runtime; future host add-ons are separated.
- Session orchestration is labeled opt-in and experimental.
- Artifact support is limited to kinds implemented by the browser (`image`, `HTML`, `Markdown`, `video`, `PDF`, generic files/folders); no office-document preview is claimed.
- Git creation/push is not claimed; only inspection and fetch + rebase-pull sync are listed.
- Approvals, workflows, container/runtime providers, modern device auth, and multi-user support are not listed as shipping.
- PWA notifications retain browser, service-worker, and HTTPS/localhost caveats.
- Current image attachments are not claimed to be resized automatically before provider delivery.
- In-chat Mermaid and standalone artifact behavior are not conflated; a stable local Mermaid vendor route for arbitrary HTML artifacts remains planned.
- The agent-built extension story is described as a documented, prompted workflow—not a built-in generator or automatic API discovery feature.
- The mismatch between package/release prose and current source is recorded as an owner decision rather than silently choosing a release claim set.

Before frontend implementation, re-run this claim review against the exact release tag selected for the website launch.