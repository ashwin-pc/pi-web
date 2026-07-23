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
