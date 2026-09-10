import { typeId, typeIdNoDefault } from "./typeid";
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
  primaryKey,
  integer,
  bigint,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import {
  AssertedByKind,
  ClaimStatus,
  NodeType,
  Predicate,
  Scope,
  SourceStatus,
  SourceType,
} from "~/types/graph";

// --- Core Ontology & Structure ---

export const users = pgTable("users", {
  id: text().primaryKey().notNull(),
});

/** Caller-owned opaque partitions registered for a user. */
export const memoryPartitions = pgTable(
  "memory_partitions",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    partitionKey: varchar("partition_key", { length: 200 })
      .$type<ContextPartitionKey>()
      .notNull(),
    status: varchar({ length: 20 })
      .$type<"active" | "quarantined">()
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
    primaryKey({ columns: [table.userId, table.partitionKey] }),
    check(
      "memory_partitions_status_ck",
      sql`"status" IN ('active', 'quarantined')`,
    ),
  ],
);

/**
 * Compatibility fence for legacy unpartitioned callers. Missing row means
 * `unmigrated`; once present, unpartitioned reads and writes fail closed.
 */
export const partitionMigrationState = pgTable(
  "partition_migration_state",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    state: varchar({ length: 20 }).$type<"migrating" | "migrated">().notNull(),
    version: integer().default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  () => [
    check(
      "partition_migration_state_state_ck",
      sql`"state" IN ('migrating', 'migrated')`,
    ),
    check("partition_migration_state_version_ck", sql`"version" > 0`),
  ],
);

