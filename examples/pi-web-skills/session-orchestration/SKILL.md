---
name: session-orchestration
description: Orchestrate pi-web worker sessions with the sessions_spawn / sessions_status / sessions_read / sessions_prompt / sessions_abort tools. Use when a task has noisy or parallelizable parts worth delegating to background worker sessions (exploration, running test suites, isolated implementation steps), or when the user asks you to delegate, parallelize, or spawn workers.
---

# Session orchestration

You have tools that give you the same powers a human has in the pi-web UI:
spawn sessions, watch them, message them, interrupt them. Workers are ordinary
pi-web sessions — fully visible in the sidebar (indented under this session), with
complete transcripts the user can open, watch, and even type into.

## The core loop

1. `sessions_spawn { name, task, category?, cwd? }` — returns immediately with a session id.
2. Do other useful work that **does not overlap what you just delegated**, spawn more
   workers, or **end your turn**.
3. When a worker goes idle, a `🔔 [orchestrator]` user message arrives with its
   final output. This starts a new turn for you if you were idle.
4. Review, then either finish, `sessions_prompt` a follow-up, or spawn the next phase.

Wakeups are durable: watches are persisted in your session file, so if this
session is reloaded or the server restarts, watchers re-arm on load and any
workers that finished in the meantime produce catch-up wakeups.

**Never poll for completion.** Do not call `sessions_status` in a loop and do
not sleep in bash while waiting. Wakeups are pushed to you. Ending your turn
while workers run is correct and costs nothing; you will be woken.

**Don't re-do what you just delegated.** The most common failure is spawning
scouts and then immediately running the same greps, reads and inventories
yourself — which burns tokens twice and dumps into your context exactly the
noise delegation was meant to keep out. Use judgement about whether you should
be working at all while workers run:

- *Work yourself* when: you need a result now to plan the next step or write the
  next worker's task; there is genuinely complementary work (design decisions,
  drafting the deliverable, scaffolding files, setting up a worktree); or a
  worker's claim is load-bearing and cheap to verify (one command, one file).
- *End your turn* when: your only remaining moves are the tasks you handed out,
  or your "parallel work" would mostly be reading things a worker will summarize
  for you anyway. Waiting is a legitimate, cheap action.

When in doubt, prefer ending the turn: you can always do the work after the
wakeup, with the worker's findings in hand.

## What to delegate (and what not to)

Delegate when the *process* is much bigger than the *conclusion*:

- Codebase exploration ("where is X handled? report file:line + 5-line summary")
- Running test suites / builds / lint and triaging output
- An isolated, well-specified implementation step
- Anything you'd hate to have polluting your context afterwards

Keep for yourself: decisions, design, anything needing the context you've
accumulated with the user, and small quick edits (spawning has ~seconds of
overhead and a worker starts with zero context).

## Writing good worker tasks

Workers know NOTHING about your conversation. In `task`, include:

- Concrete goal, relevant paths, constraints, and what NOT to touch.
- What evidence to report: findings with file:line, diffs/files touched, exact
  test output. Ask for a compact report — you want conclusions, not narrative.
- For risky/overlapping edits, give each worker a separate git worktree via
  `cwd`, or make edits disjoint by construction.

Choose the worker's model by **category**, deliberately. Categories are
user-authored (name + "when to use" prose) and listed in the `sessions_spawn`
tool description — pick by the sub-task's nature: a cheap/fast category for
scouting and mechanical chores; a stronger category for real implementation.
The prose in each category is the routing guidance — follow it. Omit `category`
to use the configured default. If no categories are configured, the worker uses
the session's default model. Never guess model ids; pass a category **name**.

## Steering and reviewing

- `sessions_status` — quick glance (running/idle, cost). Fine occasionally,
  e.g. before ending a message to the user.
- `sessions_read { id, tail }` — compact transcript tail. Use it to review
  evidence or diagnose a struggling worker. Keep tails small; do not import a
  worker's whole process into your context.
- `sessions_prompt { id, message, interrupt? }` — follow up, or with
  `interrupt: true` stop a worker that is going down the wrong path and
  redirect it. Also works to re-engage a worker that already went idle.
- `sessions_abort { id }` — stop a worker you no longer need.

Trust evidence, not claims: a worker saying "done" is not done. Check its
diff/test output (from the wakeup or `sessions_read`), or verify cheaply
yourself.

## Etiquette and limits

- Depth cap: workers must not spawn sub-workers (`sessions_spawn` refuses).
- At most 4 workers spawned by `sessions_spawn` may be running/tracked at once;
  sessions merely watched after `sessions_prompt` do not consume spawn slots.
  Prefer 2–3 focused workers over a swarm.
- The user sees every worker in the sidebar and may type into one directly —
  that's fine and expected. Their instructions to a worker take precedence.
- In your reply to the user after spawning, say which workers you started and
  that you'll report when they finish.
- If a wakeup arrives while you're mid-task, you may briefly acknowledge it
  and defer handling until your current step is done.

## Concrete example

```
sessions_spawn { name: "scout: session storage", category: "Fast",
  task: "In <repo>, find where session files are written and rotated.
         Report file:line for each write path plus a 5-line summary.
         Read-only: do not modify anything." }
sessions_spawn { name: "tests: baseline", category: "Fast",
  task: "Run `npm test` in <repo>. Report pass/fail counts and the full
         failure output for any failing test, nothing else." }
-- end turn; wakeups arrive; then --
sessions_spawn { name: "implement: rotation fix", category: "Smart",
  task: "<self-contained spec built from scout findings>.
         Run typecheck + affected tests; report the diff and test output." }
```
