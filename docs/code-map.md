# Code Map

Use this map before searching broadly. It identifies the first module to open,
the behavior each boundary owns, and when existing code should be reused rather
than copied or generalized.

## Runtime Dependency Direction

```text
src/server.ts (composition root)
  -> config/
  -> http/ -> jobs/
  -> retrieval/ -> jobs/
  -> runners/ -> jobs/
  -> jobs/

tray/main.cjs (Electron composition root)
  -> tray/server/
  -> tray/system/
  -> tray/wiki/
  -> desktop/ through the preload IPC contract
```

Domain modules must not import either composition root. `jobs/` must not depend
on HTTP, Electron, or a concrete Codex transport. `http/` may use narrow job
store capabilities, while `runners/` may consume job commands and types. Keep
imports pointed at the owning module; do not add barrel files whose only effect
is to hide ownership.

## Where To Start

| Change | First module | Nearby verification |
| --- | --- | --- |
| HTTP route, status code, SSE, response body | `src/http/wikiHttpServer.ts` | `wikiHttpServer.test.ts` |
| Compatibility browser client | `src/http/clientHtml.ts` | `clientHtml.test.ts` |
| Command body validation or agent prompt framing | `src/jobs/jobCommand.ts` | `jobCommand.test.ts` |
| Queueing, cancellation, persistence, retention | `src/jobs/jobStore.ts` | `jobStore.test.ts` |
| Token/file/retrieval event interpretation and metric normalization | `src/jobs/jobMetrics.ts`, `src/jobs/retrievalMetrics.ts` | `jobStore.test.ts`, `retrievalMetrics.test.ts` |
| Public job/event/result shape | `src/jobs/jobTypes.ts` | consumers in `http/` and `runners/` |
| Wiki graph parsing, repeatable metadata-only search, selective reads, lint partitions | `src/retrieval/wikiRetrieval.ts` | `wikiRetrieval.test.ts` |
| Agent-facing retrieval command and private loopback adapter | `src/retrieval/wikiRetrievalCommand.ts`, `src/http/wikiHttpServer.ts` | `wikiRetrievalCommand.test.ts`, `wikiHttpServer.test.ts` |
| App-server versus exec fallback policy | `src/runners/agentRunner.ts` | `agentRunner.test.ts` |
| Codex app-server wire protocol and lifecycle | `src/runners/codexAppServerRunner.ts` | runner and protocol tests beside it |
| `codex exec` process handling and isolated environment | `src/runners/codexExecRunner.ts` | `codexExecRunner.test.ts` and fallback cases in `agentRunner.test.ts` |
| Installed Codex version detection | `src/runners/codexVersion.ts` | `codexVersion.test.ts` |
| Environment, paths, model profiles | `src/config/wikiServerConfig.ts` | `wikiServerConfig.test.ts` |
| Tray-side Codex command selection | `tray/server/codex-command.cjs` | `codex-command.test.cjs` |
| Process startup, signals, concrete wiring | `src/server.ts` | typecheck, build, focused boundary tests |
| Electron server endpoint and port behavior | `tray/server/` | tests beside each module |
| Login/startup integration | `tray/system/` | tests beside each module |
| Operational wiki and Obsidian integration | `tray/wiki/` | tests beside each module |
| Generic Git remote import, backup swap, and guarded fast-forward pull | `tray/wiki/git-remote.cjs` | `git-remote.test.cjs` and desktop contract tests |
| Window/tray lifecycle and IPC registration | `tray/main.cjs` | `desktop/desktop.test.cjs` plus tray tests |
| Dedicated renderer state and views | `desktop/app.js` | `desktop/desktop.test.cjs` |
| First-install wiki structure | `wiki-template/` | `tray/wiki-repository.test.cjs` |

## Reuse And Extraction Rules

Reuse an owning module when the new behavior changes for the same reason as
that module. Add a narrow exported operation or injected capability when it
makes the boundary easier to test. Do not copy validation, terminal-status,
path, or process-policy logic into a second domain.

Extract a new module when all of these are true:

1. The responsibility has a distinct reason to change.
2. Its inputs and outputs can be named without leaking composition-root state.
3. It can be verified through focused tests or existing contract tests.
4. The dependency direction above remains intact.

Avoid generic `utils`, `helpers`, `common`, and broad `manager` modules. A
domain name should answer why the code exists. Size alone is not an extraction
reason: the app-server protocol module is intentionally cohesive until a stable
wire/process seam can be named and tested.

## Composition Roots

`src/server.ts` and `tray/main.cjs` are allowed to know concrete modules and
environment details. They should assemble dependencies and own lifecycle, but
new business rules should move to a domain module with a focused test. This is
the main guard against the repository becoming flat again.
