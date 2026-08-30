# Passkey authentication (preview)

Passkey authentication is additive and disabled by default. Existing installations remain in `legacy` mode, including current `PI_WEB_TOKEN` behavior, until an explicit cutover.

## Configure and enroll

Passkeys require a stable HTTPS origin (localhost HTTP is permitted by WebAuthn). Set these variables for the server:

```sh
export PI_WEB_AUTH_MODE=passkey
export PI_WEB_AUTH_ORIGIN=https://my-machine.example.ts.net
# Optional when it differs from the origin hostname:
export PI_WEB_AUTH_RP_ID=example.ts.net
```

Before switching a live instance, install the release while retaining legacy mode, use a secondary instance/store to verify it, and enroll at least two credentials. Generate each enrollment from a terminal on the server machine:

```sh
pi-web auth bootstrap                 # single-use URL on the configured origin, valid 10 minutes
pi-web auth bootstrap --minutes 5
pi-web auth list
```

`recover` creates the same single-use enrollment primitive on `PI_WEB_AUTH_ORIGIN`. Loopback is additionally required when that origin is localhost; for a remote HTTPS origin, possession of the short-lived token is the enrollment gate and the URL must be opened at that exact origin. After recovery, revoke the lost credential (which also revokes every browser session):

```sh
pi-web auth recover
pi-web auth credential-revoke <credential-id>
```

The auth database defaults to `~/.pi/agent/web/auth.json` (override with `PI_WEB_AUTH_STORE`) and is written atomically with mode `0600`. Credentials, counters, revocations, sessions, and API tokens persist across restarts. Session and token secrets are SHA-256 hashed at rest.

## External proxy identity

In `external` mode, an identity-aware reverse proxy can provide attribution for HTTP and WebSocket requests:

```sh
PI_WEB_AUTH_MODE=external
PI_WEB_AUTH_TRUSTED_HEADER=Tailscale-User-Login
```

When configured, requests missing the header are rejected and authenticated identities are reported as `external:<value>`. Only enable this when pi-web's listening port is reachable exclusively through a proxy that removes caller-supplied copies and sets the verified header itself. Direct callers, including loopback callers, can forge headers.

## Security settings and adding devices

The kernel-owned **Settings → Access & sharing** API exposes the current mode and identity, passkeys, browser devices/sessions, and API tokens. Passkeys and sessions can be revoked individually; passkey revocation signs out every browser session. Newly created API-token plaintext is returned exactly once.

An authenticated browser session can create a two-minute, single-use add-device link/QR. Grants are stored separately from terminal bootstrap/recovery, record the minting session, and can be cancelled before use. In passkey mode redemption enrolls a credential; in legacy mode it creates a device-specific cookie without disclosing `PI_WEB_TOKEN`. Terminal `bootstrap` and `recover` remain first-credential and lockout-recovery tools, not routine sharing.

Security endpoints are under `/api/auth/`: `info`, `security`, `passkeys`, `sessions`, `tokens`, and `device-grants`. Cookie-authenticated mutations use the normal CSRF checks.

## Machine clients

Create named, expiring tokens. The plaintext is printed once and is accepted only in an `Authorization` header in passkey mode:

```sh
pi-web auth token-create --name CI --days 30
curl -H 'Authorization: Bearer piw_…' https://host/api/state
pi-web auth token-revoke <token-id>
pi-web auth sessions-revoke-all
```

API tokens cannot enroll passkeys or become browser sessions. In legacy mode, the SPA's authenticated state request exchanges the configured token for an HttpOnly session cookie so browser-native artifact loads remain authenticated; curl and CI requests without the app client header do not mint sessions.

## Explicit cutover

1. Verify primary and backup passkeys, fresh-browser login, HTTP, WebSocket, artifacts, restart persistence, and recovery on a secondary instance.
2. Set `PI_WEB_AUTH_MODE=passkey`, the stable origin, and RP ID; remove `PI_WEB_TOKEN`; restart through the supervisor.
3. Delete `localStorage["pi-web-token"]` in each old browser.

In passkey mode legacy Bearer and query tokens are rejected. HTTP APIs, artifacts/downloads, and WebSocket upgrades share the same kernel gate. WebSockets require the configured Origin. Cookie-authenticated mutations require the app client header and reject a mismatched Origin.

Other explicit modes are `none` (open) and `external` (trust an authenticated edge). Tailscale alone does not imply `external`; choose it deliberately.

## Milestone scope

This first secure milestone includes the canonical HTTP/WS/artifact gate, WebAuthn registration and authentication, persistent revocable sessions/credentials, terminal bootstrap/recovery, named API tokens, CSRF/WS Origin checks, and explicit legacy-compatible migration. Deliberately deferred follow-up scope is: server-extension strategy loading and GitHub/OIDC strategies; a graphical Devices/settings panel (the terminal commands are the current management UI); non-loopback/no-auth startup interlock; session-cookie rotation beyond sliding last-seen tracking; auth rate limiting; and full browser E2E enrollment coverage using virtual authenticators. The passkey cryptography uses `@simplewebauthn/server`; kernel/storage behavior and the existing authenticated browser projects are automated, while real authenticator enrollment must be verified during cutover.
