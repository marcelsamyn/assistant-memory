import { ensureUser } from "./ingestion/ensure-user";
import { ensureSystemSource } from "./sources";
import { aliasedTable, and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { nodes, nodeMetadata, claims, sourceLinks } from "~/db/schema";
import {
  partitionAccessCondition,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import { NodeTypeEnum } from "~/types/graph";
import { type TypeId } from "~/types/typeid";

export interface WorkspaceAtlasEntry {
  nodeId: TypeId<"node">;
  partitionKey: ContextPartitionKey | null;
  label: string | null;
  description: string | null;
}

/** Reads existing atlas rows across active partitions without creating rows. */
export async function getWorkspaceAtlasEntries(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
): Promise<{ user: WorkspaceAtlasEntry[]; assistant: WorkspaceAtlasEntry[] }> {
  const [user, assistant] = await Promise.all([
    db
      .select({
        nodeId: nodes.id,
        partitionKey: nodes.partitionKey,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
          eq(nodeMetadata.label, "Atlas"),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            undefined,
            "workspace",
          ),
        ),
      )
      .orderBy(asc(nodes.partitionKey), asc(nodes.id)),
    db
      .select({
        nodeId: nodes.id,
        partitionKey: nodes.partitionKey,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
          eq(nodeMetadata.label, assistantId),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            undefined,
            "workspace",
          ),
        ),
      )
      .orderBy(asc(nodes.partitionKey), asc(nodes.id)),
  ]);
  return { user, assistant };
}

/**
 * Returns nodes linked to assistant atlases in active workspace partitions.
 * Claims and endpoints are checked in one ownership-bounded query so malformed
 * cross-partition edges never become workspace results.
 */
export async function getWorkspaceAssistantAtlasNodeIds(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
): Promise<TypeId<"node">[]> {
  const atlasNodes = aliasedTable(nodes, "workspace_assistant_atlas");
  const atlasMetadata = aliasedTable(
    nodeMetadata,
    "workspace_assistant_atlas_metadata",
  );
  const endpointNodes = aliasedTable(nodes, "workspace_assistant_endpoint");
  const endpointNodeId = sql`
    CASE
      WHEN ${claims.subjectNodeId} = ${atlasNodes.id}
        THEN ${claims.objectNodeId}
      ELSE ${claims.subjectNodeId}
    END
  `;

  // Keep atlas, claim, and endpoint ownership in the same SQL predicate. This
  // avoids a capped atlas/claim candidate list and rejects malformed edges
  // before they can enter the workspace result.
  const rows = await db
    .selectDistinct({ nodeId: endpointNodes.id })
    .from(claims)
    .innerJoin(
      atlasNodes,
      or(
        eq(atlasNodes.id, claims.subjectNodeId),
        eq(atlasNodes.id, claims.objectNodeId),
      ),
    )
    .innerJoin(
      atlasMetadata,
      and(
        eq(atlasMetadata.nodeId, atlasNodes.id),
        eq(atlasMetadata.label, assistantId),
      ),
    )
    .innerJoin(endpointNodes, eq(endpointNodes.id, endpointNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        partitionAccessCondition(
          claims.partitionKey,
          userId,
          undefined,
          "workspace",
        ),
        eq(atlasNodes.userId, userId),
        eq(atlasNodes.nodeType, NodeTypeEnum.enum.Atlas),
        partitionAccessCondition(
          atlasNodes.partitionKey,
          userId,
          undefined,
          "workspace",
        ),
        eq(endpointNodes.userId, userId),
        partitionAccessCondition(
          endpointNodes.partitionKey,
          userId,
          undefined,
          "workspace",
        ),
        sql`${claims.partitionKey} IS NOT DISTINCT FROM ${atlasNodes.partitionKey}`,
        sql`${claims.partitionKey} IS NOT DISTINCT FROM ${endpointNodes.partitionKey}`,
      ),
    )
    .orderBy(asc(endpointNodes.id));

  return rows.map((row) => row.nodeId);
}

/**
 * Ensures a single Atlas node (and its metadata) exists for the user.
 * Returns the node ID.
 */
export async function ensureAtlasNode(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
): Promise<TypeId<"node">> {
  await ensureUser(db, userId);
  await preparePartitionWrite(db, userId, partitionKey);

  // Check for existing atlas node
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
        eq(nodeMetadata.label, "Atlas"),
      ),
    )
    .limit(1);

  if (existing) {
    return existing.id;
  }

  // Create new atlas node
  const [inserted] = await db
    .insert(nodes)
    .values({ userId, partitionKey, nodeType: NodeTypeEnum.enum.Atlas })
    .returning({ id: nodes.id });

  if (!inserted) {
    throw new Error("Failed to create atlas node");
  }

  const atlasNodeId = inserted.id;
  // Initialize metadata for atlas
  await db.insert(nodeMetadata).values({
    nodeId: atlasNodeId,
    label: "Atlas",
    description: "",
  });
  const sourceId = await ensureSystemSource(db, userId, "manual", partitionKey);
  await db
    .insert(sourceLinks)
    .values({ sourceId, nodeId: atlasNodeId })
    .onConflictDoNothing();

  return atlasNodeId;
}

