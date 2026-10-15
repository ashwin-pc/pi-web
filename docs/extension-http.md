# Scoped HTTP access for server-side extensions

Trusted pi-web extensions can use the existing HTTP API without a browser cookie,
`PI_WEB_TOKEN`, or a user-created integration token. Core issues short-lived,
in-memory credentials and enforces their scope in the normal authentication gate.
There is no HTTP endpoint for issuing these credentials and no implicit localhost
trust exemption.

## Using the client

The factory lives on the existing server-side `ctx.ui.web` bridge; its historical
`ui` namespace does **not** mean it is available to browser JavaScript. Detect the
optional facility when supporting older pi-web releases.

```ts
import type { PiWebExtensionAPI, PiWebHttpClient } from "@ashwin-pc/pi-web/extensions";

export default function example(pi: PiWebExtensionAPI) {
  let client: PiWebHttpClient | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.ui.web.createApiClient) throw new Error("Update pi-web for scoped HTTP access");
    client = ctx.ui.web.createApiClient({
      name: "example.workers",
      scopes: ["sessions.create", "sessions.read", "sessions.write"],
    });
  });
  pi.registerCommand("worker", {
    handler: async () => {
      if (!client) throw new Error("Extension runtime has not started");
      const response = await client.request("POST", "/api/sessions/new", { body: {} });
      if (!response.ok) throw new Error(`Create failed (${response.status})`);
      const { sessionId } = await response.json();
      await client.request("POST", "/api/prompt", {
        body: { sessionId, message: "Inspect this workspace" },
      });
    },
  });
  pi.on("session_shutdown", () => { client?.dispose(); client = undefined; });
}
```

The client accepts `GET`/`POST`, a relative `/api/` path, an optional JSON `body`,
and an optional abort `signal`. It returns a normal `Response`; HTTP errors are
not silently retried. Missing `sessionId` defaults to the calling **agent** session,
not the active browser tab. No caller-supplied Authorization, Cookie, arbitrary
URL, or redirect is accepted. The transport connects to this child application's
loopback HTTP listener, not the public supervisor/proxy. Loopback or wildcard
binding is required (the default is supported; IPv6 loopback is also supported).

The address and actual port come from the listening socket (including `localhost`
resolving to IPv6 and IPv4/IPv6 wildcard binds). Clients may be created before
listening; requests made before listening fail explicitly and can be retried after
startup. Non-loopback, non-wildcard listeners are unsupported.

The verifier also requires a loopback socket peer (IPv4, IPv6 or IPv4-mapped IPv6),
without trusting `Forwarded` or `X-Forwarded-For`. This is defense in depth, not
proof of the original caller: a reverse proxy connecting over loopback presents a
loopback peer even for remote users. Do not forward `PiWebExtension` credentials
through public proxies; credentials remain the authentication boundary.

For least-privilege work on the owning session, omit create/delete and `sessionIds`:

```ts
const client = ctx.ui.web.createApiClient!({
  name: "example.local-helper",
  scopes: ["sessions.read", "sessions.write"],
});
await client.request("GET", "/api/messages");
await client.request("POST", "/api/session/name", { body: { name: "Reviewed" } });
```

## Scope and target policy

| Scope | Exact permitted HTTP operations |
| --- | --- |
| `sessions.read` | GET `/api/state`, `/api/messages`, `/api/messages/image`, `/api/session/reference`, `/api/session/history`, `/api/models` |
| `sessions.create` | POST `/api/new-chat`, `/api/sessions/new` |
| `sessions.write` | POST `/api/prompt`, `/api/abort`, `/api/session/completion`, `/api/session/name`, `/api/model`, `/api/session-ui-state/read` |
| `sessions.delete` | POST `/api/sessions/delete` |

All other route/method combinations are denied, including auth management,
bootstrap/logout, API-token minting, settings mutation, restart, mock endpoints,
artifacts and WebSocket ticket issuance. This first version is an intentionally
small route catalogue; new API families need explicit core policy and tests.

