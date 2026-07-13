# Wiki Server

Local agent server that is being migrated to own its wiki under `wiki-root/`.

The server owns HTTP intake, the Codex runner, job lifecycle, runtime logs,
observability metrics, tray startup, and the evaluation harness. The embedded
wiki root owns durable knowledge: its own `AGENTS.md`, raw sources, compiled
pages, citations, and `log.md`. Until the content migration is complete, the
sibling `..\wiki` remains a compatibility fallback.

Agent work in this repository follows the continuous-slice rule in `AGENTS.md`:
continue through recommended implementation slices when choices are visible,
bounded, replaceable, and verified. Details are in
`docs/agent-control-and-continuous-slices.md`.

## Run

```powershell
npm install
npm run dev
```

Defaults:

- Host: `127.0.0.1`
- Port: `55173` (private local default; the desktop app selects a nearby free
  port and warns in-app if the default is occupied)
- Wiki root: embedded `wiki-root/` when present; otherwise sibling `..\wiki`
  during migration; `WIKI_ROOT` overrides both
- Runtime data: `.cache/wiki-server`, or `WIKI_SERVER_DATA_DIR`
- Jobs: `.cache/wiki-server/jobs`
- Codex home: `.cache/wiki-server/codex-home`, or `WIKI_CODEX_HOME`
- Runner: app-server first, or `WIKI_AGENT_RUNNER=exec`
- Models: query defaults to `gpt-5.6-terra`; ingest and lint default to
  `gpt-5.6-sol`; `WIKI_CODEX_MODEL` is the shared fallback;
  `WIKI_CODEX_QUERY_MODEL`, `WIKI_CODEX_INGEST_MODEL`, and
  `WIKI_CODEX_LINT_MODEL` override it per command
- Reasoning effort: `high` by default; `WIKI_CODEX_REASONING_EFFORT` is the
  shared fallback; `WIKI_CODEX_QUERY_REASONING_EFFORT`,
  `WIKI_CODEX_INGEST_REASONING_EFFORT`, and
  `WIKI_CODEX_LINT_REASONING_EFFORT` override it per command

Open the local client at `http://127.0.0.1:55173/client`.

`npm run tray` starts the Electron desktop app and opens the client in its main
window. The desktop renderer is separate from the compatibility `/client`
website. Closing the window hides it to the tray; use **Open Wiki Server** to
restore it. Login and detached startup remain background-only.

The installable-app data and visual direction are defined in
`docs/desktop-app.md`.

Build an unpacked app or Windows installer with:

```powershell
npm run app:pack
npm run app:dist
```

The installed app initializes its writable wiki once under
`%LOCALAPPDATA%\Wiki Server`. Uninstall asks whether to preserve or delete that
data, with preservation as the default.

## API

Other repositories call the local HTTP API directly. The desktop app's **Wiki**
screen provides a short guide whose Base URL reflects the actual selected port;
copy that guide when the app reports a port fallback.

- `POST /query` with `{ "content": "neutral question text" }`
- `POST /ingest` with `{ "content": "file path, document text, or Source / Ingest context block" }`
- `POST /lint` with no body or `{}`
- `GET /jobs/<jobId>`
- `GET /jobs/<jobId>/events`
- `POST /jobs/<jobId>/cancel`
- `GET /metrics/jobs`
- `GET /health`
- `GET /` and `GET /client`

`POST /query`, `/ingest`, and `/lint` return `202` with `jobId`, `status`, and
`eventsUrl`. Read successful answers from `result.lastAgentMessage`.

## Evaluation

Replay evaluation is the default because it does not call a model:

```powershell
npm run eval:replay
```

Live evaluation is opt-in and expects a running server:

```powershell
$env:WIKI_RUN_WIKI_SERVER_LIVE_EVAL = "1"
npm run eval:live
```

Eval reports are written to `.cache/wiki-server/eval-reports/`.

## Validation

```powershell
npm test
npm run typecheck
npm run build
npm run eval:replay
```

The real Codex app-server integration remains opt-in:

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
npm run test:integration
```

## Migration

The old implementation in `C:\Users\leesh\projects\wiki\tools\wiki-server`
should stay in place until this external server passes compatibility checks.
The next migration phase imports the sibling wiki into this repository's
`wiki-root/`; see `docs/migration-from-wiki-tools.md` for the staged cutover.
