# User Management Surfaces

The operational wiki is local user data, not application content. Product
surfaces should make that ownership legible without turning Git or Obsidian into
requirements for ordinary query and ingest use.

## Implemented Baseline

- Open the operational wiki directory independently from runtime data.
- Open the exact runtime directory used for jobs, raw events, Codex home, and
  logs.
- Report the wiki Git branch, HEAD, commit count, and clean/changed state.
- Detect Obsidian and its URI registration on Windows.
- Distinguish an installed Obsidian from an operational wiki that has actually
  been registered as a vault.
- Open `index.md` through an encoded Obsidian URI after vault registration; give
  one-time setup guidance otherwise.

## Recommended Next Surfaces

### Data safety

1. **Backup and restore**: export a timestamped Git bundle plus current working
   files, verify it, and restore only through a previewed explicit action. Local
   Git history does not protect against disk loss.
2. **Import or relocate a wiki**: choose an existing Markdown/Git directory,
   validate the required structure, preview conflicts, and switch atomically.
3. **Recovery state**: make interrupted jobs, a dirty worktree, lock files, and
   repository integrity failures visible before another write job starts.

### Knowledge access

1. **Page browser and search**: list recently changed pages and search titles so
   a user can open a specific note in the file manager or Obsidian.
2. **Git history**: show recent wiki commits, files changed, and diffs. Restore or
   revert must remain a separate confirmation surface.
3. **Source provenance**: navigate from compiled pages to source records and raw
   artifacts without exposing job-log internals.

### Storage and interoperability

1. **Storage health**: show wiki size, runtime/log size, retention, and the last
   successful backup.
2. **Editor integration**: keep Obsidian as the default option while retaining
   plain folder and system-default Markdown actions.
3. **Optional remote Git**: remote setup, authentication, push, and pull must be
   opt-in. A local-only wiki must never publish merely because a remote exists.

The first recommended implementation slice is backup/restore, followed by
import/relocation. Both protect the user-owned data boundary before adding
convenience-oriented history and page browsing.