/**
 * Fetches the current atlas metadata for the user.
 * Ensures the atlas node exists.
 */
export async function getAtlas(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
): Promise<{
  nodeId: TypeId<"node">;
  label: string | null;
  description: string | null;
}> {
  const atlasNodeId = await ensureAtlasNode(db, userId, partitionKey);
  const [meta] = await db
    .select({
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, atlasNodeId))
    .limit(1);

  return {
    nodeId: atlasNodeId,
    label: meta?.label ?? null,
    description: meta?.description ?? null,
  };
}

/**
 * Updates the atlas metadata for the user with new description.
 */
export async function updateAtlas(
  db: DrizzleDB,
  userId: string,
  newDescription: string,
  partitionKey?: ContextPartitionKey,
): Promise<void> {
  const atlasNodeId = await ensureAtlasNode(db, userId, partitionKey);
  await db
    .update(nodeMetadata)
    .set({ description: newDescription })
    .where(eq(nodeMetadata.nodeId, atlasNodeId));
}

// Assistant-specific atlas utilities
/** Ensures a Person node for the assistant exists (label=assistantId) */
export async function ensureAssistantEntity(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
  partitionKey?: ContextPartitionKey,
): Promise<TypeId<"node">> {
  await ensureUser(db, userId);
  await preparePartitionWrite(db, userId, partitionKey);

  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        eq(nodes.nodeType, NodeTypeEnum.enum.Person),
        eq(nodeMetadata.label, assistantId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(nodes)
    .values({ userId, partitionKey, nodeType: NodeTypeEnum.enum.Person })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error("Failed to create assistant entity");
  const assistantNodeId = inserted.id;
  await db
    .insert(nodeMetadata)
    .values({ nodeId: assistantNodeId, label: assistantId, description: "" });
  const sourceId = await ensureSystemSource(db, userId, "manual", partitionKey);
  await db
    .insert(sourceLinks)
    .values({ sourceId, nodeId: assistantNodeId })
    .onConflictDoNothing();
  return assistantNodeId;
}

/** Ensures an assistant-specific Atlas node (label=assistantId) exists and links it */
export async function ensureAssistantAtlasNode(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
  partitionKey?: ContextPartitionKey,
): Promise<TypeId<"node">> {
  const assistantNodeId = await ensureAssistantEntity(
    db,
    userId,
    assistantId,
    partitionKey,
  );
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
        eq(nodeMetadata.label, assistantId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(nodes)
    .values({ userId, partitionKey, nodeType: NodeTypeEnum.enum.Atlas })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error("Failed to create assistant atlas");
  const atlasNodeId = inserted.id;
  await db
    .insert(nodeMetadata)
    .values({ nodeId: atlasNodeId, label: assistantId, description: "" });
  const sourceId = await ensureSystemSource(db, userId, "manual", partitionKey);
  await db
    .insert(sourceLinks)
    .values({ sourceId, nodeId: atlasNodeId })
    .onConflictDoNothing();
  await db.insert(claims).values({
    userId,
    partitionKey,
    subjectNodeId: assistantNodeId,
    objectNodeId: atlasNodeId,
    predicate: "OWNS",
    statement: `Assistant ${assistantId} owns atlas ${assistantId}.`,
    sourceId,
    scope: "personal",
    assertedByKind: "system",
    statedAt: new Date(),
    status: "active",
  });
  return atlasNodeId;
}

/** Fetches the assistant-specific atlas metadata */
export async function getAssistantAtlas(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
  partitionKey?: ContextPartitionKey,
): Promise<{
  nodeId: TypeId<"node">;
  label: string | null;
  description: string | null;
}> {
  const atlasNodeId = await ensureAssistantAtlasNode(
    db,
    userId,
    assistantId,
    partitionKey,
  );
  const [meta] = await db
    .select({
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, atlasNodeId))
    .limit(1);
  return {
    nodeId: atlasNodeId,
    label: meta?.label ?? null,
    description: meta?.description ?? null,
  };
}

/** Updates the assistant-specific atlas metadata */
export async function updateAssistantAtlas(
  db: DrizzleDB,
  userId: string,
  assistantId: string,
  newDescription: string,
  partitionKey?: ContextPartitionKey,
): Promise<void> {
  const atlasNodeId = await ensureAssistantAtlasNode(
    db,
    userId,
    assistantId,
    partitionKey,
  );
  await db
    .update(nodeMetadata)
    .set({ description: newDescription })
    .where(eq(nodeMetadata.nodeId, atlasNodeId));
}
