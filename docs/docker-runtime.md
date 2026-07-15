# Docker workspace runtime

pi-web can expose one configured Docker runtime in addition to the normal local runtime. The runtime starts `server/runner.ts` in a container, mounts exactly one host workspace at a fixed container path, and stores pi sessions in a persistent Docker volume. Connecting is a one-time setup; selecting it switches the complete browser-tab workbench—tabs, sessions, folders, model selection, git, artifacts, composer, and tools.

## Network and authentication boundary

Managed Docker runtimes run with `--network none`. They do not need provider network access:

1. The runner sends a typed model request over its existing stdio connection to pi-web.
2. The host validates the provider/model against its authoritative `ModelRegistry`.
3. The host resolves authentication and streams the model response back over stdio.

The broker cannot request arbitrary URLs. Runner-supplied URLs, API keys, headers, environment, signals, and callbacks are not accepted. Model endpoint and authentication are always selected by the host registry. Provider credentials and the pi-web bearer token are never copied or mounted into the container.

Tools inside the runtime have no DNS or internet path, so clearing proxy variables or opening raw sockets cannot bypass the policy. If the broker or stdio connection is unavailable, model calls fail closed.

## Secure expectations

- Set `PI_WEB_TOKEN`; browser/API access remains protected by the normal bearer-token flow.
- Set `PI_WEB_DOCKER_WORKSPACE_HOST` to the only host folder Docker may mount. pi-web does not accept arbitrary host mount paths from API requests.
- The mounted folder appears inside the container as `PI_WEB_DOCKER_WORKSPACE_CONTAINER` (default `/workspace`).
- The pi-web source tree is mounted read-only at `/app` so the container can run the same `server/runner.ts`. The target workspace is a separate mount.
- Set `PI_WEB_DOCKER_READONLY=1` to mount the workspace read-only.
- Runtime-owned session history outlives the disposable `--rm` container in a named volume at `/root/.pi/agent`. Override its name with `PI_WEB_DOCKER_SESSION_VOLUME`. Removing that volume permanently removes the runtime's sessions and runtime configuration.
- `PI_WEB_DOCKER_ENV_ALLOWLIST` has no credential defaults. Avoid passing secrets into a brokered runtime.

## Run

```sh
cd /Users/ashwin/projects/pi-web
PI_WEB_TOKEN="$(openssl rand -hex 24)" \
PI_WEB_DOCKER_WORKSPACE_HOST=/absolute/path/to/repo \
PI_WEB_DOCKER_WORKSPACE_CONTAINER=/workspace \
PI_WEB_DOCKER_IMAGE=node:22-bookworm-slim \
npm run dev
```

Open pi-web, enter the token, connect **Docker workspace** once, and select it from the session drawer's workbench switcher. The complete tab is then scoped to the container and paths resolve under `/workspace`. A different-runtime session requires an explicit workbench switch or another browser tab.

Guided connections to existing Docker/Podman containers are accepted only when inspection confirms `--network none`. An internal bridge is not sufficient because its embedded DNS resolver may still become an egress channel. Apple containers require both a `hostOnly` internal network and `--no-dns`; this is reported honestly as `host-only` because services on the host gateway remain reachable. Container identity is pinned, engine socket mounts are rejected, and isolation is rechecked before each runner spawn. Advanced custom command runtimes are marked as unverified because pi-web cannot prove their network posture.

Every connection requires an explicit model-access decision with no default: **host credentials** uses the typed model broker, while **runtime credentials/models** never grants host model access. The choice is persisted, displayed on the runtime, and can be changed with an explicit reconnect.

## Current limitations

- The Docker runner process and `--rm` container lifecycle are tied to the server process, but session data is durable in the named volume.
- **Remove from list** removes only an offline locator cached by pi-web. **Delete session data** requires the runtime to be connected and deletes the authoritative runtime session file.
- Git status/diff and prompt/state/messages are routed to runner sessions; host-only routes return an explicit unsupported-runtime error instead of falling back to the host.
- The default image runs `npm exec tsx server/runner.ts` with the pi-web source mounted at `/app`; custom images must be able to run that command.
- SSH runtimes use network policy configured on the remote machine. Model access is explicitly chosen at connection time: remote credentials/models or the host broker.
- Persistent custom command runtimes are authenticated host command execution. They are disabled in production unless `PI_WEB_ALLOW_CUSTOM_RUNTIMES=1` is set.
