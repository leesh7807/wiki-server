# Wiki Server

Installable local agent server for a user-owned, Git-managed wiki.

The server owns HTTP intake, the Codex runner, job lifecycle, runtime logs,
observability metrics, and tray startup. Installed wiki
content lives only under `%LOCALAPPDATA%\Wiki Server\wiki-root` by default and
has its own Git history. The tracked `wiki-template/` contains only the minimal
directory and operating structure for a new installation.

Agent work in this repository follows the continuous-slice rule in `AGENTS.md`:
continue through recommended implementation slices when choices are visible,
bounded, replaceable, and verified. Details are in
`docs/agent-control-and-continuous-slices.md`; day-to-day module ownership and
verification guidance is in `docs/code-quality.md`.

## Run

```powershell
npm install
npm run dev
```

Defaults:

- Host: `127.0.0.1`
- Port: `55173` (private local default; the desktop app selects a nearby free
  port and warns in-app if the default is occupied)
- Wiki root: `WIKI_ROOT`; source-only development falls back to sibling
  `..\wiki` during migration
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
`docs/desktop-app.md`. User-owned wiki management surfaces and their recommended
order are tracked in `docs/user-management-surfaces.md`.

Build an unpacked app or Windows installer with:

```powershell
npm run app:pack
npm run app:dist
```

The installed app initializes its writable wiki once under
`%LOCALAPPDATA%\Wiki Server\wiki-root`. Install, update, and uninstall preserve
that data without presenting a deletion prompt.

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

## Validation

```powershell
npm test
npm run typecheck
npm run build
```

The real Codex app-server integration remains opt-in:

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
npm run test:integration
```

## Wiki Ownership

The application repository never tracks user wiki content. `wiki-template/` is
only a small first-run scaffold. The installed operational wiki is independently
versioned, can be opened from the Wiki screen, and remains after app updates or
uninstall. Historical migration details are in
`docs/migration-from-wiki-tools.md`.