export const nodes = pgTable(
  "nodes",
  {
    id: typeId("node").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    nodeType: varchar("node_type", { length: 50 }).notNull().$type<NodeType>(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Index on (userId, nodeType) might be useful
  },
  (table) => [
    index("nodes_user_id_idx").on(table.userId),
    index("nodes_user_partition_idx").on(table.userId, table.partitionKey),
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
    objectNodeId: typeIdNoDefault("node", {
      name: "object_node_id",
    }).references(() => nodes.id, { onDelete: "cascade" }),
    objectValue: text("object_value"),
    predicate: varchar("predicate", { length: 80 })
      .notNull()
      .$type<Predicate>(),
    statement: text().notNull(),
    description: text(),
    metadata: jsonb(),
    /**
     * Resolved UTC instant of a time-qualified temporal-object claim — currently
     * a `DUE_ON` whose `metadata` carries a wall-clock `dueTime` + IANA `timeZone`.
     * NULL for date-only and non-temporal claims. Denormalized from
     * (day-node date, dueTime, timeZone) for indexed instant-range queries.
     */
    objectInstant: timestamp("object_instant", { withTimezone: true }),
    sourceId: typeId("source")
      .references(() => sources.id, {
        onDelete: "cascade",
      })
      .notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    scope: varchar("scope", { length: 16 })
      .notNull()
      .$type<Scope>()
      .default("personal"),
    assertedByKind: varchar("asserted_by_kind", { length: 24 })
      .notNull()
      .$type<AssertedByKind>(),
    assertedByNodeId: typeIdNoDefault("node", {
      name: "asserted_by_node_id",
    }).references(() => nodes.id, { onDelete: "set null" }),
    supersededByClaimId: typeIdNoDefault("claim", {
      name: "superseded_by_claim_id",
    }).references((): AnyPgColumn => claims.id, { onDelete: "set null" }),
    contradictedByClaimId: typeIdNoDefault("claim", {
      name: "contradicted_by_claim_id",
    }).references((): AnyPgColumn => claims.id, { onDelete: "set null" }),
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
    index("claims_user_scope_status_stated_at_idx").on(
      table.userId,
      table.scope,
      table.status,
      table.statedAt,
    ),
    index("claims_user_scope_kind_status_idx").on(
      table.userId,
      table.scope,
      table.assertedByKind,
      table.status,
    ),
    index("claims_user_id_subject_status_idx").on(
      table.userId,
      table.subjectNodeId,
      table.status,
    ),
    index("claims_user_id_object_status_idx")
      .on(table.userId, table.objectNodeId, table.status)
      .where(sql`${table.objectNodeId} IS NOT NULL`),
    index("claims_trusted_open_task_status_idx")
      .on(
        table.userId,
        table.statedAt.desc(),
        table.createdAt.desc(),
        table.subjectNodeId,
      )
      .where(
        sql`${table.predicate} = 'HAS_TASK_STATUS' AND ${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.assertedByKind} <> 'assistant_inferred' AND ${table.objectValue} IN ('pending', 'in_progress')`,
      ),
    index("claims_candidate_open_task_status_idx")
      .on(
        table.userId,
        table.statedAt.desc(),
        table.createdAt.desc(),
        table.subjectNodeId,
      )
      .where(
        sql`${table.predicate} = 'HAS_TASK_STATUS' AND ${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.assertedByKind} = 'assistant_inferred' AND ${table.objectValue} IN ('pending', 'in_progress')`,
      ),
    index("claims_task_metadata_lookup_idx")
      .on(
        table.userId,
        table.subjectNodeId,
        table.predicate,
        table.statedAt.desc(),
      )
      .where(
        sql`${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.predicate} IN ('ASSIGNED_TO', 'DUE_ON') AND ${table.objectNodeId} IS NOT NULL`,
      ),
    index("claims_due_instant_idx")
      .on(table.userId, table.objectInstant)
      .where(
        sql`${table.predicate} = 'DUE_ON' AND ${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.objectInstant} IS NOT NULL`,
      ),
    // Rollup discovery sweep (src/lib/jobs/rollup.ts): active OCCURRED_ON
    // claims past the per-user watermark, without heap-filtering a heavy
    // user's full claim history on a first sweep.
    index("claims_occurred_on_discovery_idx")
      .on(table.userId, table.createdAt)
      .where(
        sql`${table.predicate} = 'OCCURRED_ON' AND ${table.status} = 'active'`,
      ),
    index("claims_source_id_idx").on(table.sourceId),
    index("claims_user_partition_status_stated_at_idx").on(
      table.userId,
      table.partitionKey,
      table.status,
      table.statedAt,
    ),
    check(
      "claims_object_shape_xor_ck",
      sql`(("object_node_id" IS NOT NULL AND "object_value" IS NULL) OR ("object_node_id" IS NULL AND "object_value" IS NOT NULL))`,
    ),
    check("claims_scope_ck", sql`"scope" IN ('personal', 'reference')`),
    check(
      "claims_asserted_by_kind_ck",
      sql`"asserted_by_kind" IN ('user', 'user_confirmed', 'assistant_inferred', 'participant', 'document_author', 'system')`,
    ),
    check(
      "claims_asserted_by_node_consistency_ck",
      sql`(("asserted_by_kind" = 'participant' AND "asserted_by_node_id" IS NOT NULL) OR "asserted_by_kind" <> 'participant')`,
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
  assertedByNode: one(nodes, {
    fields: [claims.assertedByNodeId],
    references: [nodes.id],
  }),
  supersededByClaim: one(claims, {
    fields: [claims.supersededByClaimId],
    references: [claims.id],
    relationName: "claimSupersession",
  }),
  contradictedByClaim: one(claims, {
    fields: [claims.contradictedByClaimId],
    references: [claims.id],
    relationName: "claimContradiction",
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
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("aliases_user_normalized_canonical_unique").on(
      table.userId,
      table.normalizedAliasText,
      table.canonicalNodeId,
    ),
    index("aliases_user_partition_normalized_idx").on(
      table.userId,
      table.partitionKey,
      table.normalizedAliasText,
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
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    /**
     * Database-managed ABA fence. The migration trigger increments this once
     * when partition, parent, scope, type, external identity, metadata,
     * ingestion time, status, deletion, or content descriptors change.
     */
    version: integer().default(0).notNull(),
    parentSource: typeIdNoDefault("source"),
    scope: varchar("scope", { length: 16 })
      .notNull()
      .$type<Scope>()
      .default("personal"),

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
    index("sources_user_partition_idx").on(table.userId, table.partitionKey),
    index("sources_status_idx").on(table.status),
    check("sources_scope_ck", sql`"scope" IN ('personal', 'reference')`),
    check("sources_version_ck", sql`"version" >= 0`),
  ],
);

export type SourcesInsert = typeof sources.$inferInsert;
export type SourcesSelect = typeof sources.$inferSelect;

/**
 * Non-content terminal record used to redact historical feed events after a
 * source is erased. It intentionally has no FK to `sources`: purge removes
 * the source row while this privacy boundary must survive.
 */
export const sourceTombstones = pgTable(
  "source_tombstones",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    state: varchar({ length: 20 })
      .$type<"tombstoned" | "restored" | "purged">()
      .notNull(),
    storageCleanupState: varchar("storage_cleanup_state", { length: 20 })
      .$type<"not_required" | "pending" | "completed">()
      .notNull()
      .default("not_required"),
    /** Durable completion receipt for legacy read-model erasure recovery. */
    readModelCleanupState: varchar("read_model_cleanup_state", { length: 20 })
      .$type<"not_required" | "pending" | "completed">()
      .notNull()
      .default("not_required"),
    /** Opaque object-store key captured before the source row can disappear. */
    storageObjectKey: text("storage_object_key"),
    erasedAt: timestamp("erased_at", { withTimezone: true }).notNull(),
    restorableUntil: timestamp("restorable_until", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.sourceId] }),
    index("source_tombstones_user_source_idx").on(table.userId, table.sourceId),
    check(
      "source_tombstones_state_ck",
      sql`"state" IN ('tombstoned', 'restored', 'purged')`,
    ),
    check(
      "source_tombstones_storage_cleanup_state_ck",
      sql`"storage_cleanup_state" IN ('not_required', 'pending', 'completed')`,
    ),
    check(
      "source_tombstones_read_model_cleanup_state_ck",
      sql`"read_model_cleanup_state" IN ('not_required', 'pending', 'completed')`,
    ),
  ],
);

/**
 * Durable coordination record for a source blob upload.
 *
 * The object store is deliberately outside the source transaction. This row
 * gives source erasure a database fence around that external side effect: an
 * uploader must claim it before putting bytes, and a tombstone transitions it
 * to cleanup before its own object-cleanup receipt may complete. It has no
 * foreign key because a purge must leave the cleanup authority intact.
 */
export const sourceBlobUploads = pgTable(
  "source_blob_uploads",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    objectKey: text("object_key").notNull(),
    state: varchar({ length: 24 })
      .$type<
        | "reserved"
        | "uploading"
        | "upload_unknown"
        | "uploaded"
        | "cleanup_pending"
        | "cleanup_completed"
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    cleanupCompletedAt: timestamp("cleanup_completed_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.sourceId] }),
    index("source_blob_uploads_cleanup_idx").on(table.state, table.updatedAt),
    check(
      "source_blob_uploads_state_ck",
      sql`"state" IN ('reserved', 'uploading', 'upload_unknown', 'uploaded', 'cleanup_pending', 'cleanup_completed')`,
    ),
  ],
);

/** Immutable, non-content command receipt for source lifecycle maintenance. */
export const sourceLifecycleCommands = pgTable(
  "source_lifecycle_commands",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    commandId: varchar("command_id", { length: 200 }).notNull(),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    expectedPartitionKey: varchar("expected_partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    expectedSourceVersion: integer("expected_source_version").notNull(),
    action: varchar({ length: 20 })
      .$type<"tombstone" | "restore" | "purge">()
      .notNull(),
    state: varchar({ length: 20 })
      .$type<"tombstoned" | "restored" | "purged">()
      .notNull(),
    sourceVersion: integer("source_version"),
    restorableUntil: timestamp("restorable_until", { withTimezone: true }),
    storageCleanupState: varchar("storage_cleanup_state", { length: 20 })
      .$type<"not_required" | "pending" | "completed">()
      .notNull()
      .default("not_required"),
    /** Complete root-operation cleanup snapshot; survives restore and purge. */
    storageObjectKeys: text("storage_object_keys")
      .array()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.commandId] }),
    check(
      "source_lifecycle_commands_action_ck",
      sql`"action" IN ('tombstone', 'restore', 'purge')`,
    ),
    check(
      "source_lifecycle_commands_state_ck",
      sql`"state" IN ('tombstoned', 'restored', 'purged')`,
    ),
    check(
      "source_lifecycle_commands_expected_version_ck",
      sql`"expected_source_version" >= 0`,
    ),
    check(
      "source_lifecycle_commands_storage_cleanup_state_ck",
      sql`"storage_cleanup_state" IN ('not_required', 'pending', 'completed')`,
    ),
  ],
);

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

