import { ensureUser } from "./ingestion/ensure-user";
import { ensureSystemSource } from "./sources";
import { and, eq } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { nodes, nodeMetadata, claims, sourceLinks } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import { type TypeId } from "~/types/typeid";

/**
 * Ensures a single Atlas node (and its metadata) exists for the user.
 * Returns the node ID.
 */
export async function ensureAtlasNode(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"node">> {
  await ensureUser(db, userId);

  // Check for existing atlas node
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
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
    .values({ userId, nodeType: NodeTypeEnum.enum.Atlas })
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
  const sourceId = await ensureSystemSource(db, userId, "manual");
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
): Promise<{
  nodeId: TypeId<"node">;
  label: string | null;
  description: string | null;
}> {
  const atlasNodeId = await ensureAtlasNode(db, userId);
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
): Promise<void> {
  const atlasNodeId = await ensureAtlasNode(db, userId);
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
): Promise<TypeId<"node">> {
  await ensureUser(db, userId);

  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Person),
        eq(nodeMetadata.label, assistantId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(nodes)
    .values({ userId, nodeType: NodeTypeEnum.enum.Person })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error("Failed to create assistant entity");
  const assistantNodeId = inserted.id;
  await db
    .insert(nodeMetadata)
    .values({ nodeId: assistantNodeId, label: assistantId, description: "" });
  const sourceId = await ensureSystemSource(db, userId, "manual");
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
): Promise<TypeId<"node">> {
  const assistantNodeId = await ensureAssistantEntity(db, userId, assistantId);
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
        eq(nodeMetadata.label, assistantId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(nodes)
    .values({ userId, nodeType: NodeTypeEnum.enum.Atlas })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error("Failed to create assistant atlas");
  const atlasNodeId = inserted.id;
  await db
    .insert(nodeMetadata)
    .values({ nodeId: atlasNodeId, label: assistantId, description: "" });
  const sourceId = await ensureSystemSource(db, userId, "manual");
  await db
    .insert(sourceLinks)
    .values({ sourceId, nodeId: atlasNodeId })
    .onConflictDoNothing();
  await db.insert(claims).values({
    userId,
    subjectNodeId: atlasNodeId,
    objectNodeId: assistantNodeId,
    predicate: "OWNED_BY",
    statement: `Atlas ${assistantId} is owned by assistant ${assistantId}.`,
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
): Promise<{
  nodeId: TypeId<"node">;
  label: string | null;
  description: string | null;
}> {
  const atlasNodeId = await ensureAssistantAtlasNode(db, userId, assistantId);
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
): Promise<void> {
  const atlasNodeId = await ensureAssistantAtlasNode(db, userId, assistantId);
  await db
    .update(nodeMetadata)
    .set({ description: newDescription })
    .where(eq(nodeMetadata.nodeId, atlasNodeId));
}
