import { describe, expect, it } from "vitest";
import { LIST_OPEN_COMMITMENTS_DESCRIPTION } from "./tool-descriptions";

/**
 * Pin model-facing MCP tool descriptions so silent edits are caught in CI.
 *
 * These strings are design-doc load-bearing
 * (see `docs/2026-04-24-claims-layer-design.md` § "MCP Tool Descriptions"):
 * they are the only signal the assistant model has about when to call each
 * tool. Update intentionally — the snapshot diff is the review surface.
 *
 * TODO(2b.10): the remaining design-doc tools — `bootstrap_memory`,
 * `search_memory`, `search_reference`, `get_entity` — are not yet registered
 * with their snake_case names / scope-aware descriptions. Add inline-snapshot
 * pins for them as they land in Phase 3 (see implementation plan §3).
 */
describe("MCP tool descriptions", () => {
  it("pins list_open_commitments description", () => {
    expect(LIST_OPEN_COMMITMENTS_DESCRIPTION).toMatchInlineSnapshot(
      `"Returns the user's currently open tasks and commitments. Call before answering about outstanding, next, pending, follow-up, completed, or abandoned work unless this model input already includes an open_commitments section. Always uses the latest status; never returns completed work."`,
    );
  });
});