/**
 * Durable receipt for one accepted source content revision. It has no foreign
 * key to `sources`: purge keeps this privacy-safe terminal receipt while the
 * source row and its content are removed.
 */
export const sourceIngestionOperations = pgTable(
  "source_ingestion_operations",
  {
    operationId: varchar("operation_id", { length: 200 }).primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    externalId: text("external_id").notNull(),
    contentHash: varchar("content_hash", { length: 128 }),
    sourceVersion: integer("source_version").notNull(),
    status: varchar("status", { length: 20 })
      .$type<"queued" | "processing" | "completed" | "failed" | "purged">()
      .notNull(),
    stage: varchar("stage", { length: 20 })
      .$type<"content" | "extraction">()
      .notNull(),
    attempt: integer("attempt").notNull().default(0),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("source_ingestion_operations_source_idx").on(
      table.userId,
      table.sourceId,
      table.createdAt,
    ),
    index("source_ingestion_operations_status_idx").on(
      table.userId,
      table.partitionKey,
      table.status,
    ),
    unique("source_ingestion_operations_content_unique").on(
      table.userId,
      table.sourceId,
      table.contentHash,
    ),
    check(
      "source_ingestion_operations_status_ck",
      sql`"status" IN ('queued', 'processing', 'completed', 'failed', 'purged')`,
    ),
    check(
      "source_ingestion_operations_stage_ck",
      sql`"stage" IN ('content', 'extraction')`,
    ),
    check("source_ingestion_operations_attempt_ck", sql`"attempt" >= 0`),
    check(
      "source_ingestion_operations_source_version_ck",
      sql`"source_version" >= 0`,
    ),
  ],
);

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

