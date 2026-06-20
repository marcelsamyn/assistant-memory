/** Database audit for invalid relationship predicate shapes. Common aliases: invalid edge audit, predicate shape audit, graph relation audit. */
import { aliasedTable, and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import {
  type PredicateShapeRepairProposal,
  proposeRelationshipPredicateShapeRepair,
} from "~/lib/claims/predicate-shape-repair";
import {
  formatRelationshipPredicateGuide,
  isInvalidRelationshipPredicateClaimShape,
  relationshipPredicateFrom,
} from "~/lib/claims/predicate-shapes";
import {
  RelationshipPredicateEnum,
  type AssertedByKind,
  type NodeType,
  type RelationshipPredicate,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";

const DEPRECATED_RELATIONSHIP_PREDICATES = ["OWNED_BY"] as const;
type DeprecatedRelationshipPredicate =
  (typeof DEPRECATED_RELATIONSHIP_PREDICATES)[number];

export interface InvalidRelationshipPredicateShapeClaim {
  claimId: TypeId<"claim">;
  predicate: RelationshipPredicate;
  statement: string;
  assertedByKind: AssertedByKind;
  scope: Scope;
  subject: {
    nodeId: TypeId<"node">;
    type: NodeType;
    label: string | null;
  };
  object: {
    nodeId: TypeId<"node">;
    type: NodeType;
    label: string | null;
  } | null;
}

export interface InvalidRelationshipPredicateShapeAudit {
  totalInvalid: number;
  counts: Array<{ predicate: RelationshipPredicate; count: number }>;
  examples: InvalidRelationshipPredicateShapeClaim[];
  seedNodeIds: TypeId<"node">[];
}

export interface AuditInvalidRelationshipPredicateShapesOptions {
  exampleLimit: number;
}

export interface DeprecatedRelationshipPredicateCount {
  predicate: DeprecatedRelationshipPredicate;
  count: number;
}

export interface RelationshipPredicateGuideStats {
  characterCount: number;
  approximateTokenCount: number;
  lineCount: number;
}

export interface RelationshipPredicateHealthAudit {
  invalidShapes: InvalidRelationshipPredicateShapeAudit;
  deprecatedPredicates: DeprecatedRelationshipPredicateCount[];
  repairProposals: PredicateShapeRepairProposal[];
  promptGuide: RelationshipPredicateGuideStats;
}

export async function auditInvalidRelationshipPredicateShapes(
  db: DrizzleDB,
  userId: string,
  options: AuditInvalidRelationshipPredicateShapesOptions = {
    exampleLimit: 20,
  },
): Promise<InvalidRelationshipPredicateShapeAudit> {
  const subjectMetadata = aliasedTable(nodeMetadata, "shapeAuditSubjectMeta");

  const rows = await db
    .select({
      claimId: claims.id,
      predicate: claims.predicate,
      statement: claims.statement,
      assertedByKind: claims.assertedByKind,
      scope: claims.scope,
      subjectNodeId: claims.subjectNodeId,
      subjectType: nodes.nodeType,
      subjectLabel: subjectMetadata.label,
      objectNodeId: claims.objectNodeId,
    })
    .from(claims)
    .innerJoin(nodes, eq(nodes.id, claims.subjectNodeId))
    .leftJoin(
      subjectMetadata,
      eq(subjectMetadata.nodeId, claims.subjectNodeId),
    )
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        inArray(claims.predicate, RelationshipPredicateEnum.options),
      ),
    );

  const objectNodeIds = rows
    .map((row) => row.objectNodeId)
    .filter((nodeId): nodeId is TypeId<"node"> => nodeId !== null);
  const objectRows =
    objectNodeIds.length === 0
      ? []
      : await db
          .select({
            nodeId: nodes.id,
            type: nodes.nodeType,
            label: nodeMetadata.label,
          })
          .from(nodes)
          .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
          .where(
            and(eq(nodes.userId, userId), inArray(nodes.id, objectNodeIds)),
          );
  const objectsById = new Map(
    objectRows.map((row) => [
      row.nodeId,
      { type: row.type, label: row.label },
    ]),
  );

  const counts = new Map<RelationshipPredicate, number>();
  const examples: InvalidRelationshipPredicateShapeClaim[] = [];
  const seedNodeIds = new Set<TypeId<"node">>();

  for (const row of rows) {
    const predicate = relationshipPredicateFrom(row.predicate);
    if (predicate === null) continue;
    const object =
      row.objectNodeId === null ? undefined : objectsById.get(row.objectNodeId);
    const invalid = isInvalidRelationshipPredicateClaimShape({
      predicate,
      subjectType: row.subjectType,
      objectType: object?.type ?? null,
    });
    if (!invalid) continue;

    counts.set(predicate, (counts.get(predicate) ?? 0) + 1);
    seedNodeIds.add(row.subjectNodeId);
    if (row.objectNodeId !== null) seedNodeIds.add(row.objectNodeId);
    if (examples.length < options.exampleLimit) {
      examples.push({
        claimId: row.claimId,
        predicate,
        statement: row.statement,
        assertedByKind: row.assertedByKind,
        scope: row.scope,
        subject: {
          nodeId: row.subjectNodeId,
          type: row.subjectType,
          label: row.subjectLabel,
        },
        object:
          row.objectNodeId === null || object === undefined
            ? null
            : {
                nodeId: row.objectNodeId,
                type: object.type,
                label: object.label,
              },
      });
    }
  }

  return {
    totalInvalid: Array.from(counts.values()).reduce(
      (sum, count) => sum + count,
      0,
    ),
    counts: RelationshipPredicateEnum.options.flatMap((predicate) => {
      const count = counts.get(predicate) ?? 0;
      return count > 0 ? [{ predicate, count }] : [];
    }),
    examples,
    seedNodeIds: Array.from(seedNodeIds),
  };
}

