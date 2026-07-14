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
- If a command changes the wiki, close the coherent checkpoint with a Git
  commit before reporting completion.
- Do not store server job logs, secrets, caches, or unrelated project files in
  the wiki.
