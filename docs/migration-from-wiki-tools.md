# Migration From Wiki-Owned Server

## Goal

Move server ownership from `C:\Users\leesh\projects\wiki\tools\wiki-server` to
`C:\Users\leesh\projects\wiki-server`, and move the user's durable wiki to the
installed app data directory without changing the client-facing HTTP contract.

This is a two-phase migration: externalize the runtime first, then establish the
installed operational wiki. Packaged runs pass that location through
`WIKI_ROOT`; source-only development retains the sibling fallback.

## Compatibility Gate

Before removing the old implementation, the external server must pass:

```powershell
npm test
npm run typecheck
npm run build
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

## Operational Wiki Cutover

The original wiki history through `a5a4d05` was copied to
`%LOCALAPPDATA%\Wiki Server\wiki-root`. Commit `021d4ca` removed the obsolete
embedded server implementation there. The resulting operational repository has
593 commits and is independent from the application repository.

A full content copy briefly existed at `wiki-server\wiki-root` during cutover.
It was removed after the installed repository passed a clean-status and object
integrity check. The server repository now tracks only `wiki-template/`, a
minimal empty-wiki structure. New installations start with a deterministic
initial commit; they do not receive the migrated user's content or history.

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
- Tests, build, and local smoke checks cover the replacement
  boundaries that matter.

After that point, the durable guidance belongs in architecture and maintenance
docs, not in the high-pressure session-start contract.
