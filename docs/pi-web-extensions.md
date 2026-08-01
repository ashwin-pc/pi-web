# pi-web extensions

pi-web supports two extension styles:

1. **Regular pi extensions** — the same extensions you use in the pi TUI.
2. **pi-web extensions** — extensions written the same way, but placed in pi-web-only locations and typed with `PiWebExtensionAPI` so they can use browser-specific APIs like `ctx.ui.web.setFooter()`.

Both styles run through pi's existing extension runtime. pi-web does not have a separate extension engine.

## Which kind should I write?

| Use case | Location | Type import | Runs in pi TUI? | Runs in pi-web? |
| --- | --- | --- | --- | --- |
| Agent behavior, tools, commands, prompts, permission gates | `.pi/extensions` or `~/.pi/agent/extensions` | `ExtensionAPI` from `@earendil-works/pi-coding-agent` | Yes | Yes |
| Browser-only UI such as HTML footers | `.pi/web/extensions` or `~/.pi/web/extensions` | `PiWebExtensionAPI` from `@ashwin-pc/pi-web/extensions` | No | Yes |

Use a regular pi extension when the extension should behave the same in terminal pi and pi-web. Use a pi-web extension when it depends on browser UI or HTML rendering.

## Regular pi extension in pi-web

Regular pi extensions continue to work in pi-web:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("Loaded in pi and pi-web", "info");
  });
}
```

Put that in `.pi/extensions/example.ts` or `~/.pi/agent/extensions/example.ts`.

## pi-web extension

A pi-web extension looks the same, but imports `PiWebExtensionAPI` and lives in a pi-web-only extension directory:

```ts
import type { PiWebExtensionAPI } from "@ashwin-pc/pi-web/extensions";

