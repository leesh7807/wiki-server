# Migration From Wiki-Owned Server

## Goal

Move server ownership from `C:\Users\leesh\projects\wiki\tools\wiki-server` to
`C:\Users\leesh\projects\wiki-server`, then move the durable wiki into
`wiki-server\wiki-root`, without changing the client-facing HTTP contract.

This is a two-phase migration: externalize the runtime first, then consolidate
the content. The server prefers a valid embedded `wiki-root/` when it exists and
otherwise falls back to the sibling wiki. `GET /health` reports
`wikiRootSource` as `embedded`, `legacy-sibling`, or `environment` so the active
ownership boundary is observable.

## Compatibility Gate

Before removing the old implementation, the external server must pass:

```powershell
npm test
npm run typecheck
npm run build
npm run eval:replay
```

Then run a local smoke with warmup disabled:

```powershell
$env:WIKI_APP_SERVER_WARMUP = "0"
npm run dev
```

Check:

- `GET /health` reports the sibling wiki root and `legacy-sibling` before the
  content cutover.
- `GET /health` reports the external data dir.
- `/client` loads.
- `/query`, `/ingest`, and `/lint` still enqueue with `202`.
- Job metadata appears under this repo's `.cache/wiki-server/jobs/`.

## Removal Sequence

1. Stop any tray/server process launched from the wiki repo.
2. Start the external server and verify compatibility.
3. Update wiki docs to point clients to this repository.
4. Remove or replace `wiki/tools/wiki-server` with a short pointer only after
   the external server is the working default.

## Content Consolidation Sequence

Content consolidation uses a reviewed current snapshot. The wiki's own
`log.md` is retained as durable change history; the old Git repository remains
available as the rollback source during cutover.

1. Archive the current tracked wiki snapshot into `wiki-server\wiki-root`,
   including `log.md` while excluding nested `.git`, ignored runtime state, and
   the obsolete `tools/wiki-server` implementation.
2. Record the source commit and verify the extracted tracked-file count.
3. Start the server without `WIKI_ROOT` and verify that `GET /health` reports
   `wikiRootSource: embedded`.
4. Run the deterministic compatibility gate, then an explicitly approved live
   smoke for query, ingest, and lint behavior.
5. Archive or replace the sibling repository only after rollback has been
   tested. The rollback boundary is removing or renaming `wiki-root/`, which
   restores the legacy sibling fallback while that sibling remains available.

An incomplete `wiki-root/` is treated as a configuration error. This prevents a
partial import from silently running against the old sibling wiki.

The first snapshot was imported from source commit
`e11dca9979584634deb3e985fe27e7732555de71`: 1,828 tracked files were extracted,
including `log.md`, and the obsolete server implementation was excluded.

The nested wiki repository was synchronized on 2026-07-13 from source commit
`a5a4d057d372852f5277a14607f6034b2ec57cb4`. Its existing 592-commit history was
preserved, and commit `021d4ca` removed the 25 obsolete `tools/wiki-server`
files as the first nested-repository ownership commit.

## Independent Git Boundaries

`wiki-server` and `wiki-root` are intentionally separate Git repositories even
though one is physically nested inside the other. The outer repository ignores
`/wiki-root/`; it owns Electron, the HTTP service, packaging, tests, and docs.
The nested repository owns wiki content and its existing history. This prevents
a wiki checkpoint such as `git add -A` from accidentally staging server code.

Packaging copies wiki content without `.git` as `wiki-root-seed` and copies a
clean, renamed Git metadata seed separately as `wiki-git-seed`. First-run setup
combines both under `%LOCALAPPDATA%\Wiki Server\wiki-root`. Upgrades also add the
Git metadata to older managed wiki roots that predate this boundary without
overwriting their content; any prior local edits remain visible as normal Git
working-tree changes.

## Command Model Profiles

The command defaults are query `gpt-5.6-terra`, ingest `gpt-5.6-sol`, and lint
`gpt-5.6-sol`, all with high reasoning. The explicit model IDs are used instead
of moving family aliases. Overrides remain available per command.

The model changes are independent of the wiki-root migration and can be rolled
back individually or through the shared `WIKI_CODEX_MODEL`.

The intended lint profile is explicit because lint always audits the complete
wiki rather than a narrow surface:

```powershell
$env:WIKI_CODEX_LINT_MODEL = "gpt-5.6-sol"
$env:WIKI_CODEX_LINT_REASONING_EFFORT = "high"
```

Do not remove the old implementation before the external server has passed the
compatibility gate.

## Retiring The Temporary AGENTS Rule

`AGENTS.md` currently says that copied legacy server code is a compatibility
baseline, not a protected design. Keep that rule while the external repo still
contains large imported areas that agents may wrongly avoid changing.

Move or shrink that rule out of `AGENTS.md` after:

- The external server is the working default.
- The old wiki-owned server has been removed or replaced with a pointer.
- The architecture docs clearly define stable internal ownership boundaries.
- Tests, replay eval, build, and local smoke checks cover the replacement
  boundaries that matter.

After that point, the durable guidance belongs in architecture and maintenance
docs, not in the high-pressure session-start contract.