By default, targets are the calling agent session plus sessions created by this
client. A successful creation adds its id on the **server**, not on the strength of
a caller-provided lineage claim. `sessionIds: [id, ...]` adds explicit targets;
`sessionIds: "all"` requests instance-wide session operations. Orchestration uses
`all` because its tools deliberately operate on user-selected sessions and restored
workers as well as newly spawned children. Neither route scope nor target scope is
inferred from UI focus. Both are checked server-side even for a copied credential.
GET routes accept a single `sessionId`. The exact-reference route additionally
accepts one `entryId`; `/api/session/history` requires exactly one UUID `dispatchId`;
`/api/messages/image` requires one bounded `imageId`;
`/api/messages` permits the optional `images=inline` compatibility selector.
Unknown or duplicate selectors are rejected. POST routes accept no query
parameters. Browser viewer identity headers are rejected, and extension requests
never acquire or move browser viewer leases (including body `clientId`).

Target restrictions are **not filesystem restrictions**: `sessions.create` accepts
an arbitrary existing, accessible `cwd`, not just the owning session's workspace.
Combining create and write allows starting a session there and executing prompts
with its normal agent/tool authority. This deliberately preserves cross-worktree
orchestration; use only trusted extensions and tasks.

Installed extensions already execute trusted local code. They may request any
of this finite catalogue; there is not a new administrator consent screen or
per-package allowlist. The caller-provided `name` is a diagnostic label, **not
verified package provenance**. Access logs include the core-bound parent agent
session and this label, never the credential. Scopes limit the supported API and
credential blast radius; they do not sandbox malicious in-process extensions,
prevent prompt-driven code execution, or introduce multi-user resource ownership.

## Admission, interruption, and completion receipts

These opt-in contracts are intentionally narrower than general inter-agent
messaging. They work without the Notepad example or browser viewer identity.
Older hosts may not support them; fail closed rather than treating HTTP 202 or
`await pi.sendMessage(...)` as proof that a message was saved.

### Prompt admission and consumption

`POST /api/prompt` retains its existing asynchronous **202** response by default.
Add `waitFor: "admission"` to wait for SDK preflight and receive **200** with
`{ ok: true, sessionId, admission: "accepted", dispatchId? }`. Rejected preflight
returns a non-success response; this does not wait for the whole agent run.
Streaming acceptance means the prompt entered the SDK memory queue, not that it
was consumed or persisted. A request timeout or client disposal is not proof that
an already admitted operation was canceled.

An optional UUID `dispatchId` causes the host to append exactly
`\n\n[pi-web-dispatch:<dispatchId>]` to the message text **before serializing the
attachment fence**, and echo that ID in the receipt. Attachments therefore remain
parseable. This marker is visible to the model. Find the actual saved **user** entry
containing that marker before treating later assistant replies as this task's
result. A transcript snapshot taken before admission is not a consumption
watermark: an older task can finish while the new prompt remains queued. Extension
commands or input handlers can consume a prompt without producing that user
entry; admission alone never makes an old final reply eligible.

Use `GET /api/session/history?sessionId=<id>&dispatchId=<uuid>` for compaction-safe
correlation. It returns `{ ok: true, messages }` in the usual simplified message
shape (including entry IDs), starting at the actual matching user entry on the
**uncompacted active branch**. An absent marker yields `messages: []`; alternate
branches are never searched. Unlike `/api/messages`, compaction cannot hide the
dispatch boundary. Inline image bytes are omitted, not replaced with invalid
compacted-history image URLs. Raw session-manager entries can still be memory-only
before their first disk flush: this route proves consumption/lineage, not the
on-disk completion receipt described below.

### Awaiting abort

`POST /api/abort` retains **202** by default. Add `waitFor: "idle"` for **200** with
`{ ok: true, sessionId, idle: true }` only after the local SDK abort settles.
Failures propagate. This waits for both SDK interruption and previously admitted
host operations; it does not wait for recursively tracked workers to settle and
does not clear queued human or agent steering. An interrupt-and-redirect caller
should await this receipt instead of sleeping for a fixed duration. A bounded
wait that cannot establish safety returns **503** with `recoveryRequired: true`,
never `idle: true`; callers must not redirect in that case.

Ordinary Stop/abort still releases visible work leases when the SDK is idle, so a
hung preflight/navigation hook no longer leaves the UI falsely running. Separate
safety ownership remains until the operation actually finishes. A canceled prompt
still **awaiting preflight**, or canceled navigation/custom-message work, fences
same-runtime mutations with **409** and `recoveryRequired: true`. Reads and Stop
remain available, as does starting an independent session. Once a prompt was
successfully admitted in its original cancellation epoch, its slow-to-abort agent
run does **not** globally block independent steer/follow-up prompts, model changes,
or renaming. Its full operation still blocks history navigation/Retry and defers
completion injection until actual settlement, even if streaming briefly appears
idle. An admitted completion request can therefore remain durably pending during
that interval rather than being injected into a canceled run.