export default function (pi: PiWebExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.web.setFooter("hello", "Hello from pi-web");
  });
}
```

Put that in `.pi/web/extensions/example.ts` or `~/.pi/web/extensions/example.ts`.

`PiWebExtensionAPI` mirrors pi's `ExtensionAPI`, but the handler context has `ctx.ui.web` for browser-only APIs.

## pi-web extension locations

pi-web-only extensions are loaded from:

| Location | Scope |
| --- | --- |
| `.pi/web/extensions/*.ts` | Project-local, pi-web only |
| `.pi/web/extensions/*/index.ts` | Project-local directory extension |
| `~/.pi/web/extensions/*.ts` | User-global, pi-web only |
| `~/.pi/web/extensions/*/index.ts` | User-global directory extension |

These are separate from regular pi extension locations on purpose. A pi-web extension can use HTML and browser-specific APIs without promising that the same UI works in the terminal TUI.

## Footer API

`ctx.ui.web.setFooter(key, footer)` sets a footer region between the composer and pinned session tabs. Multiple extensions can set independent footer regions by using different keys.

Clear a footer by passing `undefined`:

```ts
ctx.ui.web.setFooter("hello", undefined);
```

### Plain text

```ts
ctx.ui.web.setFooter("git", "🌿 main");
```

### Multiple text lines

```ts
ctx.ui.web.setFooter("git", ["🌿 main", "clean"]);
```

### Custom HTML

```ts
ctx.ui.web.setFooter("git", {
  kind: "html",
  html: `<div style="display:flex;justify-content:space-between">
    <span>🌿 <strong>main</strong></span>
    <span style="color:#86efac">● clean</span>
  </div>`,
});
```

HTML is rendered as trusted extension-provided markup. pi-web extensions run with the same local trust model as regular pi extensions, so only install extensions from sources you trust.

## Header action API

`ctx.ui.web.setHeaderAction(key, action)` contributes an icon button to the status bar. Clicking it invokes your extension handler and renders returned Markdown in a shared dismissible popover.

```ts
ctx.ui.web.setHeaderAction("recap", {
  icon: "scroll-text",
  title: "Session recap",
  label: "Recap",
  invoke: async () => ({ markdown: "## What this session is about\n..." }),
});
```

Clear an action by passing `undefined`:

```ts
ctx.ui.web.setHeaderAction("recap", undefined);
```

The repo includes a recap example at [`examples/pi-web-extensions/recap.ts`](../examples/pi-web-extensions/recap.ts).

## Artifact preview action API

`ctx.ui.web.setArtifactAction(key, action)` adds an action to matching Markdown, HTML, or video artifact preview cards. Match by preview kind, filename extension, or both. The handler receives the artifact's name, `/api/artifacts/...` path, and kind, and may return Markdown or a plain-text message shown in the card.

```ts
ctx.ui.web.setArtifactAction("publish", {
  title: "Publish HTML preview",
  label: "Publish",
  kinds: ["html"],
  extensions: [".html", ".htm"],
  invoke: async ({ name, path, kind }) => ({
    markdown: `Published **${name}** (${kind}) from \`${path}\`.`,
  }),
});
```

An action can also trigger an authenticated browser download of the current artifact:

```ts
ctx.ui.web.setArtifactAction("download", {
  title: "Download artifact",
  label: "Download",
  invoke: ({ name }) => ({ download: { filename: name } }),
});
```

The repo includes this as an installable example at [`examples/pi-web-extensions/download-artifact.ts`](../examples/pi-web-extensions/download-artifact.ts).

Omit `kinds` and `extensions` to show the action on every artifact preview. Clear it with:

```ts
ctx.ui.web.setArtifactAction("publish", undefined);
```

## Git panel tab API

`ctx.ui.web.setGitTab(key, tab)` contributes a provider-specific tab to pi-web's built-in Git side panel. Core pi-web owns the Git drawer; extensions own provider detection, data fetching, and trusted HTML rendering.

Elements inside the HTML can call back into the extension by using `data-web-git-tab-action` and optional JSON in `data-web-git-tab-payload`. An action can also return `composerContext` without `html`; pi-web keeps the current tab visible and adds the plain-text context as a removable composer pill. The context content is included with the next prompt.

```ts
ctx.ui.web.setGitTab("github", {
  title: "GitHub",
  label: "GitHub",
  render: async (event) => {
    if (event?.action === "attach-issue") {
      return {
        composerContext: {
          id: "github:owner/repo:issue:123",
          label: "GitHub issue #123",
          title: "Fix the mobile layout",
          content: "GitHub issue: owner/repo#123\n...full issue details...",
        },
      };
    }
    return {
      html: `<button data-web-git-tab-action="attach-issue" data-web-git-tab-payload='{"number":123}'>#123</button>`,
    };
  },
});
```

Clear a Git panel tab by passing `undefined`:

```ts
ctx.ui.web.setGitTab("github", undefined);
```

## Settings API

`ctx.ui.web.registerSettings(schema)` contributes a settings panel to pi-web's
settings drawer. Core pi-web owns storage, validation, and rendering; the
extension owns the schema and reacts to changes. Values are **global** (shared by
every session) while the schema registration is **per session**, and they persist
after the extension unloads.

```ts
pi.on("session_start", async (_event, ctx) => {
  await ctx.ui.web.registerSettings({
    id: "my-ext.prefs",          // namespaced: <extension>.<schema>
    title: "My extension",
    schemaVersion: 1,
    fields: [
      { key: "enabled", type: "toggle", label: "Enabled", default: true },
      { key: "model", type: "select", label: "Model", optionsSource: "models" },
    ],
    onChange: (values) => applyPreferences(values),
  });

  const { values } = await ctx.ui.web.getSettings("my-ext.prefs");
});
```

Field types are `toggle`, `text`, `textarea`, `number`, `select`, and `list`
(a repeater with `itemFields`). Constraints include `required`, `min`/`max`,
`minLength`/`maxLength`/`pattern`, `minItems`/`maxItems`, and
`uniqueCaseInsensitive`. Validation errors render inline and are announced to
screen readers.

`select` options come from static `options`, from the live model registry with
`optionsSource: "models"`, or from another field with
`optionsFromField: "<listKey>.<itemKey>"`. When a top-level `select` references a
list column this way, pi-web renders it as a per-row "default" star on that list
instead of a separate dropdown. List rows carry a stable hidden `__id`, so
renaming a row keeps references intact.

Storage notes:

- Values are stored under `extensions[id]` in pi-web settings as
  `{ schemaVersion, revision, values, backup? }` and are carried through
  verbatim, so an unloaded extension never loses its configuration.
- Writes are validated against the live schema and use an optimistic `revision`
  guard, so concurrent edits from two browsers cannot silently drop fields.
- Bump `schemaVersion` and supply `migrate(oldValues, oldVersion)` to upgrade
  stored values. A failed migration falls back to defaults and keeps a one-slot
  `backup`.
- Owners with stored values but no live registration render as a read-only
  "data retained" card.

## Example: GitHub PRs and issues tab

The repo includes an opt-in GitHub extension example at [`examples/pi-web-extensions/github-repo-panel.ts`](../examples/pi-web-extensions/github-repo-panel.ts). It adds a **GitHub** tab to the built-in Git drawer for repositories with GitHub remotes. The extension uses the `gh` CLI to list and view pull requests and issues.

This example is shipped as source for discovery and sharing, but it is **not enabled by default**. Install it by copying or downloading the file into a pi-web extension directory.

Prerequisite:

```sh
gh auth status
```

Install for one project:

```sh
mkdir -p .pi/web/extensions
cp examples/pi-web-extensions/github-repo-panel.ts .pi/web/extensions/github-repo-panel.ts
```

Install globally from a checkout of this repo:

```sh
mkdir -p ~/.pi/web/extensions
cp examples/pi-web-extensions/github-repo-panel.ts ~/.pi/web/extensions/github-repo-panel.ts
```

Install globally from GitHub without cloning the repo:

```sh
mkdir -p ~/.pi/web/extensions
curl -fsSL https://raw.githubusercontent.com/ashwin-pc/pi-web/main/examples/pi-web-extensions/github-repo-panel.ts \
  -o ~/.pi/web/extensions/github-repo-panel.ts
