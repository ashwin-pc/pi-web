# Docker workspace runtime

pi-web can expose one configured Docker runtime in addition to the normal local runtime. The runtime starts `server/runner.ts` in a container and mounts exactly one host workspace at a fixed container path.

## Secure expectations

- Set `PI_WEB_TOKEN`; browser/API access is still protected by the normal pi-web bearer token flow. The web bearer token is not passed into the Docker runtime.
- Set `PI_WEB_DOCKER_WORKSPACE_HOST` to the only host folder that Docker may mount. pi-web does not accept arbitrary host mount paths from API requests.
- The mounted folder appears inside the container as `PI_WEB_DOCKER_WORKSPACE_CONTAINER` (default `/workspace`). Users should pick folders under that container path.
- Docker networking defaults to `none`. This is the safest mode, but remote model APIs will not work from inside the container. Set `PI_WEB_DOCKER_NETWORK=bridge` when the selected pi model provider needs outbound network access.
- Credentials are not mounted automatically. Only environment variables named in `PI_WEB_DOCKER_ENV_ALLOWLIST` are passed through (default: common model API keys only). Prefer short-lived, scoped tokens.
- The pi-web source tree is mounted read-only at `/app` so the container can run the same `server/runner.ts`; this mount should contain pi-web application code, not the user's private target workspace. The target workspace is the separate `PI_WEB_DOCKER_WORKSPACE_HOST` mount.
- Set `PI_WEB_DOCKER_READONLY=1` to mount the workspace read-only.

## Run

```sh
cd /Users/ashwin/projects/pi-web
PI_WEB_TOKEN="$(openssl rand -hex 24)" \
PI_WEB_DOCKER_WORKSPACE_HOST=/absolute/path/to/repo \
PI_WEB_DOCKER_WORKSPACE_CONTAINER=/workspace \
PI_WEB_DOCKER_IMAGE=node:22-bookworm-slim \
npm run dev
```

For remote model providers, explicitly allow outbound networking and pass only the needed provider key:

```sh
PI_WEB_TOKEN="$(openssl rand -hex 24)" \
PI_WEB_DOCKER_WORKSPACE_HOST=/absolute/path/to/repo \
PI_WEB_DOCKER_NETWORK=bridge \
PI_WEB_DOCKER_ENV_ALLOWLIST=ANTHROPIC_API_KEY \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
npm run dev
```

Open pi-web, enter the token, choose **Docker workspace** in the folder/runtime picker, and create the session with cwd `/workspace` or a subdirectory.

## Current limitations

- The Docker runtime is one long-lived runner process managed by pi-web; container lifecycle is tied to the server process.
- Git status/diff and prompt/state/messages are proxied for runner sessions; host-only routes return an explicit unsupported-runtime error instead of falling back to the host.
- The default image runs `npm exec tsx server/runner.ts` with the pi-web source mounted at `/app`; custom images must be able to run that command.
- Persistent custom command runtimes are authenticated host command execution. They are disabled in production unless `PI_WEB_ALLOW_CUSTOM_RUNTIMES=1` is set; prefer the guided Docker/Apple adapters once available.
