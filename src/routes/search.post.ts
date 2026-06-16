/**
 * `POST /search` — hybrid explicit-search route.
 *
 * The intentional-lookup surface: a human typing in a search box, or an
 * assistant deliberately looking something up. Fuses lexical (tsvector +
 * pg_trgm) and vector retrieval (RRF) and returns ranked hits with highlights.
 *
 * Distinct from `POST /context/search` (semantic, card-shaped, auto-injected
 * background context) and the legacy `POST /query/search` (raw graph for
 * visualization). See docs/superpowers/specs/2026-06-16-hybrid-explicit-search-design.md.
 */
// `readBody` is deliberately NOT imported: Nitro auto-imports it globally,
// which is what lets the route test stub it via vi.stubGlobal.
import { defineEventHandler } from "h3";
import { explicitSearch } from "~/lib/search/explicit-search";
import {
  searchRequestSchema,
  searchResponseSchema,
} from "~/lib/schemas/search";

export default defineEventHandler(async (event) => {
  const { userId, query, limit, scope, filters } = searchRequestSchema.parse(
    await readBody(event),
  );

  const result = await explicitSearch({ userId, query, limit, scope, filters });

  return searchResponseSchema.parse(result);
});
