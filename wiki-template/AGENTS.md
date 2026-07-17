# Local Wiki Agent Contract

This directory is the user's local, Git-managed wiki. Treat it as durable
knowledge rather than runtime output.

- Keep navigation in `index.md` and append meaningful maintenance history to
  `log.md`.
- Preserve accepted source material under `raw/` and source records under
  `wiki/sources/` before relying on compiled pages.
- On compiled pages, `current_source` identifies the latest accepted source
  that established the page's current state; it does not by itself replace a
  broader product or design authority. Keep all material provenance in
  `sources` and state split authority explicitly in the page body.
- Store compiled knowledge in the appropriate `wiki/` category. Add or adjust
  categories when the current structure is inadequate.
- `/query` gathers scoped evidence. `/ingest` preserves and compiles supplied
  material. `/lint` is a full-wiki audit, never a scoped lint.
- Use the provided `wiki-retrieval search` command to refine graph exploration
  from different terms, identities, sources, or relations before falling back
  to broad filesystem search. Search results are routing candidates, not
  authority or update decisions.
- Review candidate metadata first. Use `wiki-retrieval read` to select a needed
  heading or line range; request a whole document only when its full context is
  explicitly necessary. Keep `index.md` as the starting navigation surface.
- Follow candidate connection metadata without reading intermediary bodies just
  to discover the next edge. Do not request a whole document merely because it
  is short; use it only when multiple or all sections are required.
- If a command changes the wiki, close the coherent checkpoint with a Git
  commit before reporting completion.
- Do not store server job logs, secrets, caches, or unrelated project files in
  the wiki.
