import {
  BOOTSTRAP_MEMORY_DESCRIPTION,
  CREATE_CLAIM_DESCRIPTION,
  GET_ENTITY_DESCRIPTION,
  LIST_OPEN_COMMITMENTS_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  SEARCH_REFERENCE_DESCRIPTION,
} from "./tool-descriptions";
import { describe, expect, it } from "vitest";

/**
 * Pin model-facing MCP tool descriptions so silent edits are caught in CI.
 *
 * These strings are design-doc load-bearing
 * (see `docs/2026-04-24-claims-layer-design.md` § "MCP Tool Descriptions"):
 * they are the only signal the assistant model has about when to call each
 * tool. Update intentionally — the snapshot diff is the review surface.
 */
describe("MCP tool descriptions", () => {
  it("pins list_open_commitments description", () => {
    expect(LIST_OPEN_COMMITMENTS_DESCRIPTION).toMatchInlineSnapshot(
      `"Returns the user's currently open tasks and commitments. Call before answering about outstanding, next, pending, follow-up, completed, or abandoned work unless this model input already includes an open_commitments section. Always uses the latest status; never returns completed work."`,
    );
  });

  it("pins bootstrap_memory description", () => {
    expect(BOOTSTRAP_MEMORY_DESCRIPTION).toMatchInlineSnapshot(
      `"Returns the user's startup memory bundle: pinned facts, atlas summary, open commitments, recent task supersessions, and preferences. Call once at the start of a conversation before answering anything that depends on what the assistant already knows about the user. Sections are skipped when empty. Cached for 6 hours per user; pass forceRefresh to bypass."`,
    );
  });

  it("pins search_memory description", () => {
    expect(SEARCH_MEMORY_DESCRIPTION).toMatchInlineSnapshot(
      `"Searches the user's personal memory and returns entity cards (current facts, preferences and goals, recent evidence, aliases) plus claim evidence. Call when the bootstrap bundle doesn't already cover what you need. Never returns reference-document material; use search_reference for curated sources."`,
    );
  });

  it("pins search_reference description", () => {
    expect(SEARCH_REFERENCE_DESCRIPTION).toMatchInlineSnapshot(
      `"Searches the user's curated reference material (books, papers, ingested documents) and returns entity cards with author/title attribution. Reference results must never be cited as personal facts about the user; render them as material the user has saved, not as things the user said or did."`,
    );
  });

  it("pins get_entity description", () => {
    expect(GET_ENTITY_DESCRIPTION).toMatchInlineSnapshot(
      `"Returns a single entity card by node id: current facts, preferences and goals, open commitments (for people), recent evidence, and aliases. Use when the user names a specific person, place, or concept whose id you already have from bootstrap_memory or search_memory and you need the full picture before answering."`,
    );
  });

  it("pins create_claim description", () => {
    expect(CREATE_CLAIM_DESCRIPTION).toMatchInlineSnapshot(
      `"Creates a claim between an existing subject node and either an existing object node or a scalar object value. Returns the created claim plus subjectLabel and objectLabel so callers can immediately reflect the new relationship in the UI."`,
    );
  });
});
