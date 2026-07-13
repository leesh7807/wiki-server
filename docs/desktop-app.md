# Desktop App

## Product Boundary

Electron is the installable desktop shell for the local wiki server. The app
owns process lifecycle, a dedicated file-based renderer, tray/background
behavior, settings, logs, and installation. A restricted preload/IPC bridge
exposes only health, metrics, submit, job, cancel, and local open actions to the
renderer.

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

Settings includes a Windows login-start option. When enabled, Electron registers
the packaged executable with the `--hidden` argument. On the next login the app
starts the local server and tray in the background without opening its main
window. The operating-system login item is the stored source of truth, so the
toggle remains accurate across app restarts and installer upgrades.

## Installable Data Layout

Packaged application resources are immutable. The checked-in `wiki-template/`
contains only a minimal directory layout and operating contract for a new wiki;
it contains no user knowledge snapshot.

Recommended Windows layout:

```text
%LOCALAPPDATA%\Wiki Server\
  wiki-root\        # mutable durable wiki with its own independent .git history
  runtime\          # jobs, raw events, Codex home, eval reports, tray logs
  config.json       # desktop-managed settings and model profiles
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

Install, upgrade, and uninstall never present a data-deletion prompt. They
always preserve `%LOCALAPPDATA%\Wiki Server`, including the wiki, job history,
logs, Codex runtime home, and desktop config. Data deletion belongs in an
explicit app-owned management surface rather than the installer lifecycle.
Application upgrades also never overwrite the live wiki.

Source-control-only `.gitkeep` placeholders are not required in the packaged
seed. First-run initialization creates the expected empty wiki directories
explicitly after copying content.

The Wiki screen opens the operational wiki and runtime directory as separate
actions. It also exposes Git branch, HEAD, commit count, working-tree state, and
Obsidian availability. Obsidian integration uses the registered `obsidian://`
protocol and opens the operational `index.md` by absolute path.

## Visual Direction

The visual direction adapts the MIT-licensed `tw93/kami` constraint system
rather than copying its pages literally:

- warm parchment canvas `#f5f4ed`;
- ink blue `#1B365D` as the single structural accent;
- serif typography for hierarchy, restrained sans-serif for controls;
- thin warm-gray rules, compact status outlines, and generous whitespace;
- no gradients, hard shadows, glass effects, or dashboard color noise;
- results should read like documents; operational data should remain scannable.

The app is a working tool, so success, warning, and failure states may use
restrained semantic colors where a single accent would reduce clarity.
