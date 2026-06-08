import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const resolveCitationsRequestSchema = z.object({
  userId: z.string(),
  ids: z.array(z.string().max(200)).max(200),
});
export type ResolveCitationsRequest = z.infer<
  typeof resolveCitationsRequestSchema
>;

export const resolvedCitationSchema = z.object({
  /** The id as requested (may be a since-merged node id). */
  requestedId: z.string(),
  kind: z.enum(["node", "claim", "source"]),
  available: z.boolean(),
  /** For nodes, the survivor after following redirects; null when unavailable. */
  canonicalId: z.string().nullable(),
  title: z.string().nullable(),
  snippet: z.string().nullable(),
  /** Provenance: for a claim, the source it was extracted from. */
  source: z
    .object({
      id: typeIdSchema("source"),
      title: z.string().nullable(),
      type: z.string(),
    })
    .nullable(),
  /** For a claim, the node it is asserted about (its subject); for deep-linking. */
  subjectNodeId: typeIdSchema("node").nullable().optional(),
});
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>;

export const resolveCitationsResponseSchema = z.object({
  citations: z.array(resolvedCitationSchema),
});
export type ResolveCitationsResponse = z.infer<
  typeof resolveCitationsResponseSchema
>;
