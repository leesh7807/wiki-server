# Desktop App

## Product Boundary

Electron is the installable desktop shell for the local wiki server. The app
owns process lifecycle, a dedicated file-based renderer, tray/background
behavior, settings, logs, and installation. A restricted preload/IPC bridge
exposes health, metrics, job commands, local open actions, and explicit
operational-wiki Git import/sync actions to the renderer.

The legacy `/client` page is not the desktop renderer. It remains a lightweight
HTTP compatibility and diagnostic surface. Other repositories continue to use
the public HTTP API directly, while the desktop app uses its IPC bridge to the
same API.

## Local API Port

The desktop app prefers `127.0.0.1:55173`. Port 4317 is intentionally avoided
because it is the standard OTLP/gRPC port. Before starting the server, the app
probes the preferred port. If occupied, it selects the first available port in
the next 40 ports and shows a visible warning with the active endpoint.

The Wiki screen owns a short, copyable integration guide. Its Base URL always
uses the actual selected port, so another repository does not need to infer
fallback behavior. The guide states only the request and asynchronous job
contract; the receiving repository owns the decision of when to call it.

The main window should grow toward four visible surfaces:

- Work: submit query, ingest, or the canonical full-wiki lint.
- Activity: queue, active job, result, events, cancellation, and history.
- Wiki: active root, source/log health, and storage location.
- Settings: per-command model and reasoning profiles, startup, logs, and
  diagnostics.

Settings includes a login-start option. Windows and macOS use Electron login
items; Linux writes an XDG autostart desktop entry. Each launches the app with
the `--hidden` argument so the local server and tray start without opening the
main window. The operating-system entry is the stored source of truth. An
AppImage entry points to the original AppImage rather than Electron's temporary
mount. Managed source launch re-enters `scripts/run-desktop.cjs`, preserving the
same data boundary, but remains valid only while the checkout and Node.js path
stay in place.

## Installable Data Layout

Packaged application resources are immutable. The checked-in `wiki-template/`
contains only a minimal directory layout and operating contract for a new wiki;
it contains no user knowledge snapshot.

Managed data stays outside both the application and source directories:

```text
%LOCALAPPDATA%\Wiki Server\
  wiki-root\        # mutable durable wiki with its own independent .git history
  runtime\          # jobs, raw events, Codex home, tray logs
  config.json       # desktop-managed settings and model profiles

${XDG_DATA_HOME:-~/.local/share}/wiki-server/
  wiki-root/        # Linux operational wiki
  runtime/          # Linux jobs, raw events, Codex home, tray logs
```

Installer upgrades must never overwrite an existing live `wiki-root/`.
Knowledge changes happen only inside the operational wiki through normal ingest
or explicit user file operations. A future folder chooser may relocate the wiki,
with `WIKI_ROOT` retained as the compatibility override.

At build time the minimal template receives a deterministic initial Git commit,
and its small Git metadata seed is packaged separately. First-run initialization
therefore creates a real repository without shipping any previous user's wiki
history. Upgrades add Git metadata only to legacy managed roots that lack it and
never overwrite their content.

Install, upgrade, source checkout replacement, and uninstall preserve the
managed data root, including the wiki, job history, logs, Codex runtime home,
and desktop config. Data deletion belongs in an explicit app-owned management
surface rather than the installer lifecycle. Application upgrades also never
overwrite the live wiki.

Source-control-only `.gitkeep` placeholders are not required in the packaged
seed. First-run initialization creates the expected empty wiki directories
explicitly after copying content.

The Wiki screen opens the operational wiki and runtime directory as separate
actions. It also exposes Git branch, HEAD, commit count, working-tree state, and
Obsidian availability. Windows checks the registered protocol and executable;
Linux checks XDG Obsidian configuration and common executable paths. The
registered `obsidian://` protocol opens operational `index.md` by absolute path.

The package configuration produces a Windows NSIS installer, a Debian package,
and a portable Linux AppImage. The NSIS and Debian artifacts are the installed
runtime. The source launcher follows the same managed-data boundary for
pre-release verification but is not presented as a system installation.

Git remote import is a two-step desktop action. The first step uses system Git
to clone into a same-volume staging directory, validates regular
`AGENTS.md`/`index.md` files and a real `wiki/` directory, and computes a
content-level preview. The confirmation surface names the timestamped backup
path and warns that the remote `AGENTS.md` becomes agent execution policy. The
second step refuses active queue work and externally managed servers, stops the
owned server process, renames the existing wiki to the backup, atomically
renames staging into place, and restarts the server. A failed second rename
rolls the backup back into place.

The staging directory is a short hidden sibling of the operational root. Clone
enables `core.longpaths` for Git for Windows and persists that repository-local
setting in the imported clone, preventing deep `raw/assets/` paths from failing
only because a verbose staging prefix pushes them beyond legacy path limits.
The Wiki screen keeps import collapsed until requested, separates Git remote
management from HTTP API integration, and never displays Electron IPC method
names in user-facing errors.

Remote checking performs an explicit `git fetch` without changing the
worktree. Fast-forward pull is enabled only for a clean branch whose local HEAD
is an ancestor of `origin/<branch>`. Dirty, ahead, detached, missing-remote, and
diverged states remain read-only. There is no scheduled sync, push, reset,
force checkout, merge commit, or conflict-resolution workflow.

GitHub and GitLab receive no special API treatment: every remote goes through
the installed Git client. Authentication is delegated to Git Credential
Manager or SSH. Credential-bearing HTTPS URLs are rejected before clone, Git
failure details are normalized, and tray logging applies a final redaction pass.

## Visual Direction

Design reference: [`tw93/Kami`](https://github.com/tw93/Kami) (MIT).

The visual direction uses:

- warm parchment canvas `#f5f4ed`;
- ink blue `#1B365D` as the single structural accent;
- serif typography for hierarchy, restrained sans-serif for controls;
- thin warm-gray rules, compact status outlines, and generous whitespace;
- no gradients, hard shadows, glass effects, or dashboard color noise;
- results should read like documents; operational data should remain scannable.

The app is a working tool, so success, warning, and failure states may use
restrained semantic colors where a single accent would reduce clarity.
