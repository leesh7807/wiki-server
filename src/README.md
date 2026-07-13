# Server Source Boundaries

`server.ts` is the process composition root. Runtime code is grouped by reason
to change:

- `config/`: environment, paths, and command profiles
- `http/`: public HTTP/SSE contract and compatibility client
- `jobs/`: commands, queue state, persistence, metrics, and shared job types
- `runners/`: Codex transport selection, compatibility diagnostics, and
  process/protocol adapters

Dependencies point from `server.ts` into these domains; domains never import
the composition root. Start with `docs/code-map.md` for change routing and
reuse/extraction guidance.
