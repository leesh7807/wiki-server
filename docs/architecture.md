# Architecture

## Ownership Boundary

`wiki-server` owns the operational control plane:

- Fastify HTTP API and local web client
- FIFO job queue and cancellation
- Codex app-server runner plus exec fallback
- Job metadata, raw event logs, metrics, and retention
- Electron tray process and startup behavior
- Replay/live evaluation harness

The nested `wiki-root/` domain owns durable knowledge:

- Wiki operating contract and command semantics
- Raw source archive, source pages, compiled pages, index, and log
- Citation/provenance rules and lint workflow

Job logs are observability, not durable wiki knowledge. A job transcript should
be promoted into the wiki only through an explicit ingest or curated operating
note.

Agent control follows the same boundary logic. User decision surfaces are mainly
about hidden or irreversible choices; visible, bounded, replaceable, verified
choices stay on the agent execution surface. The enforceable core is in
`AGENTS.md`, with details in `docs/agent-control-and-continuous-slices.md`.

## Legacy Baseline Versus Design Boundary

The implementation imported from `wiki/tools/wiki-server` is a compatibility
baseline, not a design boundary. The HTTP contract, command semantics, and
client integration behavior are the compatibility surface. Internal structure,
module boundaries, runner plumbing, observability storage, and harness wiring
are editable surfaces for this repository.

During migration, agents should not treat copied files as untouchable legacy
code. Refactor or replace internal pieces when it improves server ownership,
evaluation, observability, or maintainability and the slice remains visible,
bounded, replaceable, and verified. The temporary rule belongs in `AGENTS.md`
only while imported code still risks being mistaken for protected design.

## Runtime Paths

The package root is `C:\Users\leesh\projects\wiki-server`. The target wiki root
is `wiki-root/` inside that repository. During migration, the server uses the
legacy sibling `C:\Users\leesh\projects\wiki` only when `wiki-root/` is absent.
If `wiki-root/` exists but is incomplete, startup fails instead of silently
falling back.

`WIKI_ROOT` overrides both locations. The server validates that the root contains
`AGENTS.md`, `index.md`, and `wiki/`.

`WIKI_SERVER_DATA_DIR` overrides runtime state. Without it, server-owned state is
stored in `.cache/wiki-server/` in this repository:

- `jobs/`
- `jobs/raw-events/`
- `codex-home/`
- `eval-reports/`
- `tray.log`

## Execution

The default runner starts `codex app-server` and submits each command as an
ephemeral thread/turn. If app-server fails before a turn starts, the server can
fall back to `codex exec --json --ephemeral`.

The public integration contract remains HTTP. The Codex app-server WebSocket is
an internal runner channel, not the external client API.

The standalone server defaults to `127.0.0.1:55173`. The desktop shell probes
that port before launch and selects a nearby free port on collision. Port
fallback is desktop state, surfaced through the renderer warning and its
copyable integration guide; it does not change endpoint semantics.

Model selection is command-scoped. `WIKI_CODEX_MODEL` provides a common
fallback, while `WIKI_CODEX_QUERY_MODEL`, `WIKI_CODEX_INGEST_MODEL`, and
`WIKI_CODEX_LINT_MODEL` independently select a model for each workflow. The
same resolved selection is passed to app-server and exec fallback jobs. Warmup
uses the query model as a lightweight runner readiness probe; it is not a
three-model compatibility check.

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

## Concurrency

The server keeps a single FIFO queue because `/query`, `/ingest`, and `/lint`
can all modify the same wiki worktree. Parallel writes would risk index, log,
citation, and Git-state conflicts.
