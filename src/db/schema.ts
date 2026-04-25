import { typeId } from "./typeid";
import { relations, sql } from "drizzle-orm";
import {
  check,
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
  NodeType,
  Predicate,
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

export const claims = pgTable(
  "claims",
  {
    id: typeId("claim").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    subjectNodeId: typeId("node", { name: "subject_node_id" })
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    objectNodeId: typeId("node", { name: "object_node_id" }).references(
      () => nodes.id,
      { onDelete: "cascade" },
    ),
    objectValue: text("object_value"),
    predicate: varchar("predicate", { length: 80 })
      .notNull()
      .$type<Predicate>(),
    statement: text().notNull(),
    description: text(),
    metadata: jsonb(),
    sourceId: typeId("source")
      .references(() => sources.id, {
        onDelete: "cascade",
      })
      .notNull(),
    statedAt: timestamp("stated_at", { withTimezone: true }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    status: varchar("status", { length: 30 })
      .$type<ClaimStatus>()
      .default("active")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("claims_user_id_subject_node_id_idx").on(
      table.userId,
      table.subjectNodeId,
    ),
    index("claims_user_id_object_node_id_idx").on(
      table.userId,
      table.objectNodeId,
    ),
    index("claims_user_id_predicate_idx").on(table.userId, table.predicate),
    index("claims_user_id_status_stated_at_idx").on(
      table.userId,
      table.status,
      table.statedAt,
    ),
    index("claims_user_id_subject_status_idx").on(
      table.userId,
      table.subjectNodeId,
      table.status,
    ),
    index("claims_user_id_object_status_idx")
      .on(table.userId, table.objectNodeId, table.status)
      .where(sql`${table.objectNodeId} IS NOT NULL`),
    index("claims_source_id_idx").on(table.sourceId),
    check(
      "claims_object_shape_xor_ck",
      sql`(("object_node_id" IS NOT NULL AND "object_value" IS NULL) OR ("object_node_id" IS NULL AND "object_value" IS NOT NULL))`,
    ),
  ],
);

export const claimsRelations = relations(claims, ({ one }) => ({
  user: one(users, {
    fields: [claims.userId],
    references: [users.id],
  }),
  subjectNode: one(nodes, {
    fields: [claims.subjectNodeId],
    references: [nodes.id],
  }),
  objectNode: one(nodes, {
    fields: [claims.objectNodeId],
    references: [nodes.id],
  }),
  source: one(sources, {
    fields: [claims.sourceId],
    references: [sources.id],
  }),
}));

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

export const claimEmbeddings = pgTable(
  "claim_embeddings",
  {
    id: typeId("claim_embedding").primaryKey().notNull(),
    claimId: typeId("claim", { name: "claim_id" })
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
    index("claim_embeddings_claim_id_idx").on(table.claimId),
  ],
);

export const claimEmbeddingsRelations = relations(
  claimEmbeddings,
  ({ one }) => ({
    claim: one(claims, {
      fields: [claimEmbeddings.claimId],
      references: [claims.id],
    }),
  }),
);

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
