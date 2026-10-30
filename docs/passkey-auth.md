# Human authentication and machine credentials

pi-web has one access policy and a set of enabled sign-in methods. Methods are alternatives, not MFA factors. This remains a single-owner application: every authenticated human session may manage its security settings. API tokens cannot manage human credentials.

## Upgrade: proxies that rewrite Host

Set `PI_WEB_AUTH_ORIGIN` to the exact public origin. Browser Origin checks do not trust the caller's `Host` header and an explicitly configured public HTTPS origin has no alternate authorities. Plain HTTP local development also accepts the canonical loopback aliases (`localhost`, `127.0.0.1`, and `::1`) only with the configured port. For compatibility while the configured origin is local HTTP, exact peers in `PI_WEB_AUTH_PROXY_PEERS` may supply one strictly parsed `X-Forwarded-Host` authority (no chains). The same canonical IP trust applies to X-Forwarded-For, including IPv4-mapped IPv6 sockets. Proxies must overwrite caller-supplied forwarding headers; restrict direct backend access. Untrusted forwarding headers never authorize an origin. Browser mutations require the configured origin (or same-origin Fetch Metadata), while Bearer API clients remain origin-independent.

## Configuration and migration

```sh
PI_WEB_AUTH_POLICY=authenticated
PI_WEB_AUTH_METHODS=passkey,password
PI_WEB_AUTH_ORIGIN=https://my-machine.example.ts.net
# Optional, defaults to the origin hostname:
PI_WEB_AUTH_RP_ID=example.ts.net
```

- Policies: `authenticated` requires a human session or permitted machine credential; `open` deliberately permits unauthenticated access. Open policy does not manufacture an owner session or permit unauthenticated security mutations.
- Methods: `passkey`, `password`, `external`. Enabling a method does not create its credential.
- `PI_WEB_AUTH_MODE` remains a compatibility input for `none`, `passkey`, and `external`. Canonical environment variables override the translated defaults.
- Once Settings or bootstrap writes canonical configuration, that saved configuration is authoritative across restarts; changing the old mode variable does not silently restore a retired method. Startup prints a warning on environment/store disagreement and when no login method is usable. Use Settings for subsequent method changes, or terminal recovery when locked out.
- External mode without a trusted identity header fails closed. Use an explicit open policy if unauthenticated access is genuinely intended.

Use HTTPS for remote access and set the exact public origin, including the public port when nonstandard. Localhost HTTP is supported for local setup and WebAuthn, but a plain HTTP local session must explicitly declare its loopback `PI_WEB_AUTH_ORIGIN`; an omitted origin produces Secure cookies even when the listener is on loopback. This fail-closed default is necessary because a TLS-terminating reverse proxy can also connect to a loopback listener. IP-address RP IDs are not portable across authenticators. The supervisor supplies its public localhost origin by default. Configure the real public origin when using a reverse proxy.

### Migrate a legacy installation

Legacy token authentication, `PI_WEB_AUTH_MODE=legacy`, the `legacy` method, token query URLs, and browser token storage are removed. Startup fails closed when environment or saved store configuration still enables them. A leftover `PI_WEB_TOKEN` is ignored with a warning only when a valid saved canonical configuration already proves legacy authentication was retired; it never authorizes a request and should still be unset.

1. Unset `PI_WEB_TOKEN` and remove `legacy` from `PI_WEB_AUTH_MODE` or `PI_WEB_AUTH_METHODS`.
2. Run `pi-web auth recover`. This removes the retired saved method and prints a single-use password/passkey setup URL.
3. Open that URL, enroll a password or passkey, and verify normal sign-in at `/api/auth/login`.
4. Create named, expiring `piw_` API tokens for automation. Never place credentials in URLs.

Recovery signs out every legacy-origin browser session, including sessions added through its device grants, and cancels pending grants minted by those sessions. Supported password, passkey, and external browser sessions and named API tokens are preserved.

## First installation and terminal recovery

A genuinely unconfigured first installation defaults to authenticated access. The terminal automatically prints a cryptographically random, single-use, ten-minute setup URL. Visiting the application without that secret does not grant setup authority. Setup supports a password or passkey; successful redemption consumes the grant. It is not a first-visitor claim flow.

```sh
pi-web auth bootstrap                 # New single-use setup link
pi-web auth recover                   # Restore password/passkey setup after lockout
pi-web auth bootstrap --minutes 5
pi-web auth list
pi-web auth credential-revoke <id>
pi-web auth sessions-revoke-all
```