/**
 * Records that a consumed node was merged into a survivor, so stale references
 * (e.g. citations) can follow `from → to`. `from_node_id` intentionally has NO
 * FK: the consumed node row is deleted by the merge, but the redirect must
 * survive it. Common aliases: node redirect, merge tombstone, node alias.
 */
export const nodeRedirects = pgTable(
  "node_redirects",
  {
    userId: text()
      .references(() => users.id)
      .notNull(),
    fromNodeId: typeIdNoDefault("node", { name: "from_node_id" }).notNull(),
    toNodeId: typeId("node", { name: "to_node_id" })
      .references(() => nodes.id, { onDelete: "cascade" })
      .notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fromNodeId] }),
    index("node_redirects_user_to_node_idx").on(table.userId, table.toNodeId),
  ],
);

/**
 * Durable old-to-new identity split ledger. A completed mapping proves the
 * old node's partition-specific support was rebuilt under `replacementNodeId`;
 * quarantined mappings are excluded from partition-specific retrieval.
 */
export const partitionNodeMappings = pgTable(
  "partition_node_mappings",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    sourceNodeId: typeIdNoDefault("node", {
      name: "source_node_id",
    }).notNull(),
    partitionKey: varchar("partition_key", { length: 200 })
      .$type<ContextPartitionKey>()
      .notNull(),
    replacementNodeId: typeIdNoDefault("node", {
      name: "replacement_node_id",
    }),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    bindingGeneration: varchar("binding_generation", { length: 200 }).notNull(),
    state: varchar({ length: 20 })
      .$type<"quarantined" | "completed">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.sourceNodeId, table.partitionKey],
    }),
    index("partition_node_mappings_replacement_idx").on(
      table.userId,
      table.replacementNodeId,
    ),
    check(
      "partition_node_mappings_state_ck",
      sql`"state" IN ('quarantined', 'completed')`,
    ),
    check(
      "partition_node_mappings_completion_ck",
      sql`"state" <> 'completed' OR "replacement_node_id" IS NOT NULL`,
    ),
  ],
);

