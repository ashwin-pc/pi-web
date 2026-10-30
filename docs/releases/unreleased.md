# Unreleased

## Upgrade actions

- If you open pi-web through a hostname, set `PI_WEB_AUTH_ORIGIN` to the exact public HTTPS origin, including a nonstandard port. Automatic matching-Host trust is limited to canonical `localhost` and IP-literal addresses. Rejected browser mutations and WebSocket upgrades return a remediation message and log the required setting once. pi-web supports one exact public origin because browser sessions and WebAuthn credentials share one relying-party origin.
