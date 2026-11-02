# Runtime restart after updates

A child restart is not a full application restart. The supervisor owns the public listener and authentication/proxy policy; updating its files does not update the running process.

## Safe fallback (not automatic full-runtime restart)

The supervisor records a conservative startup fingerprint of its source, server modules, launcher and dependency manifests. Before accepting a child restart it checks these files again (five-second preflight deadline). An unreadable, incomplete, or changed installation returns HTTP 409, `FULL_RUNTIME_RESTART_REQUIRED`, and **“Full application restart required; nothing has been stopped.”** Crash recovery uses the same guard. No filesystem checks are added to normal proxy requests or status polling.

- `POST /api/restart/preflight`: same authentication, origin and CSRF requirements as restart; checks child-restart compatibility without stopping anything.
- `POST /api/restart?scope=full` (or preflight with `scope=full`): always reports the manual full-restart requirement. It never kills the supervisor or child.
- `POST /api/restart`: retains explicitly confirmed, potentially interrupting child-only restart semantics when preflight succeeds. Concurrent lifecycle operations receive 409. It is not a session-draining maintenance operation.
- Authenticated `/__supervisor/status` advertises `runtimeProtocol: 1`, `automaticFullRestartAvailable: false`, lifecycle state and crash recovery errors. The UI disables restart for older/unrecognized supervisor protocols. Existing browser replacement-readiness polling remains bounded to 30 seconds.

## Operator activation

These protections only apply after the new supervisor has been started. Updating files under an old supervisor cannot retrofit its restart handler or authentication provenance protocol. Do not use its child restart to cross a supervisor/child protocol boundary.

1. Coordinate a maintenance window with all users. Wait for every active turn and worker to finish; preflight does not drain or lock session admission.
2. Finish and validate the installation before stopping anything. Do not update files concurrently with restart preflight; this is a conservative file identity check, not an atomic deployment transaction.
3. Stop and start pi-web through the original terminal, tmux instance command, or configured service manager. Use the deployment's actual commands; there is no universal service name. Do not merely kill the child. Preserve the original environment and configuration.
4. Verify authenticated supervisor status advertises protocol 1 and the application is ready; check service logs on failure.

Automatic full-runtime replacement remains unavailable: the current launcher only forwards signals and exits with the supervisor. A future implementation needs a stable launcher/service-manager contract, authenticated maintenance consent, session-admission/drain coordination, protocol negotiation, and bounded replacement readiness/rollback reporting. Exiting or self-killing the current parent would not provide those guarantees.
