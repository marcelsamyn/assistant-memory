/**
 * Seed helpers for eval-harness fixtures. Production claim-layer behavior
 * (lifecycle supersession, scope filtering, getOpenCommitments, etc.) is
 * driven by the rows these helpers create; the helpers themselves do not
 * exercise extraction or LLMs. Direct seeding lets each story declare exactly
 * the graph state it needs without orchestrating end-to-end ingestion.
 *
 * Common aliases: harness seed, fixture builder, claim/node/source/alias seed.
 */
import type { EvalContext } from "./types";
import { sql } from "drizzle-orm";
import { aliases, claims, nodeMetadata, nodes, sources } from "~/db/schema";
import { normalizeAliasText } from "~/lib/alias";
import { normalizeLabel } from "~/lib/label";
import type {
  AssertedByKind,
  ClaimStatus,
  NodeType,
  Predicate,
  Scope,
  SourceType,
} from "~/types/graph";
import { newTypeId, type TypeId } from "~/types/typeid";

export interface SeedNodeArgs {
  /** Logical alias used inside the fixture to reference this node. */
  name: string;
  type: NodeType;
  label: string;
  description?: string;
  additionalData?: Record<string, unknown>;
}

export async function ensureUser(ctx: EvalContext): Promise<void> {
  await ctx.db.execute(
    sql`INSERT INTO "users" ("id") VALUES (${ctx.userId}) ON CONFLICT DO NOTHING`,
  );
}

export async function seedNode(
  ctx: EvalContext,
  args: SeedNodeArgs,
): Promise<TypeId<"node">> {
  await ensureUser(ctx);
  const nodeId = newTypeId("node");
  await ctx.db.insert(nodes).values({
    id: nodeId,
    userId: ctx.userId,
    nodeType: args.type,
  });
  await ctx.db.insert(nodeMetadata).values({
    nodeId,
    label: args.label,
    canonicalLabel: normalizeLabel(args.label),
    description: args.description ?? null,
    additionalData: args.additionalData ?? {},
  });
  ctx.nodes.set(args.name, nodeId);
  return nodeId;
}

export interface SeedSourceArgs {
  name: string;
  type: SourceType;
  externalId?: string;
  scope?: Scope;
  metadata?: Record<string, unknown>;
}

export async function seedSource(
  ctx: EvalContext,
  args: SeedSourceArgs,
): Promise<TypeId<"source">> {
  await ensureUser(ctx);
  const sourceId = newTypeId("source");
  await ctx.db.insert(sources).values({
    id: sourceId,
    userId: ctx.userId,
    type: args.type,
    externalId: args.externalId ?? args.name,
    scope: args.scope ?? "personal",
    metadata: args.metadata ?? null,
    status: "completed",
  });
  ctx.sources.set(args.name, sourceId);
  return sourceId;
}

export interface SeedClaimArgs {
  name: string;
  subjectName: string;
  /** When omitted, `objectValue` is required. */
  objectName?: string;
  objectValue?: string;
  predicate: Predicate;
  statement?: string;
  sourceName: string;
  scope?: Scope;
  assertedByKind?: AssertedByKind;
  /** For `participant` provenance — pass the speaker's node alias. */
  assertedByNodeName?: string;
  status?: ClaimStatus;
  statedAt?: Date;
  validFrom?: Date | null;
  validTo?: Date | null;
}

export async function seedClaim(
  ctx: EvalContext,
  args: SeedClaimArgs,
): Promise<TypeId<"claim">> {
  const subjectNodeId = ctx.nodes.get(args.subjectName);
  if (!subjectNodeId) {
    throw new Error(`seedClaim: unknown subject node '${args.subjectName}'`);
  }
  const sourceId = ctx.sources.get(args.sourceName);
  if (!sourceId) {
    throw new Error(`seedClaim: unknown source '${args.sourceName}'`);
  }
  const objectNodeId = args.objectName
    ? ctx.nodes.get(args.objectName)
    : undefined;
  if (args.objectName && !objectNodeId) {
    throw new Error(`seedClaim: unknown object node '${args.objectName}'`);
  }
  const assertedByNodeId = args.assertedByNodeName
    ? ctx.nodes.get(args.assertedByNodeName)
    : undefined;
  if (args.assertedByNodeName && !assertedByNodeId) {
    throw new Error(
      `seedClaim: unknown asserter node '${args.assertedByNodeName}'`,
    );
  }
  if ((objectNodeId === undefined) === (args.objectValue === undefined)) {
    throw new Error(
      `seedClaim: provide exactly one of objectName or objectValue (got both or neither for '${args.name}')`,
    );
  }

  const claimId = newTypeId("claim");
  const statedAt = args.statedAt ?? new Date();
  const assertedByKind: AssertedByKind = args.assertedByKind ?? "user";

  await ctx.db.insert(claims).values({
    id: claimId,
    userId: ctx.userId,
    subjectNodeId,
    objectNodeId: objectNodeId ?? null,
    objectValue: args.objectValue ?? null,
    predicate: args.predicate,
    statement: args.statement ?? `${args.predicate} ${args.name}`,
    description: args.statement ?? `${args.predicate} ${args.name}`,
    sourceId,
    scope: args.scope ?? "personal",
    assertedByKind,
    assertedByNodeId: assertedByNodeId ?? null,
    statedAt,
    validFrom: args.validFrom ?? null,
    validTo: args.validTo ?? null,
    status: args.status ?? "active",
  });
  ctx.claims.set(args.name, claimId);
  return claimId;
}

export interface SeedAliasArgs {
  canonicalNodeName: string;
  aliasText: string;
}

export async function seedAlias(
  ctx: EvalContext,
  args: SeedAliasArgs,
): Promise<void> {
  const canonicalNodeId = ctx.nodes.get(args.canonicalNodeName);
  if (!canonicalNodeId) {
    throw new Error(
      `seedAlias: unknown node '${args.canonicalNodeName}'`,
    );
  }
  await ctx.db
    .insert(aliases)
    .values({
      userId: ctx.userId,
      aliasText: args.aliasText,
      normalizedAliasText: normalizeAliasText(args.aliasText),
      canonicalNodeId,
    })
    .onConflictDoNothing({
      target: [
        aliases.userId,
        aliases.normalizedAliasText,
        aliases.canonicalNodeId,
      ],
    });
}

export interface SeedSourceLinkArgs {
  sourceName: string;
  nodeName: string;
}

export async function seedSourceLink(
  ctx: EvalContext,
  args: SeedSourceLinkArgs,
): Promise<void> {
  const sourceId = ctx.sources.get(args.sourceName);
  if (!sourceId) {
    throw new Error(`seedSourceLink: unknown source '${args.sourceName}'`);
  }
  const nodeId = ctx.nodes.get(args.nodeName);
  if (!nodeId) {
    throw new Error(`seedSourceLink: unknown node '${args.nodeName}'`);
  }
  await ctx.db.execute(
    sql`INSERT INTO "source_links" ("id", "source_id", "node_id")
        VALUES (${newTypeId("source_link")}, ${sourceId}, ${nodeId})
        ON CONFLICT DO NOTHING`,
  );
}