/**
 * Durable disposition for derivative data encountered while splitting a node.
 * Stable text identifiers deliberately survive ordinary source or node
 * deletion; deleting the owning user still removes the recovery history.
 */
export const partitionArtifactReceipts = pgTable(
  "partition_artifact_receipts",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    sourceNodeId: typeIdNoDefault("node", {
      name: "source_node_id",
    }).notNull(),
    partitionKey: varchar("partition_key", { length: 200 })
      .$type<ContextPartitionKey>()
      .notNull(),
    artifactKind: varchar("artifact_kind", { length: 40 })
      .$type<
        | "aliases"
        | "node_embeddings"
        | "redirects"
        | "summary"
        | "user_profile"
        | "commitment_presentation"
      >()
      .notNull(),
    disposition: varchar({ length: 24 })
      .$type<"pending" | "rebuilt" | "quarantined" | "not_applicable">()
      .notNull(),
    sourceCount: integer("source_count").notNull(),
    rebuiltCount: integer("rebuilt_count").notNull(),
    quarantinedCount: integer("quarantined_count").notNull(),
    details: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.userId,
        table.sourceNodeId,
        table.partitionKey,
        table.artifactKind,
      ],
    }),
    check(
      "partition_artifact_receipts_kind_ck",
      sql`"artifact_kind" IN ('aliases', 'node_embeddings', 'redirects', 'summary', 'user_profile', 'commitment_presentation')`,
    ),
    check(
      "partition_artifact_receipts_disposition_ck",
      sql`"disposition" IN ('pending', 'rebuilt', 'quarantined', 'not_applicable')`,
    ),
    check(
      "partition_artifact_receipts_counts_ck",
      sql`"source_count" >= 0 AND "rebuilt_count" >= 0 AND "quarantined_count" >= 0 AND "rebuilt_count" + "quarantined_count" <= "source_count"`,
    ),
    check(
      "partition_artifact_receipts_terminal_counts_ck",
      sql`"disposition" = 'pending' OR "rebuilt_count" + "quarantined_count" = "source_count"`,
    ),
  ],
);

/** Idempotency and compare-and-set receipt for cross-repository moves. */
export const sourcePartitionCommands = pgTable(
  "source_partition_commands",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    bindingGeneration: varchar("binding_generation", { length: 200 }).notNull(),
    sourceId: typeIdNoDefault("source", { name: "source_id" }).notNull(),
    expectedPartitionKey: varchar("expected_partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    targetPartitionKey: varchar("target_partition_key", { length: 200 })
      .$type<ContextPartitionKey>()
      .notNull(),
    expectedSourceVersion: integer("expected_source_version").notNull(),
    sourceVersion: integer("source_version").notNull(),
    movedClaimCount: integer("moved_claim_count").notNull(),
    /** Every parent/child source moved by this atomic command. */
    sourceIds: jsonb("source_ids").notNull().default([]),
    nodeMappings: jsonb("node_mappings").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bindingGeneration] }),
    unique("source_partition_commands_source_version_unique").on(
      table.userId,
      table.sourceId,
      table.sourceVersion,
    ),
    check(
      "source_partition_commands_versions_ck",
      sql`"expected_source_version" >= 0 AND "source_version" = "expected_source_version" + 1`,
    ),
    check(
      "source_partition_commands_claim_count_ck",
      sql`"moved_claim_count" >= 0`,
    ),
  ],
);

/**
 * Per-user/partition append heads for the lossless lifecycle feed. The
 * nullable partition key deliberately uses a NULLS NOT DISTINCT unique
 * constraint: unmigrated users have one global feed head, while partitioned
 * users have one independent sequence per opaque partition.
 */
