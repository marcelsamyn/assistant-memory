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
import { EdgeType, NodeType, SourceStatus, SourceType } from "~/types/graph";

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

export const edges = pgTable(
  "edges",
  {
    id: typeId("edge").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    sourceNodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    targetNodeId: typeId("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    edgeType: varchar("edge_type", { length: 50 }).notNull().$type<EdgeType>(), // FK to ontology_edge_types if defined
    description: text(), // Human-readable description of the edge
    // Optional: Metadata for the edge itself (e.g., confidence score, properties of the relationship)
    metadata: jsonb(),
    // Temporal aspect for relationships
    // validFrom: timestamp('valid_from'),
    // validTo: timestamp('valid_to'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Indexes on (userId, sourceNodeId), (userId, targetNodeId), (userId, edgeType)
  },
  (table) => [
    unique().on(table.sourceNodeId, table.targetNodeId, table.edgeType),
    index("edges_user_id_source_node_id_idx").on(
      table.userId,
      table.sourceNodeId,
    ),
    index("edges_user_id_target_node_id_idx").on(
      table.userId,
      table.targetNodeId,
    ),
    index("edges_user_id_edge_type_idx").on(table.userId, table.edgeType),
  ],
);

export const edgesRelations = relations(edges, ({ one }) => ({
  user: one(users, {
    fields: [edges.userId],
    references: [users.id],
  }),
  sourceNode: one(nodes, {
    fields: [edges.sourceNodeId],
    references: [nodes.id],
  }),
  targetNode: one(nodes, {
    fields: [edges.targetNodeId],
    references: [nodes.id],
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

export const edgeEmbeddings = pgTable(
  "edge_embeddings",
  {
    id: typeId("edge_embedding").primaryKey().notNull(),
    edgeId: typeId("edge")
      .references(() => edges.id, { onDelete: "cascade" })
      .notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(), // Same dimension as node embeddings
    modelName: varchar("model_name", { length: 100 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("edge_embeddings_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("edge_embeddings_edge_id_idx").on(table.edgeId),
  ],
);

export const edgeEmbeddingsRelations = relations(edgeEmbeddings, ({ one }) => ({
  edge: one(edges, {
    fields: [edgeEmbeddings.edgeId],
    references: [edges.id],
  }),
}));

// --- Aliases & Identity Resolution ---

export const aliases = pgTable("aliases", {
  id: typeId("alias").primaryKey().notNull(),
  userId: text()
    .references(() => users.id)
    .notNull(),
  aliasText: text().notNull(), // The alias string (e.g., "I", "MW", "Mom")
  canonicalNodeId: typeId("node")
    .references(() => nodes.id, { onDelete: "cascade" })
    .notNull(), // The node this alias refers to
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Index on (userId, aliasText) for fast lookups
  // Index on (userId, canonicalNodeId)
});

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
