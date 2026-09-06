# Human authentication and machine credentials

pi-web has one access policy and a set of enabled sign-in methods. Methods are alternatives, not MFA factors. This remains a single-owner application: every authenticated human session may manage its security settings. In particular, an existing valid legacy browser session is explicitly authorized to enroll the first or additional passkey/password. API tokens cannot do this.

## Configuration and migration

```sh
PI_WEB_AUTH_POLICY=authenticated
PI_WEB_AUTH_METHODS=legacy,passkey,password
PI_WEB_AUTH_ORIGIN=https://my-machine.example.ts.net
# Optional, defaults to the origin hostname:
PI_WEB_AUTH_RP_ID=example.ts.net
```

- Policies: `authenticated` requires a human session or permitted machine credential; `open` deliberately permits unauthenticated access. Open policy does not manufacture an owner session or permit unauthenticated security mutations.
- Methods: `passkey`, `password`, `legacy`, `external`. Enabling a method does not create its credential.
- `PI_WEB_AUTH_MODE` remains a compatibility input, translated once through the same configuration path: `none` → open/no methods; `legacy`, `passkey`, `external` → authenticated/the corresponding method. Canonical environment variables override the translated defaults.
- Once Settings or bootstrap writes canonical configuration, that saved configuration is authoritative across restarts; changing the old mode variable does not silently restore a retired method. Startup prints a warning on environment/store disagreement and when no login method is usable. Use Settings for subsequent method changes, or terminal recovery when locked out.
- Explicit legacy mode without a token, and external mode without a trusted identity header, now fail closed. Use an explicit open policy if unauthenticated access is genuinely intended.

Use HTTPS for remote access and set the exact public origin, including the public port when nonstandard. Localhost HTTP is supported for local setup and WebAuthn; IP-address RP IDs are not portable across authenticators. The supervisor supplies its public localhost origin by default. Configure the real public origin when using a reverse proxy.

### Retire legacy deliberately

1. Retain the current token and browser session while installing the release.
2. In **Settings → Security**, add a password and/or passkey. Enrollment automatically enables that method. Keep a backup credential and terminal access.
3. Open `/api/auth/login` in another browser and successfully sign in with the replacement. The settings inventory shows verified-login status. Password changes reset that method's verified status.
4. Disable `legacy` in Sign-in methods. Retirement is rejected unless a remaining enabled, enrolled method has a verified login.
5. Remove the server's legacy token environment variable when convenient. Existing human sessions remain valid until explicitly revoked; legacy is not a fallback after disabling it.

The deprecated token overlay and token-URL exchange remain available for legacy-only installations. Only the app's state request exchanges that credential for a browser session; ordinary curl requests do not mint sessions. A revoked cookie cannot silently reauthenticate through a saved token or ambient proxy header: use the explicit sign-in form to sign in again.

## First installation and terminal recovery

A genuinely unconfigured first installation (no explicit authentication configuration, credentials, sessions, API tokens, or legacy token) defaults to authenticated access. The terminal automatically prints a cryptographically random, single-use, ten-minute setup URL. Visiting the application without that secret does not grant setup authority. Setup supports a password or passkey; successful redemption consumes the grant. It is not a first-visitor claim flow.

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

Password/legacy/external login and password-bootstrap attempts share a bounded per-store, per-peer failure cooldown (100ms escalating to at most two seconds), with at most one concurrent login handler. All scrypt work, including password rotation, has a single process-wide slot; existing N=131072 hashes remain supported, bounded to one verification at a time. A busy slot returns a retryable failure rather than queuing unbounded work. The peer defaults to the actual socket address. Operators may explicitly set `PI_WEB_AUTH_PROXY_PEERS=127.0.0.1,::1` to trust a proxy that overwrites X-Forwarded-For with exactly one validated client IP. Loopback alone does not imply proxy trust; never enable this unless direct backend access is restricted and the proxy strips supplied headers. Rate limits are in-memory and reset on process restart. Body size and password length are bounded. Internet-facing deployments should also apply edge rate limiting.

Password changes, method changes, revoke-all, passkey enrollment and deletion require a credential-backed sign-in within five minutes. The Security page has an explicit sign-in link; sign in, reopen Security, and retry. Grant sessions and historical sessions lacking reauthentication metadata cannot satisfy this gate. This is recent authentication, not MFA. An authenticated browser may set/change the owner password. Rotation revokes every *other* browser session and preserves the initiating session; Settings states this policy explicitly. Use **Revoke all sessions** when all devices, including the current one, must sign out. Password setup/change enables password login but a fresh successful password login is required before it qualifies as a verified replacement.

