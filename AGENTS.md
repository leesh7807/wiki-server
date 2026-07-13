
# Wiki Server Agent Contract

This repository owns the local wiki agent server, runtime observability,
evaluation harness, and—after content consolidation—the nested wiki root. The
sibling wiki repository is a compatibility fallback during migration.

Default local layout:

- Server repo: `C:\Users\leesh\projects\wiki-server`
- Wiki root: `C:\Users\leesh\projects\wiki-server\wiki-root` when present;
  otherwise legacy `C:\Users\leesh\projects\wiki`, or `WIKI_ROOT`
- HTTP API: `http://127.0.0.1:55173` by default; copy the active endpoint from
  the desktop app when it reports a port fallback
- Server runtime data: `.cache/wiki-server/` in this repository, unless
  `WIKI_SERVER_DATA_DIR` is set.

## Source Of Truth

The wiki is useful project memory, but its current notes about this server are
advisory context, not binding implementation truth. For this repository, prefer
the local code, tests, README, and docs. If the wiki disagrees with this repo,
treat the disagreement as a design signal to investigate, not as an automatic
override.

Temporary migration posture: much of the current server implementation was
copied from `C:\Users\leesh\projects\wiki\tools\wiki-server`. Treat that copied
code as a compatibility baseline, not a protected design. Preserve the public
HTTP contract unless the user approves a semantic change, but the imported
internal structure is editable project surface. Refactor, modularize, or replace
it when doing so improves external ownership, observability, evaluation, or
maintainability, as long as the slice is visible, bounded, replaceable, and
verified. This posture should shrink or leave `AGENTS.md` after migration is
complete and the external server has its own stable design boundaries.

## Continuous Slice Operating Rule

This section is intentionally in `AGENTS.md`, not only in linked docs. New agent
sessions must treat it as a direct operating rule for this repository.

Default posture: keep moving through consecutive implementation slices when the
next action is already determined by the repo, tests, docs, or previous accepted
plan. Reasonable disagreement alone is not a stop condition. Continue when the
choice can be made visible, bounded, replaceable, and verified.

Stop for user input only when the user explicitly asked to stop or ask first,
the change affects live/model-backed cost, network/auth/approval/permission
policy, destructive or hard-to-reverse migration behavior, public command
semantics, or when no repo-grounded recommendation can be made visible and
reasonably reversible.

Proceed without asking for bounded implementation, tests, replay fixtures,
docs, scripts, harness checks, narrow refactors, and local deterministic
validation that preserve the public HTTP contract. Close each slice with durable
state in code, tests, fixtures, docs, or a concise final report; name meaningful
choices, rollback/replacement boundaries, verification, and any remaining user
decision surface. If the next safe slice is already determined, continue instead
of stopping at a vague handoff.

Subagents may be used only for bounded roles. The spawn prompt must state the
role, authority, owned files or responsibility, edit permission, expected output,
and that out-of-scope next slices are reported to the main agent rather than
started.

Job waiting is mechanical observation, not a second planning phase. Prefer
lightweight status checks; when the pending job is the decision barrier and no
already-required independent work remains, use a silent barrier wait that polls
inside one bounded command and returns only terminal status, concise result, or
terminal error. Do not read raw logs repeatedly, do duplicate research, or bypass
a queued wiki job by directly reading sibling wiki pages or other knowledge
stores for the same question merely because the queue is slow.

Wiki authority is split by action. `/query` is scoped evidence gathering.
`/ingest` and `/lint` are coordinator-owned durable memory or maintenance
actions; workers and subagents should report ingest candidates instead of
preserving durable knowledge themselves.

Detailed guidance: `docs/agent-control-and-continuous-slices.md`.

### Client Integration Contract

Use this section when another local repository calls the wiki agent server.
Base URL: `http://127.0.0.1:55173` by default.

The API is asynchronous. `POST /query`, `POST /ingest`, and `POST /lint`
return `202` with `{ "jobId": "...", "status": "...", "eventsUrl": "..." }`.
The initial status may be `queued` or already `running`.

Commands:

- `POST /query` with `{ "content": "neutral question text" }`
- `POST /ingest` with `{ "content": "file path, document text, or Source / Ingest context block" }`
- `POST /lint` with no body or `{}`; scoped lint content is rejected

When to call and wait:

- Use `/query` when the caller needs an answer from the wiki before continuing;
  poll or consume SSE until terminal.
- Use `/ingest` to hand off source preservation/compilation. The accepted
  `jobId` is usually enough; wait only when later work needs confirmed
  preservation, generated source links, or a follow-up `/query` based on the
  ingest.
- Use `/lint` only for the canonical full-wiki maintenance audit. It is not a
  scoped check endpoint; wait only when the caller needs the lint report.

Job follow-up:

- `GET /jobs/<jobId>` returns current state, result/error, and metrics.
- `GET /jobs/<jobId>/events` streams SSE `status`, `heartbeat`,
  `agent_event`, and `done`.
- Terminal statuses are `succeeded`, `failed`, `cancelled`, and `interrupted`.
- Read successful answers from `result.lastAgentMessage`.
- On failure, inspect `error.message`, `error.stderrTail`, and optionally
  `error.lastAgentMessage`.

Other endpoints:

- `GET /health`
- `GET /metrics/jobs`
- `POST /jobs/<jobId>/cancel`
- `GET /` and `GET /client`

#### Request Framing

Write `/query` requests as neutral questions. Do not ask why the current
change is right, ask only for supporting evidence, or restrict the answer to
preselected concerns while excluding other relevant risks and alternatives.

For revised, renamed, scope-changed, or migrated documents, include the reason
in `/ingest` context. This context guides wiki updates but is not part of raw
source identity.

#### Observability

The service is local-only, unauthenticated, and single-queue. Do not expose it
outside the local machine without auth and network controls.

Job metadata is stored at `.cache/wiki-server/jobs/<jobId>.meta.json`; raw
events are stored at `.cache/wiki-server/jobs/raw-events/<jobId>.jsonl`.
Metrics are mechanical observability, not durable wiki knowledge:
`tokenUsageHighWater` is not billing usage, and `fileObservability` is not a
definitive created/updated/deleted/moved file ledger.

#### 위키 정보 신뢰 수준

위키 에이전트 서버를 정보의 원천으로써 활용.
동시에 현재 프로젝트가 이용하는 위키 서버를 외부화 하기 위한 프로젝트.
위키 내부에 들어간채로 구현된 현재 위키 서버의 결정사항을 진리처럼 받아들이지 않고 대등한 의견으로 받아들일 것.
