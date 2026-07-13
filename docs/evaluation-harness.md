# Evaluation Harness

## Modes

Replay mode is the default. It reads checked-in fixture job metadata and raw
event logs, then grades expected status, final message patterns, event types,
and file observability. It does not call Codex.

Live mode is opt-in. It posts real jobs to a running local server and waits for
terminal status. Enable it with either:

```powershell
$env:WIKI_RUN_WIKI_SERVER_LIVE_EVAL = "1"
```

or:

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
```

## Case Format

Cases live under `eval/cases/*.json`.

Replay cases use:

```json
{
  "id": "query-replay-success",
  "mode": "replay",
  "command": "query",
  "content": "question",
  "fixtureJobId": "uuid",
  "expected": {
    "status": "succeeded",
    "requiredLastAgentMessagePatterns": ["answer"],
    "forbiddenLastAgentMessagePatterns": ["Traceback"],
    "eventTypes": ["status", "agent_event", "done"],
    "fileObservability": {
      "readIncludes": ["wiki/concepts/example.md"],
      "writeIncludes": ["log.md"],
      "ambiguousIncludes": ["some/path.md"]
    }
  }
}
```

Live cases use the same command and expected final-message fields, but set
`"mode": "live"` and omit fixture fields.

## Reports

Replay reports are written to `.cache/wiki-server/eval-reports/` or the
`WIKI_SERVER_DATA_DIR` equivalent. Reports are runtime artifacts and are not
committed.

Reports should summarize judgment surfaces rather than dump raw logs. Keep
terminal status, matched patterns, file observability, and concise failure
evidence visible. Treat raw events as debug evidence stored under the runtime
data directory, not as the default coordination context.

## Grading Boundary

The replay harness checks observable server contracts. It is not a semantic
judge for wiki quality. Higher-level wiki quality still requires curated review
of raw preservation, source pages, compiled pages, citations, loss review, and
lint workflow compliance.