An expired automatic link is not silently regenerated on every restart; use the terminal command. Explicitly configured but unenrolled installations also use the terminal command. Terminal bootstrap/recovery makes both setup ceremonies available without enabling either login method. Only successful enrollment enables the chosen method; recovering a passkey does not restore a retired password method. Resetting a password through recovery revokes existing sessions; enrolling a recovery passkey does not automatically revoke unrelated credentials. Revoke lost credentials/sessions deliberately afterward.

## Password security

Password authentication uses an HTML login form, **not HTTP Basic**. Passwords are 12–1024 characters, salted with 128 random bits and hashed using Node's scrypt (`N=32768`, `r=8`, `p=1`, 64-byte output); hashes encode their parameters. Comparison is timing-safe. Passwords are never returned in security inventory.

Password/external login and password-bootstrap attempts share a bounded per-store, per-peer failure cooldown (100ms escalating to at most two seconds). Request bodies are bounded and read before credential work is admitted. All scrypt work, including password rotation, uses one process-wide slot with short bounded login and credential queues; credential changes take the next available slot so unauthenticated verification traffic cannot crowd them out. Existing N=131072 hashes remain supported. A saturated or timed-out queue returns a retryable failure. Passkey option requests have a per-peer cooldown and quota, and cannot evict another peer's pending ceremony. The peer defaults to the actual socket address. Operators may explicitly set `PI_WEB_AUTH_PROXY_PEERS=127.0.0.1,::1` to trust a proxy that overwrites X-Forwarded-For with exactly one validated client IP. Loopback alone does not imply proxy trust; never enable this unless direct backend access is restricted and the proxy strips supplied headers. Setup validation errors do not consume the credential-failure cooldown. Rate limits are in-memory and reset on process restart. Body size and password length are bounded. Internet-facing deployments should also apply edge rate limiting.

API-token minting and revocation, device-grant minting, revoking another device, password changes, method changes, revoke-all, passkey enrollment and deletion require a credential-backed sign-in within five minutes. The Security page has an explicit sign-in link; sign in, reopen Security, and retry. Grant sessions and historical sessions lacking reauthentication metadata cannot satisfy this gate. This is recent authentication, not MFA. An authenticated browser may set/change the owner password. Rotation revokes every *other* browser session and preserves the initiating session; Settings states this policy explicitly. Use **Sign out all devices** when all devices, including the current one, must sign out. Rotation and revoke-all cancel pending device grants and default to revoking all API tokens atomically with the sessions; active token WebSockets are closed by the same store listener. The password view and sign-out confirmation offer a checked **Also revoke API tokens** option. Unchecking it explicitly preserves automation access, including any stolen token: do not uncheck during suspected compromise. API clients may send `revokeApiTokens: false`; omission defaults to secure revocation. Self-revocation/logout needs no recent sign-in. Password setup/change enables password login but a fresh successful password login is required before it qualifies as a verified replacement.

## Shared sessions and device handoff

All human methods use the same persistent, opaque, revocable HttpOnly session cookie. Cookies have SameSite=Lax, a 30-day absolute lifetime, and are Secure by default. Secure is omitted only when an explicit valid HTTP loopback origin and a loopback listener establish a local plaintext session; forwarding headers do not affect this decision. Session secrets are SHA-256 hashed at rest. Explicit reauthentication rotates the cookie and revokes its predecessor. Last-seen tracking is throttled to five-minute writes; it does not extend the absolute expiry.

**Settings → Security** opens a responsive overview, with focused views for passkeys, password changes, device links, API tokens, and advanced sign-in options. Loading and request failures appear inside Security, including on mobile. Passkeys run directly from the public sign-in page; password entry expands in place, and only enabled, ready alternatives are offered. Successful self/all-device revocation and passkey deletion navigate to explicit sign-in; cancellation or failed requests do not claim sign-out.

**Settings → Security → Devices & sessions** lists current/non-current sessions, method (including honest `grant` attribution), browser user-agent description, and last-seen time. The API additionally includes creation, expiry, and peer-address metadata. Old sessions without method metadata remain usable and are presented as unknown. Individual and all-session revocation are supported. `/logout` revokes the current server-side session, not merely local storage. Revoking a passkey signs out all devices.

Single-use, cancellable add-device grants last two minutes and create a normal shared session for the added device, regardless of the owner's sign-in method. A grant becomes unusable when its minting session is revoked/expired. Grant redemption does not count as verifying a replacement authentication method; the added device can enroll its own credential in Settings after an existing-credential sign-in. Enrollment also requires recent authentication so an old/grant session cannot bypass step-up by adding its own passkey first. Grants remain full-owner application access, not a restricted account or MFA factor.

