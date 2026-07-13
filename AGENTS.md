# Wiki Server Repository Contract

This repository owns the local wiki agent server, runtime observability,
desktop app, and the minimal template used to initialize a new user's
operational wiki. It does not own or track the user's wiki content.

This file intentionally defines only repository ownership, public integration,
and security constraints. It does not prescribe implementation cadence,
subagent delegation, job-waiting behavior, or when agents should consult the
wiki. Those choices may be adjusted through the current task and user
instructions.

## Ownership And Source Of Truth

For this server implementation, the local code, tests, README, and docs are the
authoritative surfaces. Wiki notes may provide useful context, but do not
override the repository's current implementation and verified contracts.

The tracked `wiki-template/` is structure and a minimal operating contract, not
a content snapshot or a second source of truth. Never copy a user's live wiki
back into this repository as a packaging seed.

Default local layout:

- Server repo: `C:\Users\leesh\projects\wiki-server`
- Installed wiki root: `%LOCALAPPDATA%\Wiki Server\wiki-root`, passed to the
  server as `WIKI_ROOT`; source-only development may use
  `C:\Users\leesh\projects\wiki` or an explicit `WIKI_ROOT`
- HTTP API: `http://127.0.0.1:55173` by default; use the active endpoint shown
  by the desktop app when it reports a port fallback
- Server runtime data: `.cache/wiki-server/`, unless `WIKI_SERVER_DATA_DIR` is
  set

## Public HTTP Contract

The routes, request and response shapes, terminal statuses, and command
semantics below are compatibility surfaces. Semantic changes require explicit
user approval.

The API is asynchronous. `POST /query`, `POST /ingest`, and `POST /lint`
return `202` with `{ "jobId": "...", "status": "...", "eventsUrl": "..." }`.
The initial status may be `queued` or already `running`.

Commands:

- `POST /query` with `{ "content": "question text" }`
- `POST /ingest` with `{ "content": "file path, document text, or context" }`
- `POST /lint` with no body or `{}`; scoped lint content is rejected

Job follow-up:

- `GET /jobs/<jobId>` returns current state, result/error, and metrics.
- `GET /jobs/<jobId>/events` streams SSE `status`, `heartbeat`, `agent_event`,
  and `done`.
- Terminal statuses are `succeeded`, `failed`, `cancelled`, and `interrupted`.
- Successful answers are exposed as `result.lastAgentMessage`.
- Failures may expose `error.message`, `error.stderrTail`, and
  `error.lastAgentMessage`.

Other endpoints:

- `GET /health`
- `GET /metrics/jobs`
- `POST /jobs/<jobId>/cancel`
- `GET /` and `GET /client`

## Security And Runtime Data

The service is local-only, unauthenticated, and single-queue. Do not expose it
outside the local machine without authentication and network controls.

Job metadata is stored at `.cache/wiki-server/jobs/<jobId>.meta.json`; raw
events are stored at `.cache/wiki-server/jobs/raw-events/<jobId>.jsonl` unless
the runtime data directory is overridden.

Metrics are mechanical observability, not durable wiki knowledge:
`tokenUsageHighWater` is not billing usage, and `fileObservability` is not a
definitive created/updated/deleted/moved file ledger.
