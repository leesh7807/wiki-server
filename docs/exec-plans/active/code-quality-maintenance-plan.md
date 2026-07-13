# Code Quality Maintenance Plan

## Purpose

This plan prepares a durable code-quality guide for this repository. The goal is
not perfect clean code. The goal is code that keeps working while staying easy
to change, review, test, and hand off to agents.

The guide should make feature and concept cohesion higher, keep maintenance
surfaces efficient, and make it obvious which parts of the code an agent should
touch for a bounded change.

## Investigation Summary

Current source layout is intentionally small but still flat:

- `src/server.ts` owns HTTP setup, routes, SSE replay/live buffering, startup,
  env parsing, and process shutdown.
- `src/jobStore.ts` owns queue state, persistence, event logs, metrics,
  retention, startup recovery, event emission, token observability, and file
  observability extraction.
- `src/appServerRunner.ts` owns Codex app-server process lifecycle, websocket
  JSON-RPC, warmup, turn submission, approval/permission handling, cancellation,
  timeout handling, and failure classification.
- `src/clientHtml.ts` owns the browser client markup, styling, and browser-side
  behavior in one generated HTML string.
- `src/agentRunner.ts` is already closer to a useful domain boundary: it
  coordinates app-server and exec runner fallback policy.
- `src/commandInput.ts`, `src/config.ts`, and `src/types.ts` are small and
  cohesive.
- `eval/` already has a clear replay/live split and checked-in fixtures.
- `tray/` is separate from server runtime code and should remain separate unless
  shared configuration is needed.

Current tests are behavior-oriented and mostly paired with source files:

- Unit tests cover runner fallback, app-server protocol edges, client behavior,
  command input parsing, config resolution, job persistence, metrics, and
  observability extraction.
- Integration and live checks are opt-in through environment flags.
- Replay evaluation is the default deterministic harness and is documented as
  cheap and safe.

Current docs define ownership and migration boundaries:

- `README.md` documents runtime, API, validation, and migration basics.
- `docs/architecture.md` defines ownership between this server and the sibling
  wiki.
- `docs/agent-control-and-continuous-slices.md` defines when agents should keep
  moving and when they must stop for user control.
- `docs/evaluation-harness.md` defines replay/live evaluation boundaries.
- `docs/migration-from-wiki-tools.md` defines the externalization gate.

The quality guide should not duplicate these docs. It should sit between
architecture and day-to-day implementation, answering: "Where should this code
live, what shape should it have, and how do I verify the change?"

One runtime observation: `http://127.0.0.1:4317/health` responded during this
investigation, but the response appeared to use a data path under the sibling
wiki rather than this external repo. Treat local code, tests, README, and docs
as the evidence for this plan unless a later slice deliberately verifies the
running server process.

## Proposed Document

Create a durable guide at:

```text
docs/code-quality.md
```

Keep this planning file only while the guide is being drafted or revised. Once
the durable guide is accepted, this plan can either be removed or reduced to a
short changelog entry.

The guide should cover:

- Domain directory boundaries.
- Security and local-only runtime guardrails.
- Test writing rules.
- Code writing rules.
- Naming rules.
- Agent edit-surface rules.
- Review checklist and validation commands.

## Guiding Principles

Use these as the first section of the durable guide:

- Prefer working, observable, testable code over abstract cleanliness.
- Preserve the public HTTP contract unless the user approves a semantic change.
- Keep hidden choices out of implementation. Put meaningful choices in names,
  tests, docs, fixtures, or small replaceable modules.
- Move code when it reduces the future edit surface, not merely because a file
  is large.
- Split by concept and behavior, not by technical layer alone.
- Keep I/O edges thin and push deterministic logic into separately testable
  functions.
- Make agent-owned slices visible, bounded, replaceable, and verified.

## Domain Directory Plan

Do not move everything at once. Use this as the target shape when a touched
module already needs work:

```text
src/
  http/
    server.ts
    routes.ts
    sse.ts
    health.ts
  jobs/
    store.ts
    queue.ts
    persistence.ts
    events.ts
    metrics.ts
    observability.ts
    retention.ts
  runners/
    agentRunner.ts
    appServer/
      manager.ts
      protocol.ts
      process.ts
      turn.ts
      warmup.ts
    execRunner.ts
  client/
    html.ts
  config/
    paths.ts
    env.ts
  shared/
    types.ts
    time.ts
```

This is a direction, not a migration mandate. A new file should go into a domain
directory when the domain is clear. Existing flat files can stay until a slice
already touches them.

Recommended first extractions:

1. Extract job file/token observability from `src/jobStore.ts` into a
   `jobs/observability` module, because it is deterministic parsing logic with
   existing tests and a clear replacement boundary.
2. Extract SSE event replay/live buffering from `src/server.ts` into an HTTP
   helper, because it is HTTP behavior but not route definition.
3. Extract app-server JSON-RPC protocol helpers from `src/appServerRunner.ts`
   before changing runner lifecycle behavior, because protocol correctness and
   process lifecycle have different failure modes.
4. Extract client browser script only if client behavior grows further. Until
   then, `clientHtml.ts` can remain a generated local client artifact with
   focused tests.

## Security Scope

The quality guide should make these rules explicit:

- The service is local-only. Binding beyond `127.0.0.1`, adding auth, or changing
  permission policy is a user decision surface.
- Do not log full user content, secrets, full raw model output, or unbounded
  stderr by default. Prefer previews, bounded tails, and explicit debug paths.
