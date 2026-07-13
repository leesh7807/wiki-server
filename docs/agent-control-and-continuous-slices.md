# Agent Control And Continuous Slices

## Purpose

This repository is meant to support continuous agent work. A new session should
not require the user to restate every next step when the repo already contains a
plan, tests, docs, and harnesses that make the next action clear.

The core rule lives directly in `AGENTS.md` because linked docs alone are too
weak as an operating control. This document expands the details.

## Control Split

User decision surface means a step needs the user's value judgment or operating
authorization and cannot be made safe through visibility, rollback boundaries,
or verification.

Agent execution surface means the direction is already determined and the work
is visible, reversible or replaceable, and verifiable through local repo state.
The agent should proceed.

This split is part of the harness. It keeps the user in control of product,
security, cost, and irreversible migration decisions while letting the agent keep
momentum on implementation, tests, docs, and validation.

The reason to stop is not simply that reasonable people might choose
differently. In practice, most such choices can be made by following the agent's
recommended direction. The real failure mode is when the agent's choice becomes
hidden inside implementation or smeared across flat minimal edits so it is hard
to roll back, modify, or replace.

## Choice Control

Before crossing a meaningful choice, the agent should make it controllable:

- **Visible:** record the choice in docs, tests, fixture names, config names,
  comments, or the final report.
- **Bounded:** prefer a small module, adapter, script, config flag, fixture, or
  doc section over scattered edits.
- **Replaceable:** leave a clear place where an alternate direction can be
  swapped in later.
- **Verified:** close the slice with deterministic checks where possible.

If these controls are possible, continue with the recommended direction instead
of stopping only because the user might have chosen differently.

## Continue Without Asking

Continue autonomously when:

- A prior accepted plan defines the next implementation slice.
- The change preserves the HTTP/API contract.
- The change is confined to this repository.
- The agent can expose the choice and its rationale without requiring the user
  to inspect the implementation.
- The selected direction has a rollback or replacement boundary.
- The work adds harness coverage, replay fixtures, deterministic validation, or
  documentation for an already accepted design.
- The outcome can be checked with local commands.
- Failure can be recovered by inspecting the diff and test output.

Examples:

- Add more replay eval cases.
- Convert a checklist into a script.
- Add config tests for environment variables.
- Improve docs that describe implemented behavior.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run
  eval:replay`.

## Stop For User Decision

Stop and ask when:

- The user explicitly said to stop, ask first, or avoid the action.
- Changing the public HTTP contract or command semantics.
- Making the service network-accessible beyond `127.0.0.1`.
- Adding authentication, approval UI, user-input routing, or permission policy.
- Running live model-backed evals unless the user has opted in for that slice.
- Deleting data, removing an implementation, or making a migration cutover that
  would be expensive to reverse.
- Choosing among alternatives when no recommendation is justified by repo
  evidence and the choice cannot be bounded for later replacement.

## Slice Shape

Each slice should have:

- A concrete implementation goal.
- A small enough diff to inspect.
- A deterministic verification path where possible.
- State externalized into files, fixtures, docs, or reports.
- A clear account of completed work, meaningful choices made, verification, and
  remaining hard decision surfaces.

Avoid ending with only a proposal when the accepted plan and repo state already
identify the next implementation step.

## Subagents

This repo intentionally keeps the stop/continue model in shared context so
subagents can use it to make better local scope decisions. That does not make a
subagent the project coordinator.

When the main agent spawns a subagent, the spawn prompt must explicitly name:

- The subagent role, such as explorer, worker, or verifier.
- The assigned scope and owned files or responsibilities.
- Whether file edits are allowed.
- The expected output, including choices made, checks run, and any
  rollback/replacement boundary.

Within that assigned scope, a subagent can proceed without asking when the same
visibility, boundedness, replaceability, and verification controls are present.
Outside that scope, it should report the next opportunity to the main agent
instead of starting another slice.

## Waiting And Log Coordination

Waiting for a job is a mechanical observation phase. It should not become a
second planning loop where raw logs, heartbeats, or repeated wiki lookups dilute
the coordinating agent's role.

Use observation levels:

- **L0 status:** job status, terminal or non-terminal state, and elapsed time.
  This is the default while waiting.
- **L1 result:** terminal result or error summary, metrics summary, artifact
  impact, and verification impact. Use this when the job finishes.
- **L2 diagnosis:** `stderrTail`, `lastAgentMessage`, and a small recent event
  window. Use this for failure, suspected stall, scope drift, or decision
  surface warnings.
- **L3 raw debug:** full raw event review. Use only when the job cannot be
  understood from L0-L2 or the user explicitly asks for deep debugging.

Default cadence:

- Check once about 10-15 seconds after job start to catch immediate setup
  failures.
- Then poll L0 roughly every 30 seconds.
- After about 5 minutes, slow to roughly every 60 seconds.
- After about 15 minutes, slow to roughly every 2 minutes unless there is a
  concrete intervention signal.

This cadence is a default, not a timer ritual. If a command is known to finish
quickly, one or two checks may be enough. If a job is clearly still active,
prefer fewer, cleaner observations over repeated log reading.

When the pending job is itself the barrier for the current decision and there is
no independent work that was already required, use a silent barrier wait. That
means one bounded command performs the polling internally and emits only the
terminal status plus concise result or terminal error. This keeps waiting from
turning into status chatter or a second planning phase. Choose an explicit
timeout and interval, and treat a timeout as a non-terminal barrier, not as an
inferred success or failure.

Silent barrier wait recipe:

- Use one bounded command, not repeated chat-visible status checks.
- Choose an expected wait window from the job type, current queue state, recent
  metrics, or the user's stated expectation. If no estimate is available, use a
  short conservative first window.
- Poll `GET /jobs/<jobId>` on a fixed interval inside that command for the
  expected window.
- Print nothing while the job is `queued` or `running`.
- Stop only when the job reaches `succeeded`, `failed`, `cancelled`, or
  `interrupted`, or when the expected wait window is exceeded.
- On `succeeded`, return a compact summary containing status, metrics that
  affect coordination, and `result.lastAgentMessage` when the caller needs the
  wiki answer.
- On `failed`, `cancelled`, or `interrupted`, return status plus
  `error.message`, `error.stderrTail`, and `error.lastAgentMessage` when
  present.
- When the expected window is exceeded, perform one brief L0 check: latest
  status, elapsed wait, queue position or running duration when available, and
  whether there is an intervention signal. Do not read raw events or duplicate
  the pending research.
- If there is no intervention signal and the job is still plausibly progressing,
  start another silent wait window using the updated estimate. Repeat this
  wait-check-reestimate cycle until terminal status, explicit user interruption,
  or a real intervention signal.
- Report `non_terminal_barrier_blocked` only when the wait reaches a user-visible
  barrier and no independent work remains, or when the status check itself shows
  the job cannot be treated as normal waiting. Do not infer success from elapsed
  time, event volume, or partial output.
- Escalate out of silent waiting only for a concrete intervention signal such
  as status endpoint failure, cancellation request, suspected stuck runner,
  scope drift, public-contract drift, or unapproved costly/security-sensitive
  work.

Example shape:

```powershell
$deadline = (Get-Date).AddMinutes(<expectedWindowMinutes>)
$intervalSeconds = 30
do {
  $job = Invoke-RestMethod -Uri "http://127.0.0.1:55173/jobs/<jobId>" -Method Get
  if (@("succeeded", "failed", "cancelled", "interrupted") -contains $job.status) {
    $job | Select-Object id,status,result,error,metrics | ConvertTo-Json -Depth 8
    exit 0
  }
  Start-Sleep -Seconds $intervalSeconds
} while ((Get-Date) -lt $deadline)

