# Code Quality Guide

Working behavior and observable contracts come first. Structure exists to make
the next bounded change easier to locate, test, replace, and review.

## Ownership

- `src/server.ts`: HTTP routes, SSE, startup, and shutdown.
- `src/jobStore.ts`: queue state, persistence, events, metrics, and retention.
- `src/agentRunner.ts`: app-server/exec selection and fallback policy.
- `src/appServerRunner.ts`: Codex app-server protocol and process lifecycle.
- `src/config.ts`: environment and path resolution.
- `src/clientHtml.ts`: compatibility web client.
- `tray/`: Electron lifecycle and operating-system integrations.
- `desktop/`: dedicated renderer UI.

Keep the public HTTP contract stable unless a change is explicitly approved.
Internal modules may be split or replaced when behavior remains tested.

## Change Rules

- Start in the module that owns the behavior and update its paired tests.
- Keep model, network, auth, permission, and destructive migration choices
  explicit.
- Do not mix runtime observability with durable wiki knowledge.
- Prefer domain names over generic `utils`, `helpers`, or `manager` modules.
- Extract a module when it creates a narrower testable boundary, not merely to
  reduce line count.
- Preserve unrelated worktree changes and generated/runtime data.

## Verification

Use the smallest relevant check first, then close a release-sized slice with:

```powershell
npm test
npm run typecheck
npm run build
```

Run live model-backed or integration checks only when explicitly authorized.
Report the public contract, owned files, deterministic checks, rollback
boundary, and any remaining user decision surface.

## Model Quality Evaluation

The repository does not currently ship a standalone `eval/` harness. The
previous harness graded synthetic example jobs and its own mechanics, but did
not measure the quality of real wiki work. Keeping it would have overstated the
project's effective quality coverage.

Reintroduce model-quality evaluation only with a curated, representative corpus
and separate acceptance criteria for query answer quality, ingest preservation,
and full-wiki lint findings. Live runs must remain explicitly enabled because
they incur model cost. Until those inputs and judgments exist, use focused unit
and integration tests for deterministic contracts rather than example eval
fixtures.