A cancellation epoch prevents late **idle** prompt preflight from starting an
agent run. A captured streaming submission may instead already have enqueued
before its callback, so the host conservatively fences ambiguous **user** queue
ownership. That latch recovers without disposal when the SDK explicitly reports
idle and its pending **user-message** count is exactly zero (an unavailable count
is not proof). Admission checks, SDK events, and awaited idle receipts re-evaluate
this condition. A still-pending canceled preflight remains separately fenced:
observing an empty queue cannot authorize another mutation while an old input
handler could yet enqueue. The user count excludes custom messages and never
releases the completion outbox's independent submission/disk-persistence claims.

Arbitrary JavaScript hooks cannot be forcibly canceled through the SDK. If a
preflight/navigation/custom-message hook never settles, recover by restarting the
server process (the stalled-runtime issue remains separate), not by clearing
safety ownership and overlapping old work.

Disposal waits are also bounded (`PI_WEB_OPERATION_SETTLE_TIMEOUT_MS`, default
10 seconds). Failure resets the closing flag and leaves reads/retry-disposal
available. A timed-out retirement keeps its original promise/runtime and pending
claims; no replacement can replay while old hooks may still persist. A later
successful settlement completes that same retirement.

### Idempotent completion delivery

Send a custom completion message through `POST /api/session/completion`:

```ts
const payload = {
  sessionId: parentId,
  deliveryId: "worker-id:dispatch-id:completion",
  branchAnchorEntryId: savedParentWatchEntryId, // optional; actual branch entry ID
  message: {
    customType: "worker-wakeup",
    content: "Outcome: finished\\nVerified: tests passed",
    display: true,
    details: { workers: [{ sessionId: workerId }] },
  },
};
const response = await client.request("POST", "/api/session/completion", { body: payload });
// { ok: true, sessionId, deliveryId, state: "pending" | "saved", entryId? }
```

Repeat the **same ID and immutable payload**, including any branch anchor, to
retrieve its current receipt or retry delivery. Reusing an ID with another payload
returns **409**. `deliveryId` is 1–160 ASCII letters, digits, `.`, `_`, `:`, or `-`;
`customType` uses the same characters with a 100-character limit. Content must be a
nonempty string, display a boolean, and optional details an object. The normalized
JSON payload is limited to 64 KiB. The host adds `details.deliveryId`; a conflicting
caller-supplied value is rejected. Accepted receipt lookups return **200** even
when still pending.

Core first persists an independent outbox record beside the session file, in
`<session-file>.completions/`, using private file permissions and atomic writes.
File data is fsynced before rename. Directory metadata is fsynced where supported;
Windows rejects some directory-handle/fsync operations, so the host tolerates only
those explicitly unsupported Windows errors (power-loss rename durability then
depends on the filesystem). File write/fsync/rename errors still fail the request.
The SDK may keep even appended entries only in memory before its first assistant
message, so **only a matching custom message observed in the actual session JSONL
file** yields `saved` and an `entryId`. A bounded disk index scans only appended
bytes (plus a small boundary check), invalidating on file replacement, truncation,
or same-size rewrite; unchanged receipt polls do not reread the transcript.
Pending is not a delivery acknowledgement.
Keep the watch and durable pending payload until saved. Saved records are retained
for deduplication; receipt lookup does not delete them.

A host/raw-runtime-scoped claim prevents extension reloads or concurrent retries
from submitting another copy of a surviving queued message. On runtime replacement
or restart, core checks disk before replaying persisted records. Owned runtime
disposal awaits SDK abort/idle and operation-owned host preflight/navigation work
before replacement, so an in-flight message-end hook
cannot save an old copy after replay begins. Delivery means one saved completion,
not exactly-once model execution or proof that the model read it.

When `branchAnchorEntryId` is supplied, core checks that exact entry is on the
active branch immediately before SDK submission. Missing anchors leave the record
pending without injection. Host history navigation is blocked while session work
(including custom-message preflight) is active or a submitted completion remains
unsaved, even if the SDK briefly reports idle. Abort may release visible leases,
but does not erase separate operation-owned safety fences before their owners finish. Completion submission is deferred
while host navigation is already in progress. Use a persisted watch/dispatch
anchor, not merely the last user entry. Returning to the intended branch and
repeating the unchanged request retries it.