```

Update by running the same `cp` or `curl` command again. Disable it by deleting the copied file and reloading/restarting pi-web:

```sh
rm ~/.pi/web/extensions/github-repo-panel.ts
```

## Example: live git footer

The repo includes a complete pi-web extension example at [`examples/pi-web-extensions/git-footer.ts`](../examples/pi-web-extensions/git-footer.ts). It renders the current branch and live dirty/clean state, refreshes periodically, and also refreshes around turns, bash commands, and compaction events.

Install it for one project:

```sh
mkdir -p .pi/web/extensions
cp examples/pi-web-extensions/git-footer.ts .pi/web/extensions/git-footer.ts
```

Or install it for all pi-web projects:

```sh
mkdir -p ~/.pi/web/extensions
cp examples/pi-web-extensions/git-footer.ts ~/.pi/web/extensions/git-footer.ts
```

Reload pi-web resources with `/reload`, or restart pi-web if you are adding the extension while sessions are already live.

## Example: multi-agent session orchestration

The repo includes a session-orchestration extension at
[`examples/pi-web-extensions/session-orchestrator.ts`](../examples/pi-web-extensions/session-orchestrator.ts).
It lets one session spawn, monitor, steer, and interrupt other sessions, turning
pi-web into a multi-agent workspace where each worker is a **normal, fully
visible session** in the sidebar rather than a hidden subagent.

It registers five tools — `sessions_spawn`, `sessions_status`, `sessions_read`,
`sessions_prompt`, `sessions_abort` — and a zero-token background poller that
delivers a wakeup message when a worker goes idle, so the parent never polls.
Worker models are chosen from user-authored **categories** (name + "when to use"
prose + a model) configured through the Settings API above; the concrete model
mapping stays private to the config and the spawn tool resolves it fail-closed.

pi-web renders the orchestration state generically: spawned sessions are
indented under their parent in the session drawer, a waiting indicator shows
while a session's workers run, wakeups render as notification cards, and both the
spawn tool card and wakeup card link to the worker session.

Install the extension into a pi-web extension directory, and the companion skill
into a pi skills directory:

```bash
cp examples/pi-web-extensions/session-orchestrator.ts .pi/web/extensions/session-orchestrator.ts
cp -r examples/pi-web-skills/session-orchestration ~/.pi/agent/skills/session-orchestration
```

The skill at
[`examples/pi-web-skills/session-orchestration/SKILL.md`](../examples/pi-web-skills/session-orchestration/SKILL.md)
teaches the delegation loop: what to delegate, how to write self-contained worker
tasks, how to pick a category, and why ending your turn while workers run is
correct.
