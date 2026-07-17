# Architecture

## Ownership Boundary

`wiki-server` owns the operational control plane:

- Fastify HTTP API and local web client
- FIFO job queue and cancellation
- Codex app-server runner plus exec fallback
- Job metadata, raw event logs, metrics, and retention
- Electron tray process and startup behavior

The installed operational wiki owns durable knowledge:

- Wiki operating contract and command semantics
- Raw source archive, source pages, compiled pages, index, and log
- Citation/provenance rules and lint workflow

Job logs are observability, not durable wiki knowledge. A job transcript should
be promoted into the wiki only through an explicit ingest or curated operating
note.

## Code Boundaries

The standalone runtime uses domain-oriented modules under `src/`:

- `config/` resolves environment, paths, and command profiles.
- `jobs/` owns command framing, job state, persistence, observability metrics,
  and the shared job contract.
- `retrieval/` derives bounded lexical and link-graph routing context from the
  current Markdown wiki. It never owns durable knowledge or writes to the wiki.
- `runners/` adapts Codex app-server and exec transports and owns fallback
  policy.
- `http/` owns routes, SSE replay/live delivery, response shapes, and the
  compatibility client.
- `server.ts` is the composition root for process startup and shutdown.

Dependencies flow from the composition root into domains, and from transport
adapters toward the `jobs/` contract. The jobs domain never imports HTTP,
Electron, or a concrete runner. The Electron side follows the same pattern:
`tray/main.cjs` composes modules grouped under `tray/server/`, `tray/system/`,
and `tray/wiki/`, while `desktop/` remains the replaceable renderer.

See `docs/code-map.md` for the change-routing table and extraction criteria.

## Legacy Baseline Versus Design Boundary

The implementation imported from `wiki/tools/wiki-server` is a compatibility
baseline, not a design boundary. The HTTP contract, command semantics, and
client integration behavior are the compatibility surface. Internal structure,
module boundaries, runner plumbing, observability storage, and harness wiring
are editable surfaces for this repository.

The imported internal structure remains editable. Refactor or replace internal
pieces when it improves server ownership, testability, observability, or
maintainability while preserving the public HTTP compatibility surface.

## Runtime Paths

The package root is `%USERPROFILE%\projects\wiki-server`. A packaged desktop
app passes `%LOCALAPPDATA%\Wiki Server\wiki-root` explicitly through
`WIKI_ROOT`. The source repository contains only `wiki-template/`, which is a
minimal new-user scaffold and never a content snapshot. Source-only development
continues to use legacy sibling `%USERPROFILE%\projects\wiki` when no override
is provided.

`WIKI_ROOT` overrides both locations. The server validates that the root contains
`AGENTS.md`, `index.md`, and `wiki/`.

`WIKI_SERVER_DATA_DIR` overrides runtime state. Without it, server-owned state is
stored in `.cache/wiki-server/` in this repository:

- `jobs/`
- `jobs/raw-events/`
- `codex-home/`
- `tray.log`

## Execution

The default runner starts `codex app-server` and submits each command as an
ephemeral thread/turn. If app-server fails before a turn starts, the server can
fall back to `codex exec --json --ephemeral`. Both transports use the same
isolated `WIKI_CODEX_HOME`; fallback must not read a user's global Codex cache.
The executable is the standalone Codex CLI selected by `CODEX_BIN`, or `codex`
from PATH. Store-app internal and versioned binary paths are not runtime
dependencies.
An error that explicitly requires a newer Codex version is returned directly
instead of retrying through a transport that uses the same incompatible binary.

The public integration contract remains HTTP. The Codex app-server WebSocket is
an internal runner channel, not the external client API.

Before a queued job starts, the server derives deterministic initial retrieval
context from `index.md` and `wiki/**/*.md`. Query and ingest receive bounded
lexical seeds plus at most two graph hops. This is an initial batch bound, not a
job-level exploration limit: the isolated agent environment receives an
internal `wiki-retrieval` command and may search the same cached graph again
with different terms, document or source identities, and relationship
viewpoints. Lint receives full-audit partitions, graph diagnostics, and durable
pages over 20,000 characters. The same prepared input and command availability
are preserved if app-server falls back to exec. `log.md`, `raw/**`, and assets
are excluded from normal indexing; an agent may escalate to one specific raw
source only for explicit provenance work. `WIKI_GRAPH_RETRIEVAL=0` disables the
initial context and internal command.