Session-bound WebSocket tickets are checked again at redemption. WebSocket connections close immediately on in-process session revocation; terminal revocations and absolute expiry are picked up within 15 seconds. Sign-out-all advances a shared epoch and closes current sockets for every authentication class, but open-policy and external-auth clients can reconnect immediately while their ambient authorization remains valid; this is connection invalidation, not revocation of those ambient credentials. HTTP checks read current persistent state for every request. Tickets are single-use, hashed in memory, and expire after 30 seconds. Machine-token WebSockets remain separate from the human session inventory but are checked at ticket redemption and closed on token revocation/expiry using the same listener and 15-second sweep.

## Trusted external authentication

```sh
PI_WEB_AUTH_METHODS=external,password,passkey
PI_WEB_AUTH_TRUSTED_HEADER=Tailscale-User-Login
```

External identity is accepted only from the explicitly configured header. The app exchanges it for the same human session cookie; explicit proxy sign-in is also available on the login page. Missing identity does not become an anonymous owner.

**Only enable external authentication when the backend is reachable exclusively through a trusted proxy which removes caller-supplied copies and sets the verified header.** Direct callers, including loopback callers, can forge headers. This release does not infer trust from Tailscale or implement OIDC/GitHub flows. Header selection and network restrictions are server-operator decisions, not unauthenticated web settings.

## Machine credentials and request security

Named, expiring API tokens work through the canonical Authorization-header gate independently of the human methods. Tokens may read security inventory as before, but cannot mutate credentials, issue additional tokens, enroll passkeys, change passwords/methods, delegate devices, or revoke sessions. Token secrets are shown once and stored hashed. They never become browser sessions.

```sh
pi-web auth token-create --name CI --days 30
curl -H 'Authorization: Bearer piw_…' https://host/api/state
pi-web auth token-revoke <token-id>
```

Cookie-authenticated mutations require the app client header and validate supplied Origin against the exact configured public origin. Public authentication POSTs and WebSocket upgrades share this rule. Caller-controlled Host never authorizes a different public Origin. Canonical plain-HTTP loopback aliases with the same port remain available for local development; trusted Forwarded-Host compatibility is limited to explicitly configured proxy peers while the configured origin is local HTTP. Revoked cookies keep failing ordinary API requests; challenge redirects them to explicit sign-in, and CSRF-checked logout can always clear them. WebAuthn independently verifies the exact origin and RP ID and requires user verification. Registration challenges for Settings are bound to the initiating session. Bootstrap secrets embedded in pages are script-escaped; setup pages prevent framing/referrer leakage. Query credentials are never accepted for WebSocket upgrades.

Supervisor restart/status authorization runs the same canonical store-backed kernel directly, independent of child liveness. There is no permanent token fallback. Restart requires POST and cookie mutations require CSRF validation. Use a named API token (`Authorization: Bearer piw_…`) for scripted restarts; revoked API tokens fail immediately. Store read failures fail closed.

Passkey options are limited per peer and globally. A distributed burst that fills all 256 pending ceremony slots can temporarily reject new options until a ceremony completes or its 120-second challenge expires.

## Storage, isolation, and validation

The store defaults to `~/.pi/agent/web/auth.json`; override with `PI_WEB_AUTH_STORE`. Files are atomically replaced with mode 0600. A per-store exclusive directory lock serializes server/CLI writes and safely recovers locks left by dead modern writers. The lock is installed already populated with a unique immutable owner record, so cleanup cannot unlink a replacement writer's record. After all writers are upgraded, a valid regular-file PID lock left by a confirmed-dead older writer is migrated automatically; live and malformed older records remain fail-closed. Mixed-version writers sharing a store are unsupported, so upgrade all of them together: an unpatched writer still uses the older file protocol and can race outside the guarantees of the populated-directory protocol. The in-process write backlog is bounded, and no-op mutations skip the file replacement and listener cycle. The default store is intentionally shared: multiple instances using it observe policy/method and revocation changes live. Set a different `PI_WEB_AUTH_STORE` for every independent dev/production instance.

Tests **never inherit the live auth store or authentication environment**. Every spawned API, supervisor, and Playwright server has a unique temporary store and explicit test policy. Coverage includes kernel/config migration, setup single use, hashing, login limiting, session metadata/revocation, machine restrictions, and a Chromium UI flow using a virtual authenticator for enrollment and passkey login alongside password login.

Validation commands: `npm run typecheck`, `npm run build`, and full parallel `npm test`. Real synced authenticators, backup recovery, reverse-proxy trust configuration, and production TLS still need verification on a secondary instance before live cutover. Nothing in this implementation performs a live cutover automatically.

Passkey deletion deliberately retains the conservative all-session revocation policy: historical sessions and grant descendants lack credential lineage. Credential-specific revocation would need a versioned lineage migration and is not claimed here. Successful self-revocation clears the cookie. Logout failures retain visible auth state and report that the server session may remain active; the UI never claims server logout after HTTP/network failure.
