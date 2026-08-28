# pi-web connector for agent-health

This benchmark runs an agent-health case through pi-web's HTTP session API. Each case gets a normal pi-web session, so the installed system prompt, tools, skills, and extensions are exercised; no `pi` subprocess is used for the system under test. The optional local `pi` process mentioned below is only a result judge.

## Prerequisites

- Node.js 20 or newer.
- pi-web already running at `http://127.0.0.1:8787`.
- `PI_WEB_TOKEN` exported in the shell.
- The agent-health source checkout at `/tmp/agent-health`.

## Install and build agent-health

```bash
cd /tmp/agent-health
npm install
npm run build:server
```

If the internal npm registry returns `E401`, refresh its token and retry:

```bash
harmony npm
cd /tmp/agent-health && npm install
```

## Start the server

The working directory is significant: agent-health auto-detects `agent-health.config.ts` from it.

```bash
cd /local/home/ashwinpc/oss/pi-web/benchmarks/agent-health
tmux kill-session -t agent-health 2>/dev/null || true
tmux new-session -d -s agent-health \
  "TRACE_POLL_INTERVAL_MS=100 TRACE_POLL_MAX_ATTEMPTS=1 TSX_TSCONFIG_PATH=/tmp/agent-health/tsconfig.json /tmp/agent-health/bin/cli.js serve --port 4001 --no-browser >/tmp/agent-health-server.log 2>&1"
tail -f /tmp/agent-health-server.log
```

## Build import-ready cases

Generate cases with connector/documentation dispositions and a reproducible fixture manifest before importing or running them:

```bash
node scripts/build-cases.mjs              # writes generated/*.json
# Optional output directory:
node scripts/build-cases.mjs /tmp/ah-cases
```

The source files in `cases/` remain human-authored. Generated cases mark the fixture selector as a connector directive and add Markdown documentation containing the authored fixture notes, generated tree/sizes, whole-fixture SHA-256, and bounded bait-marker scan.

## Run the smoke benchmark

`demo-judge` is agent-health's credential-free deterministic judge. Directory import uses the current evaluation-runs API, which supports local file storage (agent-health 0.5.2's legacy single-`-f` benchmark execution path requires OpenSearch). The short trace-poll settings above also bound a 0.5.2 runner bug that starts trace polling after an already-scored `useTraces: false` custom-connector run; the judge result remains in `matcherResults` and `llmJudgeResponse`.

```bash
cd /local/home/ashwinpc/oss/pi-web/benchmarks/agent-health
TSX_TSCONFIG_PATH=/tmp/agent-health/tsconfig.json \
  /tmp/agent-health/bin/cli.js benchmark \
  -d generated \
  -n "pi-web connector smoke" \
  -a pi-web-baseline \
  --judge-model demo-judge \
  --verbose
```

A deprecated `pi-judge` model key is also registered for environments where agent-health's bundled pi CLI has provider credentials. The safer `agent-evidence-judge` key selects the in-process judge with restricted bash over an immutable evidence bundle (the CLI's `--judge-model` value selects this provider entry; the agentic judge still chooses its own credentialed model from pi's registry):

```bash
# Add AH_JUDGE_KEEP_EVIDENCE=1 and AH_JUDGE_DEBUG=1 to the server command
# when you want the evidence tree + judge bash commands retained for inspection.
TSX_TSCONFIG_PATH=/tmp/agent-health/tsconfig.json \
  /tmp/agent-health/bin/cli.js benchmark \
  -d generated \
  -n "pi-web restricted evidence judge smoke" \
  -a pi-web-baseline \
  --judge-model agent-evidence-judge \
  --verbose
```

If pi uses an AWS profile, explicitly pass `AWS_PROFILE` when creating the server tmux session because a long-lived tmux server may not have the current shell's refreshed environment. The fixture pre-seeds `.pi/web/.gitignore`, which pi-web otherwise creates on first use, so before/after file-set and mtime checks remain meaningful.

The connector keeps the `bench: pi-web full-stack read-only smoke` pi-web session by default. Local agent-health data is written beneath `.agent-health/`. Stop only the benchmark server when finished:

```bash
tmux kill-session -t agent-health
```