[pscustomobject]@{
  id = "<jobId>"
  status = "expected_window_exceeded"
  latestStatus = $job.status
  note = "Run one brief L0 check, then re-estimate and start another silent wait if there is no intervention signal."
} | ConvertTo-Json -Depth 4
```

While waiting, do not:

- Repeatedly read the same raw events, heartbeat output, or verbose agent logs.
- Re-run the same wiki `/query` because the job has not finished yet.
- Bypass the queued wiki job by directly reading sibling wiki pages, other
  project notes, or alternative knowledge stores for the same question merely
  because the queue is slow.
- Start broad research that is not required for the current slice.
- Run tests that depend on the pending job's result.
- Edit files based on a result that has not arrived.
- Start live/model-backed evaluation, network exposure, auth, approval, or
  permission work as a way to fill time.
- Promote worker-discovered information into durable wiki knowledge from a
  worker or subagent role.

Useful bridge work is allowed when it is independent of the pending result and
low-context:

- Prepare the exact deterministic validation command that will run after the job
  completes.
- Identify rollback or replacement boundaries for the current slice.
- Inspect already-known files or docs that are needed regardless of job result.
- Draft a concise final report shape.
- Record candidate next slices without starting them.
- Review whether the pending job is approaching a user decision surface.

Direct wiki or sibling-project file reads during a wait are not neutral bridge
work when they answer the same question as the queued job. They are a different
evidence path and can undermine the authority boundary created by using
`/query`. Use them only if direct file inspection was already the selected
method, the files are needed regardless of the pending answer, or terminal
failure/focused diagnosis makes the queued result unavailable or insufficient.

Intervene only when the observation changes the coordination decision. Examples
include scope drift, public contract drift, unapproved live/costly work, repeated
stall without new progress, or evidence that the worker is moving toward a
hard-to-reverse change.

## Wiki Authority By Role

Wiki access is not all the same authority.

- `/query` is evidence gathering. Workers, verifiers, and subagents may use it
  for neutral questions inside their assigned scope.
- `/ingest` is durable knowledge preservation. The coordinating agent owns the
  decision to ingest so the user can see which judgments become project memory.
- `/lint` is canonical maintenance. The coordinating agent owns it unless a
  prompt explicitly delegates it.

When a worker or subagent finds information worth preserving, it should report
an ingest candidate with the decision, why it is durable, what alternatives or
failure modes matter, and where the repo encoded the decision. The coordinating
agent decides whether to call `/ingest`.

## Harness Priority

Prefer checks in this order:

1. Unit tests and typecheck.
2. Build.
3. Replay eval.
4. Local smoke with warmup disabled or fake/replay-backed behavior.
5. Live Codex/model-backed eval only when explicitly opted in.

Replay is the default because it is cheap, repeatable, and safe for continuous
work. Live checks are valuable but should not become an accidental cost or
latency trap.

## Handoff Standard

If work stops, the next agent should be able to continue from:

- Git diff/status.
- README and docs.
- Test/eval output.
- Fixtures and scripts.
- A concise final report.

Chat memory is not enough.