## Shared sessions and device handoff

All human methods use the same persistent, opaque, revocable HttpOnly session cookie. Cookies have SameSite=Lax, a 30-day absolute lifetime, and Secure when the configured public origin is HTTPS. Session secrets are SHA-256 hashed at rest. Explicit reauthentication rotates the cookie and revokes its predecessor. Last-seen tracking is throttled to five-minute writes; it does not extend the absolute expiry.

**Settings → Security → Devices & sessions** lists current/non-current sessions, method (including honest `grant` attribution), browser user-agent description, and last-seen time. The API additionally includes creation, expiry, and peer-address metadata. Old sessions without method metadata remain usable and are presented as legacy. Individual and all-session revocation are supported. `/logout` revokes the current server-side session, not merely local storage. Revoking a passkey signs out all devices.

Single-use, cancellable add-device grants last two minutes and create a normal shared session for the added device, regardless of the owner's sign-in method. This is one delegation flow, not separate legacy/passkey implementations. A grant becomes unusable when its minting session is revoked/expired. Grant redemption does not count as verifying a replacement authentication method; the added device can enroll its own credential in Settings after an existing-credential sign-in. Enrollment also requires recent authentication so an old/grant session cannot bypass step-up by adding its own passkey first. Grants remain full-owner application access, not a restricted account or MFA factor.

Session-bound WebSocket tickets are checked again at redemption. WebSocket connections close immediately on in-process session revocation; terminal revocations and absolute expiry are picked up within 15 seconds. HTTP checks read current persistent state for every request. Tickets are single-use, hashed in memory, and expire after 30 seconds. Machine-token WebSockets remain separate from the human session inventory but are checked at ticket redemption and closed on token revocation/expiry using the same listener and 15-second sweep.

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

Cookie-authenticated mutations require the app client header and validate supplied Origin against the actual Host authority or the exact configured public origin. Public authentication POSTs and WebSocket upgrades share this rule. Forwarded-Host is not trusted: proxies must preserve Host or configure the public origin. Revoked cookies keep failing ordinary API requests; challenge redirects them to explicit sign-in, and CSRF-checked logout can always clear them. WebAuthn independently verifies the exact origin and RP ID and requires user verification. Registration challenges for Settings are bound to the initiating session. Bootstrap secrets embedded in pages are script-escaped; setup pages prevent framing/referrer leakage. Query credentials are never accepted for WebSocket upgrades.

Supervisor restart/status authorization runs the same canonical store-backed kernel directly, independent of child liveness. There is no separate permanent legacy-token fallback; saved retirement remains authoritative. Restart requires POST and cookie mutations require CSRF validation. Use a named API token (`Authorization: Bearer piw_…`) for scripted restarts after legacy retirement; revoked API tokens fail immediately. Store read failures fail closed.

## Storage, isolation, and validation

The store defaults to `~/.pi/agent/web/auth.json`; override with `PI_WEB_AUTH_STORE`. Files are atomically replaced with mode 0600. A per-store exclusive lock serializes server/CLI writes. Locks record the writer PID; a confirmed dead PID (ESRCH) is recoverable. Age alone never authorizes stealing a lock; live PIDs, permission-denied liveness checks and malformed/old locks fail closed. Concurrent recovery is serialized with `.lock.recovery`; if a recovery process itself crashes, stop writers and remove its recovery marker. Malformed lock metadata likewise requires operator cleanup. The default store is intentionally shared: multiple instances using it observe policy/method and revocation changes live. Set a different `PI_WEB_AUTH_STORE` for every independent dev/production instance.

Tests **never inherit the live auth store or authentication environment**. Every spawned API, supervisor, and Playwright server has a unique temporary store and explicit test policy. Coverage includes kernel/config translation, setup single use, hashing, login limiting, legacy-authorized enrollment, replacement verification, retirement, session metadata/revocation, machine restrictions, and a Chromium UI flow using a virtual authenticator for enrollment and passkey login alongside password login.

Validation commands: `npm run typecheck`, `npm run build`, and full parallel `npm test`. Real synced authenticators, backup recovery, reverse-proxy trust configuration, and production TLS still need verification on a secondary instance before live cutover. Nothing in this implementation performs a live cutover automatically.

Passkey deletion deliberately retains the conservative all-session revocation policy: historical sessions and grant descendants lack credential lineage. Credential-specific revocation would need a versioned lineage migration and is not claimed here. Successful self-revocation clears the cookie. Logout failures retain visible auth state and report that the server session may remain active; the UI never claims server logout after HTTP/network failure. Security inventory refresh clears retired legacy tokens from localStorage.