**Recovery limitations:** arbitrary trusted extensions can directly mutate the raw
SDK runtime outside these host boundaries. If a third party clears its queues, or
custom-message submission rejects after an ambiguous partial operation, core keeps
the receipt pending and its runtime claim rather than risk duplicate delivery.
Replace the raw runtime to replay safely after disk reconciliation; extension reload
alone is not replacement. Core never clears queues just to reconcile delivery,
since doing so could discard human steering. Direct raw history navigation is
likewise outside the host branch guarantee. A stalled runtime still requires the
separate runtime-recovery mechanism; a pending receipt must not be called saved.

## Transcript images

By default, `GET /api/messages` replaces embedded image `data` fields in
`raw.content` with `imageUrl` references, retaining `type` and `mimeType`. Fetch
those relative URLs with the same scoped client; each response returns the image
bytes. Both history and image reads require `sessions.read`, and the usual
session-target restrictions apply to both routes. Only raster image MIME types
are served, with `nosniff` and `no-store` headers. References are content-addressed
and may return 404 after history navigation or edits; refresh history in that case.

```ts
const history = await client.request("GET", "/api/messages");
const { messages } = await history.json();
for (const message of messages) {
  for (const block of message.raw?.content || []) {
    if (block.type === "image" && block.imageUrl) {
      const image = await client.request("GET", block.imageUrl);
      if (image.ok) await image.arrayBuffer(); // process the original image bytes
    }
  }
}
```

Clients that still need embedded base64 image data can request
`GET /api/messages?images=inline`. Live tool events retain their existing image
representation. Transcript JSON negotiates gzip via `Accept-Encoding`; a normal
fetch `Response` exposes the decoded body.

## Credentials and lifecycle

- A dedicated `PiWebExtension` Authorization scheme is resolved by the same auth
  kernel. It never falls through to open, legacy, browser-session or API-token auth.
- Secrets are generated by core, kept inside the client closure and stored hashed
  in the in-memory verifier. They never enter the auth store, browser contributions,
  environment, query strings, transcript or settings inventory.
- Credentials expire after five minutes; a still-active client renews lazily before
  expiry, without a network login or a user-managed refresh token. Previous
  credentials overlap only until their original expiry for in-flight requests.
- `dispose()` revokes the client's credentials immediately and aborts its pending
  requests. Core additionally invalidates clients when the SDK runner changes on
  reload, the agent session is disposed, or the server restarts. A new runtime must
  obtain a new client. Already-authorized application operations may finish;
  revocation is not a transactional cancellation of work already admitted.
- Browser logout does not cancel an admitted agent run or invalidate its extension
  clients. Stop/cancel the agent work separately. Internal credentials cannot be
  used to manage browser credentials or request supervisor restart.
- Requests have a 20-second timeout, redirects are rejected, and there is no
  automatic retry of mutations. Client count is bounded (32 per session, 1024 per
  instance); explicit target lists are bounded, and default created-target sets
  stop admitting creations at 4096 entries rather than silently widening access.
  Rejections return 403 and emit a static server warning naming the limit and
  recovery (dispose/recreate the client); no secret, target id or request data is
  logged. Recreated clients no longer automatically target the old children.

## Orchestration migration

The bundled `session-orchestrator.ts` now uses this factory rather than fetching
localhost with `PI_WEB_TOKEN`. It works with passkey/password-only deployments and
needs no additional setup. It explicitly declares session read/create/write/delete
scopes and cross-session access, disposes the client during `session_shutdown`,
and gives an actionable error on older hosts instead of restoring legacy auth.
These tools are model-callable authority, not merely extension-internal plumbing:
prompt injection in task text or material read by the model can influence their use.
With `sessionIds: "all"`, read/write can inspect or steer unrelated sessions; delete
can remove sessions across the instance. Delete is retained for existing rollback
cleanup when a worker spawn fails, rather than silently breaking that behavior.
Extensions that do not need those powers should use default targets and omit
create/delete, as in the least-privilege example above.
Update both core and the installed extension, then reload extensions. Existing
copied versions will not change automatically; symlinked examples follow checkout
updates. No live restart or configuration change is performed by this feature.

Named API tokens remain the mechanism for **external** integrations. Browser
sessions remain the mechanism for human login. Extension credentials are internal,
core-managed capabilities with a separate lifecycle, not another login method.
