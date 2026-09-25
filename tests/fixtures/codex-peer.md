# Synthetic native Codex peer

This executable speaks Codex 0.154.0 app-server JSONL through the **production adapter's stdin/stdout ingress**. It never calls a model or reads native agent homes. It is not a SessionService replacement, and user prompt text never selects a scenario.

```sh
PI_WEB_CODEX_PEER_DIR=/tmp/my-isolated-test node tests/fixtures/codex-app-server-peer.mjs
```

For a pi-web test server, trusted server configuration selects that executable through `PI_WEB_CODEX_COMMAND=<node executable>` and `PI_WEB_CODEX_ARGS='["/absolute/path/to/tests/fixtures/codex-app-server-peer.mjs"]'`. The core service owns those launch options; the fixture does not add HTTP routes.

Each process creates `peers/<pid>/ready.json`, `peers/<pid>/observed.jsonl`, and `peers/<pid>/commands/` under the scratch root. Tests atomically rename numbered JSON command files into `commands/`. Native client requests, server responses/events and control completions are append-only observations. `closed.json` records normal exit. Synthetic materialized native threads persist under `threads/`; ephemeral threads do not. These files contain **synthetic test data only**, never retained real-harness traces or credentials.

## Node helpers

Import from `./codex-peer-control.js` in TypeScript tests:

- `findPeer(root, predicate?)`: locate a live peer by an observed native request/event, not PID order.
- `peerForThread(root, nativeThreadId)`: locate the live peer that created/resumed this native thread.
- `readObserved(peer)`: all `{direction,message}` records.
- `waitObserved(peer, predicate, timeoutMs?)`: wait for a matching record; fixture errors fail promptly.
- `controlPeer(peer, command)`: write a command and await its consumed marker (except `exit`).
- `acceptedTurn(peer, afterTurnId?)`: read `{threadId,turnId}` from the native `turn/started` event.

Example after the real HTTP service has created a Codex session:

```ts
const peer = await peerForThread(root, nativeThreadId);
// Submit ordinary user text through the real browser/API first.
const { turnId } = await acceptedTurn(peer);
await controlPeer(peer, { action: "thinking", delta: "Inspecting the fixture" });
await controlPeer(peer, { action: "tool", itemId: "read", command: "printf synthetic" });
await controlPeer(peer, { action: "tool", itemId: "read", delta: "synthetic output", done: true });
await controlPeer(peer, { action: "text", itemId: "answer", delta: "Hello", done: true });
await controlPeer(peer, { action: "complete" });
```

## Independent control actions

All turn-scoped controls optionally accept explicit `threadId` and `turnId`; otherwise they target the peer's latest native accepted turn.

| Action | Fields / effect |
|---|---|
| `configure` | `prompt: "accept" | "reject" | "defer"`, `interrupt: "complete" | "defer"`; optional explicit `onTurn` control array. No prompt text matching. |
| `accept` | Release the held prompt (optional `requestId`); `reply:false` emits native events while retaining its response for a later `release`. |
| `reject` | Reject held prompt; optional `requestId`, `message`. |
| `release` | Reply to held native request with explicit `result` or `error`. |
| `text` | `itemId?`, `delta`, `done?`; optional final `text` makes completed content authoritative. |
| `thinking` | `itemId?`, `delta`, `summaryIndex?`, `done?`. |
| `tool` | `itemId?`, `command?`, `delta?`, `done?`, `status?`, `exitCode?`; native command item/deltas/result. |
| `approval` | `kind: command | file | permissions | input | mcp`, `requestId?`, `itemId?`, `command?`, `decisions?`, `changes?`, native `params?`. Native accept/decline/cancel replies are captured and resolved; decline leaves the turn active, cancel interrupts it. |
| `complete` | `status: completed | interrupted | failed`, `idle?:boolean`. Terminal turn and thread activity can deliberately remain distinct. Resolves a held exact-turn interrupt. |
| `activity` | Native `status` object, independently of turn settlement. |
| `error` | `message?`, `willRetry?`; does not automatically settle. |
| `emit` | Exact native envelope in `message`, for additive variants, replay/races, scoped requests or unusual native items. |
| `raw` | Raw stdout `text`, for split/malformed/oversized framing tests. |
| `exit` | Abrupt native process exit, `code?` (default 17). |

A native `thread/start` returns effective fixture settings (reasoning **medium**) that deliberately differ from the model catalog default (**low**). Unmaterialized/ephemeral threads reject resume. No native setting is overridden by the production adapter just to make this fixture pass.
