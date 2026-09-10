# Project Instructions

## Nitro Route Tree

- Never put tests, fixtures, mocks, or any Vitest imports under `src/routes`.
  Nitro treats files in that directory as runtime server entries, so a route-tree
  `.test.ts` file can be imported by the dev server and crash normal API
  requests. Keep route regression tests outside `src/routes` and import the
  route module from there instead.
- Tests replace `.output` with a handler-only Nitro test build. Run
  `pnpm run build` after tests before starting preview or a cross-service test server.

## Client-independent memory

Memory owns source storage, conversion, extraction, provenance, and recall for HTTP, SDK, and MCP clients. Client applications own connector access, notification policy, preparation, and external actions. Keep client names, rollout gates, and task-confirmation requirements out of the generic ingestion contract.

Preserve source content independently of derived claims. Do not claim that processing completion means every source fact was extracted. Source context is optional host-supplied provenance, not an instruction or permission channel. Document source-specific extraction limits and keep `README.md`, `docs/sdk/ingestion.md`, and `docs/sdk-consumer-migration.md` aligned when changing ingestion behavior or tool responses.
