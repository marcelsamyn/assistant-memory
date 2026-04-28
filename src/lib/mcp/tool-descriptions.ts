/**
 * Model-facing descriptions for MCP tools.
 *
 * These strings are design-doc load-bearing
 * (see `docs/2026-04-24-claims-layer-design.md` § "MCP Tool Descriptions"):
 * they are the only signal the assistant model has about when to call each
 * tool. Pinned via inline snapshots in `mcp-server.test.ts` so silent edits
 * are caught in CI.
 *
 * Kept in their own module (no side-effect imports) so the snapshot tests can
 * load them without booting the rest of the server (Redis, DB, queues).
 *
 * Aliases: mcp tool description, list_open_commitments description.
 */

export const LIST_OPEN_COMMITMENTS_DESCRIPTION =
  "Returns the user's currently open tasks and commitments. Call before answering about outstanding, next, pending, follow-up, completed, or abandoned work unless this model input already includes an open_commitments section. Always uses the latest status; never returns completed work.";