- Treat job event logs as observability, not durable wiki memory.
- Keep path handling centralized. Resolve configured roots once, validate wiki
  root shape, and avoid accepting arbitrary filesystem operations from HTTP
  bodies.
- Keep runner permissions and approval behavior in runner-domain code. HTTP
  routes should enqueue work, not decide sandbox or approval semantics.
- Do not add live/model-backed evaluation to default checks.
- Network, auth, permission, and destructive migration changes require explicit
  user approval even when they are easy to implement.

## Test Writing Rules

The durable guide should require tests at the same conceptual boundary as the
change:

- Parser, formatter, metrics, retention, and observability logic get unit tests
  with deterministic inputs.
- Queue, cancellation, persistence, and startup recovery get behavior tests
  around public `JobStore` behavior or a future jobs-domain API.
- HTTP contract changes get route-level tests or replay/live fixtures depending
  on whether they require a running server.
- Runner lifecycle changes get fake process/websocket tests first. Real Codex
  integration remains opt-in.
- Replay eval cases cover observable contract regressions and should not become
  semantic wiki-quality judges.
- Test names should describe behavior and failure condition, matching the
  existing style such as "falls back to exec when app-server fails before a turn
  starts".

Validation order should remain:

```powershell
npm test
npm run typecheck
npm run build
npm run eval:replay
```

Run opt-in checks only when the slice needs them and the user has approved any
live/model-backed cost:

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
npm run test:integration

$env:WIKI_RUN_WIKI_SERVER_LIVE_EVAL = "1"
npm run eval:live
```

## Code Writing Rules

The guide should keep the rules pragmatic:

- Put orchestration at the edge and policy in named functions or small modules.
- Keep public types close to the boundary that owns them. Shared types belong in
  `shared` or a domain-level `types` file only when multiple domains depend on
  them.
- Prefer explicit result objects for expected operational failures. Throw for
  configuration errors, programmer errors, and impossible states.
- Use bounded buffers, bounded logs, and bounded retries for runtime paths.
- Use dependency injection where it makes behavior testable, as in the current
  runner tests. Do not introduce containers or broad framework abstractions.
- Avoid generic utility modules. A helper should have a domain name such as
  `jobEvents`, `fileObservability`, `appServerProtocol`, or `sseReplay`.
- Keep comments for non-obvious operational choices, compatibility boundaries,
  or failure semantics. Do not comment obvious assignments.
- Keep generated or embedded UI artifacts isolated from runtime control-plane
  logic.

## Naming Rules

Use names that reduce the next agent's search space:

- Domain nouns: `Job`, `JobEvent`, `Runner`, `AppServerTurn`, `ReplayCase`,
  `FileObservability`.
- Verbs should reveal side effects: `enqueue`, `persist`, `recordEvent`,
  `cancel`, `warmUp`, `startJob`, `resolvePaths`.
- Avoid `utils`, `helpers`, `misc`, `data`, and broad `manager` names for new
  code unless the module truly coordinates a process lifecycle.
- Name tests after observable behavior, not implementation details.
- Name fixtures after scenario and expected outcome:
  `query-replay-success`, `ingest-replay-failure`.
- Environment variables keep the `WIKI_` or `WIKI_SERVER_` prefix and should be
  parsed in config/env code rather than scattered through feature modules.

## Agent Edit Surface

The quality guide should explicitly help agents choose files:

- HTTP/API behavior: start in `server.ts` or future `src/http/*`, then update
  route tests and README/API docs if the public contract changes.
- Queue, job status, persistence, metrics, or event logs: start in `jobStore.ts`
  or future `src/jobs/*`, then update `jobStore.test.ts` and replay fixtures if
  observable reports change.
- Codex runner lifecycle, fallback, warmup, cancellation, permission, or timeout
  behavior: start in `agentRunner.ts`, `appServerRunner.ts`, or future
  `src/runners/*`, then update fake runner tests before integration checks.
- Request parsing: start in `commandInput.ts`, then update command input tests
  and public API docs.
- Config/root/data-dir behavior: start in `config.ts`, then update config tests
  and README defaults.
- Client UI behavior: start in `clientHtml.ts`, then update client HTML tests.
- Evaluation harness behavior: start in `eval/*`, then update
  `docs/evaluation-harness.md`.

For each slice, the agent should report:

- Which public contract is preserved or changed.
- Which domain owns the change.
- Which files form the bounded edit surface.
- Which deterministic checks were run.
- Which remaining decision surfaces require the user.

## Rollout Plan

1. Add `docs/code-quality.md` using this plan as the source.
2. Link it from `README.md` near validation or architecture, and optionally from
   `docs/architecture.md` as the day-to-day maintenance guide.
3. Keep AGENTS focused on operating rules. Do not move all quality guidance into
   AGENTS unless it is required at session start.
4. Apply the guide opportunistically: new code should follow the target
   directory shape; existing files move only when a bounded slice already needs
   that code.
5. Use the first real refactor to validate the guide. The best candidate is
   extracting file/token observability from `jobStore.ts` because tests already
   cover the behavior.
6. After one or two slices, revise the guide based on friction: if a rule makes
   edits harder without improving ownership, replace it.

## Acceptance Criteria

The durable guide is ready when:

- It can tell an agent where to start for the common change types in this repo.
- It separates public HTTP compatibility from internal editable structure.
- It makes security, cost, and permission decision surfaces explicit.
- It gives test expectations by behavior surface, not by file size.
- It supports gradual migration from flat files to domain directories.
- It avoids pretending that "clean code" is more important than working,
  observable, replaceable code.