Graph search and document reading are separate operations. Search returns no
body snippets: each candidate exposes identity, declared type/status,
aliases/tags, source/current-source/supersedes relations, bounded local graph
connections, distance, outline and size, and factual match fields. Ranking is
routing data and does not decide authority, accepted evidence, required reads,
update targets, or knowledge lifecycle actions. After reviewing candidates the
agent can explicitly read a heading or line range; a whole document requires a
separate explicit mode and is reserved for tasks that need multiple or all
sections. Graph connection metadata supports traversal without reading
intermediary bodies merely to discover the next edge. The command uses a token-protected loopback RPC as an
internal runner transport, not as part of the public HTTP integration contract.
Parsed graph data is reused until indexed path size or modification time
changes.

The initial retrieval event carries the bounded candidate paths or lint
partitions. Ingest selection preserves a current-status signal, a source
candidate, and a related map when each is available, then records bounded
selection and exclusion reasons without declaring authority. Job metrics derive
`retrievalObservability` from completed agent tool events, distinguishing
candidate use, graph and filesystem searches, selective
and full-document reads, targeted provenance/log checks, repeated reads,
broad-root searches, broad excluded-path access, and output size. The
derived layer is explicitly best-effort and may report unknown or incomplete
access.

Live SSE always emits the original event envelope. For disk efficiency, large
`data` payloads may be gzip-encoded in a versioned storage record inside the
same `jobs/raw-events/<jobId>.jsonl` path. Event loading transparently restores
the original `seq`, event name, and data before HTTP replay. Existing plain
records and mixed logs remain readable. Set
`WIKI_SERVER_COMPRESS_EVENT_LOGS=0` to write new records as plain JSON; older
server versions cannot decode already-compressed storage records.

The initial query/ingest defaults are six diversified lexical/role seeds,
twelve final candidates, at most two graph hops per search, and eighty distinct
query terms. Agents may issue further searches without an arbitrary attempt
cap. Ingest command output has a 12,000-character observability budget and
document bodies are reviewed one selected section at a time. These are bounded
engineering defaults, not trained relevance parameters. Tune them from observed
candidate use, broad-search frequency, output-budget violations, latency, and
answer quality rather than increasing context speculatively.

The standalone server defaults to `127.0.0.1:55173`. The desktop shell probes
that port before launch and selects a nearby free port on collision. Port
fallback is desktop state, surfaced through the renderer warning and its
copyable integration guide; it does not change endpoint semantics.

Model selection is command-scoped. `WIKI_CODEX_MODEL` provides a common
fallback, while `WIKI_CODEX_QUERY_MODEL`, `WIKI_CODEX_INGEST_MODEL`, and
`WIKI_CODEX_LINT_MODEL` independently select a model for each workflow. The
same resolved selection is passed to app-server and exec fallback jobs. Warmup
uses the query model as a lightweight runner readiness probe; it is not a
three-model compatibility check. Health output separates app-server protocol
readiness from model readiness and includes the detected Codex CLI version.

Reasoning effort follows the same command-scoped pattern through
`WIKI_CODEX_REASONING_EFFORT` and the `WIKI_CODEX_<COMMAND>_REASONING_EFFORT`
overrides. Lint is a canonical full-wiki audit, not a narrow or frequent check;
its intended high-assurance profile is `gpt-5.6-sol` with `high` reasoning.

Electron is the server-owned desktop shell. Its main window hosts the local web
client while the tray owns background lifecycle, hide/restore behavior,
startup, settings, and logs. The HTTP API remains the UI boundary so the
Electron internals and web client can be replaced independently. Future app
slices should surface active wiki ownership, queue state, and command model
profiles without taking wiki command policy away from the server.

The Wiki screen distinguishes the operational wiki from runtime data, reports
the local wiki's Git branch/HEAD/working-tree state, and detects Obsidian. An
Obsidian URI opens `index.md` only after the operational folder is registered as
a vault; otherwise the app opens both programs and provides one-time setup
guidance.

`tray/wiki/git-remote.cjs` owns generic Git remote import and explicit
fast-forward synchronization. It is an Electron-only management surface and
does not add or alter public HTTP routes. Import uses a validated staging clone,
a timestamped preserved backup, and same-volume atomic renames while the owned
server is stopped. Remote `AGENTS.md` trust is a visible confirmation boundary.
Pull always fetches and rechecks cleanliness and ancestry; it never resets,
forces, creates a merge commit, or resolves conflicts. Credentials stay with
system Git Credential Manager or SSH and are not app configuration.
Windows staging uses a short sibling directory plus per-repository
`core.longpaths` support so deep wiki assets remain checkoutable without
changing global Git configuration.

## Concurrency

The server keeps a single FIFO queue because `/query`, `/ingest`, and `/lint`
can all modify the same wiki worktree. Parallel writes would risk index, log,
citation, and Git-state conflicts.
