# Code Quality Guide

Working behavior and observable contracts come first. Structure exists to make
the next bounded change easier to locate, test, replace, and review.

## Ownership

- `src/server.ts`: process composition, startup, signals, and concrete wiring.
- `src/http/`: HTTP/SSE contract, startup sequencing, and compatibility client.
- `src/jobs/jobStore.ts`: queue lifecycle, persistence, events, and retention.
- `src/jobs/jobMetrics.ts`: event-derived observability and metric normalization.
- `src/jobs/jobCommand.ts`: request validation and agent command framing.
- `src/runners/agentRunner.ts`: app-server/exec selection and fallback policy.
- `src/runners/codexAppServerRunner.ts`: Codex app-server protocol and process lifecycle.
- `src/config/`: environment and path resolution.
- `tray/main.cjs`: Electron composition and lifecycle.
- `tray/server/`, `tray/system/`, `tray/wiki/`: independently tested OS domains.
- `desktop/`: dedicated renderer UI.

Use `docs/code-map.md` to choose the first module before repository-wide search.

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
- Keep composition roots thin: concrete wiring belongs there, reusable policy
  does not.
- Import the owning module directly instead of adding barrel exports that hide
  where behavior lives.
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
