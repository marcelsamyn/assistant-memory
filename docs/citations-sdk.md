# Citation resolution (SDK)

Petals' inline-citation feature cites memory `node_*` / `claim_*` / `src_*` ids inside
assistant answers. Two capabilities this repo provides:

## `POST /citations/resolve` → `resolveCitations(ids)`
Batch-resolve a mix of node/claim/source ids to citation-ready records:
`{ requestedId, kind, available, canonicalId, title, snippet, source }`.
- **Nodes** follow merge redirects to their current survivor; a deleted node →
  `available: false`.
- **Claims** are durable (supersession keeps the id); each returns its provenance
  `source` (the document/transcript it was extracted from).
- **Sources** return their title; soft-deleted (`deletedAt`) → `available: false`.

## Node-merge redirects
`mergeNodes` previously hard-deleted consumed nodes, so any external reference to a
consumed id 404'd forever. It now writes a `node_redirects(user_id, from_node_id →
to_node_id)` row per consumed node (re-pointing existing chains to stay flat) before the
delete, so `resolveCitations` can follow `consumed → survivor` indefinitely.
