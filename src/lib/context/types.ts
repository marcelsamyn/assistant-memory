/**
 * Read-model `ContextBundle` types.
 *
 * Shape follows `docs/2026-04-24-claims-layer-design.md` "Read Models &
 * Context Bundles". A bundle is a sectioned view of derived facts plus
 * evidence refs, returned by `getConversationBootstrapContext` and consumed
 * by chat hosts and MCP `bootstrap_memory`.
 *
 * Common aliases: ContextBundle, ContextSection, bootstrap context,
 * read-model bundle.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid.js";

/** Reference to a supporting claim, surfaced alongside rendered sections. */
export const claimEvidenceSchema = z.object({
  claimId: typeIdSchema("claim"),
  sourceId: typeIdSchema("source"),
});
export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;

const baseSectionFields = {
  content: z.string().min(1),
  usage: z.string().min(1),
  evidence: z.array(claimEvidenceSchema).optional(),
};

export const contextSectionPinnedSchema = z.object({
  kind: z.literal("pinned"),
  ...baseSectionFields,
});
export type ContextSectionPinned = z.infer<typeof contextSectionPinnedSchema>;

export const contextSectionAtlasSchema = z.object({
  kind: z.literal("atlas"),
  ...baseSectionFields,
});
export type ContextSectionAtlas = z.infer<typeof contextSectionAtlasSchema>;

export const contextSectionOpenCommitmentsSchema = z.object({
  kind: z.literal("open_commitments"),
  ...baseSectionFields,
});
export type ContextSectionOpenCommitments = z.infer<
  typeof contextSectionOpenCommitmentsSchema
>;

export const contextSectionRecentSupersessionsSchema = z.object({
  kind: z.literal("recent_supersessions"),
  ...baseSectionFields,
});
export type ContextSectionRecentSupersessions = z.infer<
  typeof contextSectionRecentSupersessionsSchema
>;

export const contextSectionPreferencesSchema = z.object({
  kind: z.literal("preferences"),
  ...baseSectionFields,
});
export type ContextSectionPreferences = z.infer<
  typeof contextSectionPreferencesSchema
>;

export const contextSectionSchema = z.discriminatedUnion("kind", [
  contextSectionPinnedSchema,
  contextSectionAtlasSchema,
  contextSectionOpenCommitmentsSchema,
  contextSectionRecentSupersessionsSchema,
  contextSectionPreferencesSchema,
]);
export type ContextSection = z.infer<typeof contextSectionSchema>;

export const contextBundleSchema = z.object({
  sections: z.array(contextSectionSchema),
  assembledAt: z.coerce.date(),
});
export type ContextBundle = z.infer<typeof contextBundleSchema>;