export const memoryChangeFeedHeads = pgTable(
  "memory_change_feed_heads",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    feedEpoch: integer("feed_epoch").notNull().default(1),
    nextSequence: bigint("next_sequence", { mode: "number" })
      .notNull()
      .default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("memory_change_feed_heads_user_partition_unique")
      .on(table.userId, table.partitionKey)
      .nullsNotDistinct(),
    check("memory_change_feed_heads_epoch_ck", sql`${table.feedEpoch} > 0`),
    check(
      "memory_change_feed_heads_sequence_ck",
      sql`${table.nextSequence} > 0`,
    ),
  ],
);

/**
 * Immutable lifecycle events. Event rows are append-only; the database
 * trigger allocates `sequence` while holding the matching head row lock, so
 * a committed transaction can never expose a gap or advance a consumer
 * checkpoint ahead of its projection.
 */
export const memoryChangeFeedEvents = pgTable(
  "memory_change_feed_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    feedEpoch: integer("feed_epoch").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    action: varchar("action", { length: 40 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: text("entity_id"),
    sourceId: typeIdNoDefault("source", { name: "source_id" }),
    effectiveChangeTime: timestamp("effective_change_time", {
      withTimezone: true,
    }).notNull(),
    provenance: jsonb(),
    freshness: jsonb(),
    status: varchar("status", { length: 30 }),
    payload: jsonb().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("memory_change_feed_events_user_partition_epoch_sequence_unique")
      .on(table.userId, table.partitionKey, table.feedEpoch, table.sequence)
      .nullsNotDistinct(),
    index("memory_change_feed_events_cursor_idx").on(
      table.userId,
      table.partitionKey,
      table.feedEpoch,
      table.sequence,
    ),
    index("memory_change_feed_events_source_idx").on(
      table.userId,
      table.sourceId,
    ),
    check("memory_change_feed_events_epoch_ck", sql`${table.feedEpoch} > 0`),
    check("memory_change_feed_events_sequence_ck", sql`${table.sequence} > 0`),
  ],
);

// --- Specialized Data ---