async function loadDeprecatedPredicateCounts(
  db: DrizzleDB,
  userId: string,
): Promise<DeprecatedRelationshipPredicateCount[]> {
  const rows = await db
    .select({
      predicate: sql<DeprecatedRelationshipPredicate>`${claims.predicate}`,
      count: sql<number>`count(*)::int`,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        sql`${claims.predicate} = 'OWNED_BY'`,
      ),
    )
    .groupBy(claims.predicate);

  return rows.map((row) => ({
    predicate: row.predicate,
    count: row.count,
  }));
}

async function loadDeprecatedPredicateRepairProposals(
  db: DrizzleDB,
  userId: string,
  limit: number,
): Promise<PredicateShapeRepairProposal[]> {
  const subjectMetadata = aliasedTable(
    nodeMetadata,
    "deprecatedPredicateSubjectMeta",
  );

  const rows = await db
    .select({
      claimId: claims.id,
      predicate: sql<DeprecatedRelationshipPredicate>`${claims.predicate}`,
      statement: claims.statement,
      subjectNodeId: claims.subjectNodeId,
      subjectType: nodes.nodeType,
      subjectLabel: subjectMetadata.label,
      objectNodeId: claims.objectNodeId,
    })
    .from(claims)
    .innerJoin(nodes, eq(nodes.id, claims.subjectNodeId))
    .leftJoin(
      subjectMetadata,
      eq(subjectMetadata.nodeId, claims.subjectNodeId),
    )
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        sql`${claims.predicate} = 'OWNED_BY'`,
      ),
    )
    .limit(limit);

  const objectNodeIds = rows
    .map((row) => row.objectNodeId)
    .filter((nodeId): nodeId is TypeId<"node"> => nodeId !== null);
  const objectRows =
    objectNodeIds.length === 0
      ? []
      : await db
          .select({
            nodeId: nodes.id,
            type: nodes.nodeType,
            label: nodeMetadata.label,
          })
          .from(nodes)
          .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
          .where(
            and(eq(nodes.userId, userId), inArray(nodes.id, objectNodeIds)),
          );
  const objectsById = new Map(
    objectRows.map((row) => [
      row.nodeId,
      { type: row.type, label: row.label },
    ]),
  );

  return rows.flatMap((row) => {
    const object =
      row.objectNodeId === null ? undefined : objectsById.get(row.objectNodeId);
    if (row.objectNodeId === null || object === undefined) return [];

    const proposal = proposeRelationshipPredicateShapeRepair({
      claimId: row.claimId,
      predicate: row.predicate,
      statement: row.statement,
      subject: {
        nodeId: row.subjectNodeId,
        type: row.subjectType,
      },
      object: {
        nodeId: row.objectNodeId,
        type: object.type,
      },
    });

    return proposal === null ? [] : [proposal];
  });
}

function promptGuideStats(): RelationshipPredicateGuideStats {
  const guide = formatRelationshipPredicateGuide();
  return {
    characterCount: guide.length,
    approximateTokenCount: Math.ceil(guide.length / 4),
    lineCount: guide.split("\n").length,
  };
}

export async function auditRelationshipPredicateHealth(
  db: DrizzleDB,
  userId: string,
  options: AuditInvalidRelationshipPredicateShapesOptions = {
    exampleLimit: 20,
  },
): Promise<RelationshipPredicateHealthAudit> {
  const [invalidShapes, deprecatedPredicates, deprecatedRepairProposals] =
    await Promise.all([
      auditInvalidRelationshipPredicateShapes(db, userId, options),
      loadDeprecatedPredicateCounts(db, userId),
      loadDeprecatedPredicateRepairProposals(
        db,
        userId,
        options.exampleLimit,
      ),
    ]);

  const invalidRepairProposals = invalidShapes.examples.flatMap((example) => {
    if (example.object === null) return [];
    const proposal = proposeRelationshipPredicateShapeRepair({
      claimId: example.claimId,
      predicate: example.predicate,
      statement: example.statement,
      subject: {
        nodeId: example.subject.nodeId,
        type: example.subject.type,
      },
      object: {
        nodeId: example.object.nodeId,
        type: example.object.type,
      },
    });

    return proposal === null ? [] : [proposal];
  });

  return {
    invalidShapes,
    deprecatedPredicates,
    repairProposals: [
      ...invalidRepairProposals,
      ...deprecatedRepairProposals,
    ],
    promptGuide: promptGuideStats(),
  };
}
