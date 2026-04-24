import { typeId } from "./typeid";
import { relations } from "drizzle-orm";
import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  vector,
  index,
  unique,
  integer,
} from "drizzle-orm/pg-core";
import {
  ClaimStatus,
  EdgeType,
  NodeType,
  SourceStatus,
  SourceType,
} from "~/types/graph";

// --- Core Ontology & Structure ---

export const users = pgTable("users", {
  id: text().primaryKey().notNull(),
});

export const nodes = pgTable(
  "nodes",
  {
    id: typeId("node").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    nodeType: varchar("node_type", { length: 50 }).notNull().$type<NodeType>(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Index on (userId, nodeType) might be useful
  },
  (table) => [
    index("nodes_user_id_idx").on(table.userId),
    index("nodes_user_id_node_type_idx").on(table.userId, table.nodeType),
  ],
);

export type NodeSelect = typeof nodes.$inferSelect;

export const nodesRelations = relations(nodes, ({ one }) => ({
  user: one(users, {
    fields: [nodes.userId],
    references: [users.id],
  }),
  metadata: one(nodeMetadata, {
    fields: [nodes.id],
    references: [nodeMetadata.nodeId],
  }),
}));

export const nodeMetadata = pgTable(
  "node_metadata",
  {
    id: typeId("node_metadata").primaryKey().notNull(),
    nodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    label: text(),
    canonicalLabel: text("canonical_label"),
    description: text(),
    additionalData: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("node_metadata_node_id_idx").on(table.nodeId),
    index("node_metadata_canonical_label_idx").on(table.canonicalLabel),
    unique().on(table.nodeId),
  ],
);

export const nodeMetadataRelations = relations(nodeMetadata, ({ one }) => ({
  node: one(nodes, {
    fields: [nodeMetadata.nodeId],
    references: [nodes.id],
  }),
}));

/**
 * Claims table — evolved from the legacy `edges` table.
 *
 * Every factual memory is a sourced, time-aware, lifecycle-tracked assertion.
 * See docs/2026-04-24-claims-layer-design.md for the full model.
 *
 * During the PR 1a → PR 1b transition, TypeScript property names keep the
 * legacy edge-shaped spelling (`sourceNodeId`, `targetNodeId`, `edgeType`,
 * `description`, `metadata`, `createdAt`) so existing consumers stay green
 * without per-file rewrites. The underlying SQL columns already use the
 * final names (`subject_node_id`, `object_node_id`, `predicate`, etc.).
 *
 * PR 1b will rename these TS properties to match the design doc
 * (`subjectNodeId`, `objectNodeId`, `predicate`) and delete the legacy
 * `edges` / `edgeEmbeddings` re-exports at the bottom of this file.
 */
export const claims = pgTable(
  "claims",
  {
    id: typeId("claim").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    // TS name kept as `sourceNodeId` for back-compat; SQL column is `subject_node_id`.
    sourceNodeId: typeId("node", { name: "subject_node_id" })
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    // TS name kept as `targetNodeId` for back-compat; SQL column is `object_node_id`.
    // Remains NOT NULL during PR 1a because no attribute claims exist yet.
    // PR 2 will alter this to nullable when attribute claims land.
    targetNodeId: typeId("node", { name: "object_node_id" })
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    objectValue: text("object_value"),
    // TS name kept as `edgeType` for back-compat; SQL column is `predicate` (widened to 80).
    edgeType: varchar("predicate", { length: 80 }).notNull().$type<EdgeType>(),
    // New claim columns. Nullable in TS so PR 1a consumers don't have to
    // supply them; PR 1b inserts them everywhere and flips to NOT NULL.
    statement: text(),
    description: text(),
    metadata: jsonb(),
    sourceId: typeId("source").references(() => sources.id, {
      onDelete: "cascade",
    }),
    statedAt: timestamp("stated_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    status: varchar("status", { length: 30 })
      .$type<ClaimStatus>()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("claims_user_id_source_node_id_idx").on(
      table.userId,
      table.sourceNodeId,
    ),
    index("claims_user_id_target_node_id_idx").on(
      table.userId,
      table.targetNodeId,
    ),
    index("claims_user_id_edge_type_idx").on(table.userId, table.edgeType),
    index("claims_user_id_status_stated_at_idx").on(
      table.userId,
      table.status,
      table.statedAt,
    ),
    index("claims_user_id_subject_status_idx").on(
      table.userId,
      table.sourceNodeId,
      table.status,
    ),
    index("claims_source_id_idx").on(table.sourceId),
  ],
);

export const claimsRelations = relations(claims, ({ one }) => ({
  user: one(users, {
    fields: [claims.userId],
    references: [users.id],
  }),
  sourceNode: one(nodes, {
    fields: [claims.sourceNodeId],
    references: [nodes.id],
  }),
  targetNode: one(nodes, {
    fields: [claims.targetNodeId],
    references: [nodes.id],
  }),
  source: one(sources, {
    fields: [claims.sourceId],
    references: [sources.id],
  }),
}));

/**
 * Transitional alias for PR 1a. Consumers that still import `edges` /
 * `edgesRelations` continue to compile; PR 1b removes these re-exports
 * alongside the predicate / subject / object rename in consumer code.
 */
export const edges = claims;
export const edgesRelations = claimsRelations;

// --- Embeddings & Search ---

export const nodeEmbeddings = pgTable(
  "node_embeddings",
  {
    id: typeId("node_embedding").primaryKey().notNull(),
    nodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(), // Dimension depends on model
    modelName: varchar("model_name", { length: 100 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Unique constraint on (nodeId, modelName)? Or allow multiple embeddings per node? Let's start with unique.
  },
  (table) => [
    index("node_embeddings_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("node_embeddings_node_id_idx").on(table.nodeId),
  ],
);

export const nodeEmbeddingsRelations = relations(nodeEmbeddings, ({ one }) => ({
  node: one(nodes, {
    fields: [nodeEmbeddings.nodeId],
    references: [nodes.id],
  }),
}));

/**
 * Claim embeddings — evolved from the legacy `edge_embeddings` table.
 *
 * TS property `edgeId` kept for back-compat; SQL column is `claim_id`.
 * PR 1b renames to `claimId` alongside consumer rewrites.
 */
export const claimEmbeddings = pgTable(
  "claim_embeddings",
  {
    id: typeId("claim_embedding").primaryKey().notNull(),
    edgeId: typeId("claim", { name: "claim_id" })
      .references(() => claims.id, { onDelete: "cascade" })
      .notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    modelName: varchar("model_name", { length: 100 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("claim_embeddings_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("claim_embeddings_claim_id_idx").on(table.edgeId),
  ],
);

export const claimEmbeddingsRelations = relations(
  claimEmbeddings,
  ({ one }) => ({
    claim: one(claims, {
      fields: [claimEmbeddings.edgeId],
      references: [claims.id],
    }),
  }),
);

// Transitional alias for PR 1a; removed in PR 1b.
export const edgeEmbeddings = claimEmbeddings;
export const edgeEmbeddingsRelations = claimEmbeddingsRelations;

// --- Aliases & Identity Resolution ---

export const aliases = pgTable(
  "aliases",
  {
    id: typeId("alias").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    aliasText: text().notNull(), // Display spelling (preserves user-facing casing).
    normalizedAliasText: text("normalized_alias_text").notNull(), // trim(lower(aliasText)) — used for matching.
    canonicalNodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("aliases_user_normalized_canonical_unique").on(
      table.userId,
      table.normalizedAliasText,
      table.canonicalNodeId,
    ),
  ],
);

export const aliasesRelations = relations(aliases, ({ one }) => ({
  user: one(users, {
    fields: [aliases.userId],
    references: [users.id],
  }),
  node: one(nodes, {
    fields: [aliases.canonicalNodeId],
    references: [nodes.id],
  }),
}));

// --- Source Tracking & Traceability ---

export const sources = pgTable(
  "sources",
  {
    id: typeId("source").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    type: varchar("type", { length: 50 }).notNull().$type<SourceType>(),
    externalId: text().notNull(),
    parentSource: typeId("source"),

    metadata: jsonb(), // e.g., Notion page title, chat participants
    lastIngestedAt: timestamp({ withTimezone: true }),
    status: varchar("status", { length: 20 })
      .default("pending")
      .$type<SourceStatus>(), // e.g., 'pending', 'processing', 'completed', 'failed', 'summarized'
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    contentType: varchar("content_type", { length: 100 }),
    contentLength: integer("content_length"),
  },
  (table) => [
    unique().on(table.userId, table.type, table.externalId),
    index("sources_user_id_idx").on(table.userId),
    index("sources_status_idx").on(table.status),
  ],
);

export type SourcesInsert = typeof sources.$inferInsert;
export type SourcesSelect = typeof sources.$inferSelect;

export const sourcesRelations = relations(sources, ({ one }) => ({
  user: one(users, {
    fields: [sources.userId],
    references: [users.id],
  }),
  parent: one(sources, {
    fields: [sources.parentSource],
    references: [sources.id],
  }),
}));

export const sourceLinks = pgTable(
  "source_links",
  {
    id: typeId("source_link").primaryKey().notNull(),
    sourceId: typeId("source")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    nodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(), // The ID of the node or edge
    // Optional: more specific location within the source (e.g., block ID, line number, timestamp in audio)
    specificLocation: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.sourceId, table.nodeId),
    index("source_links_source_id_idx").on(table.sourceId),
    index("source_links_node_id_idx").on(table.nodeId),
  ],
);

export const sourceLinksRelations = relations(sourceLinks, ({ one }) => ({
  source: one(sources, {
    fields: [sourceLinks.sourceId],
    references: [sources.id],
  }),
  node: one(nodes, {
    fields: [sourceLinks.nodeId],
    references: [nodes.id],
  }),
}));

// --- Specialized Data ---

export const userProfiles = pgTable("user_profiles", {
  id: typeId("user_profile").primaryKey().notNull(),
  userId: text()
    .references(() => users.id)
    .notNull(),
  content: text().notNull(), // The descriptive text
  lastUpdatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Index on (userId)
});

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, {
    fields: [userProfiles.userId],
    references: [users.id],
  }),
}));

export const scratchpads = pgTable(
  "scratchpads",
  {
    id: typeId("scratchpad").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    content: text().notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique().on(table.userId),
    index("scratchpads_user_id_idx").on(table.userId),
  ],
);

export const scratchpadsRelations = relations(scratchpads, ({ one }) => ({
  user: one(users, {
    fields: [scratchpads.userId],
    references: [users.id],
  }),
}));