export const userProfiles = pgTable("user_profiles", {
  id: typeId("user_profile").primaryKey().notNull(),
  userId: text()
    .references(() => users.id)
    .notNull(),
  content: text().notNull(), // The descriptive text
  metadata: jsonb().notNull().default({}),
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
    /** User-global assistant workspace; never evidence or room memory. */
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

/**
 * Per-user temporal-rollup sweep state (see
 * docs/superpowers/specs/2026-06-12-temporal-rollup-design.md).
 *
 * `watermark`: max `claims.createdAt` whose OCCURRED_ON claims have been
 * incorporated into the work set. Always advances; deferred work is
 * carried by `pendingPeriods`, never by holding the watermark back.
 * `pendingPeriods`: period keys (day/week/month/year) awaiting
 * summarization — incomplete periods, over-budget leftovers, failures.
 */
export const rollupState = pgTable(
  "rollup_state",
  {
    userId: text()
      .notNull()
      .references(() => users.id),
    partitionKey: varchar("partition_key", {
      length: 200,
    }).$type<ContextPartitionKey>(),
    watermark: timestamp({ withTimezone: true }),
    pendingPeriods: jsonb().$type<string[]>().notNull().default([]),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("rollup_state_user_partition_unique")
      .on(table.userId, table.partitionKey)
      .nullsNotDistinct(),
  ],
);

export const rollupStateRelations = relations(rollupState, ({ one }) => ({
  user: one(users, {
    fields: [rollupState.userId],
    references: [users.id],
  }),
}));

/**
 * Per-commitment presentation evidence (1:1 with a Task node): a verbatim
 * `excerpt` and a generated `why`, produced when the Task is first inferred.
 * Provenance (source title + timestamp) is NOT stored here — it is joined from
 * `sources` via the commitment's active status-claim `sourceId` at read time.
 * Decoupled from claims so it never rides a superseded status claim.
 */
export const commitmentPresentations = pgTable(
  "commitment_presentations",
  {
    taskId: typeIdNoDefault("node")
      .references(() => nodes.id, { onDelete: "cascade" })
      .primaryKey()
      .notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    sourceId: typeIdNoDefault("source")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    excerpt: text(),
    why: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("commitment_presentations_user_id_idx").on(table.userId)],
);

// --- Metrics ---

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: typeId("metric_definition").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    slug: text().notNull(),
    label: text().notNull(),
    description: text().notNull(),
    unit: text().notNull(),
    aggregationHint: varchar("aggregation_hint", { length: 8 })
      .notNull()
      .$type<"avg" | "sum" | "min" | "max">(),
    validRangeMin: text("valid_range_min"),
    validRangeMax: text("valid_range_max"),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewTaskNodeId: typeIdNoDefault("node", {
      name: "review_task_node_id",
    }).references(() => nodes.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("metric_definitions_user_slug_unique").on(table.userId, table.slug),
    index("metric_definitions_user_id_idx").on(table.userId),
    index("metric_definitions_user_needs_review_idx")
      .on(table.userId)
      .where(sql`${table.needsReview} = true`),
    check(
      "metric_definitions_aggregation_hint_ck",
      sql`"aggregation_hint" IN ('avg','sum','min','max')`,
    ),
  ],
);

export const metricObservations = pgTable(
  "metric_observations",
  {
    id: typeId("metric_observation").primaryKey().notNull(),
    userId: text()
      .references(() => users.id)
      .notNull(),
    metricDefinitionId: typeId("metric_definition", {
      name: "metric_definition_id",
    })
      .references(() => metricDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    value: text().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    note: text(),
    eventNodeId: typeIdNoDefault("node", {
      name: "event_node_id",
    }).references(() => nodes.id, { onDelete: "set null" }),
    sourceId: typeId("source")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("metric_observations_user_def_occurred_idx").on(
      table.userId,
      table.metricDefinitionId,
      table.occurredAt.desc(),
    ),
    index("metric_observations_user_occurred_idx").on(
      table.userId,
      table.occurredAt.desc(),
    ),
    index("metric_observations_event_node_idx")
      .on(table.eventNodeId)
      .where(sql`${table.eventNodeId} IS NOT NULL`),
    index("metric_observations_source_id_idx").on(table.sourceId),
  ],
);

export const metricDefinitionEmbeddings = pgTable(
  "metric_definition_embeddings",
  {
    id: typeId("metric_definition_embedding").primaryKey().notNull(),
    metricDefinitionId: typeId("metric_definition", {
      name: "metric_definition_id",
    })
      .references(() => metricDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    modelName: varchar("model_name", { length: 100 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("metric_def_emb_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("metric_def_emb_def_id_idx").on(table.metricDefinitionId),
    unique("metric_def_emb_def_unique").on(table.metricDefinitionId),
  ],
);

export const metricDefinitionsRelations = relations(
  metricDefinitions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [metricDefinitions.userId],
      references: [users.id],
    }),
    embedding: one(metricDefinitionEmbeddings, {
      fields: [metricDefinitions.id],
      references: [metricDefinitionEmbeddings.metricDefinitionId],
    }),
    observations: many(metricObservations),
    reviewTaskNode: one(nodes, {
      fields: [metricDefinitions.reviewTaskNodeId],
      references: [nodes.id],
    }),
  }),
);

export const metricObservationsRelations = relations(
  metricObservations,
  ({ one }) => ({
    user: one(users, {
      fields: [metricObservations.userId],
      references: [users.id],
    }),
    definition: one(metricDefinitions, {
      fields: [metricObservations.metricDefinitionId],
      references: [metricDefinitions.id],
    }),
    eventNode: one(nodes, {
      fields: [metricObservations.eventNodeId],
      references: [nodes.id],
    }),
    source: one(sources, {
      fields: [metricObservations.sourceId],
      references: [sources.id],
    }),
  }),
);

export const metricDefinitionEmbeddingsRelations = relations(
  metricDefinitionEmbeddings,
  ({ one }) => ({
    definition: one(metricDefinitions, {
      fields: [metricDefinitionEmbeddings.metricDefinitionId],
      references: [metricDefinitions.id],
    }),
  }),
);
