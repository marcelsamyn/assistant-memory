/**
 * Expectation evaluator for the memory regression eval harness.
 *
 * Each expectation kind translates to a deterministic SQL query over the
 * harness DB; failures are reported with structured `expected` and `actual`
 * fields so the CI artifact is reviewable without re-running the harness.
 *
 * Common aliases: claim count assertion, harness expectations, fixture asserts.
 */
import type {
  AliasExpectation,
  ClaimCountExpectation,
  CustomAssertion,
  EvalContext,
  EvalExpectations,
  EvalFailure,
  NodeCountExpectation,
} from "./types";
import { and, eq, sql } from "drizzle-orm";
import { aliases, claims, nodes } from "~/db/schema";
import { normalizeAliasText } from "~/lib/alias";

export async function evaluateExpectations(
  ctx: EvalContext,
  expectations: EvalExpectations,
): Promise<EvalFailure[]> {
  const failures: EvalFailure[] = [];

  for (const exp of expectations.claimCounts ?? []) {
    const failure = await evaluateClaimCount(ctx, exp);
    if (failure) failures.push(failure);
  }
  for (const exp of expectations.nodeCounts ?? []) {
    const failure = await evaluateNodeCount(ctx, exp);
    if (failure) failures.push(failure);
  }
  for (const exp of expectations.aliases ?? []) {
    const failure = await evaluateAlias(ctx, exp);
    if (failure) failures.push(failure);
  }
  for (const exp of expectations.custom ?? []) {
    const failure = await evaluateCustom(ctx, exp);
    if (failure) failures.push(failure);
  }
  return failures;
}

function checkBound(
  actual: number,
  exp: { minCount?: number; maxCount?: number; exactCount?: number },
): { pass: boolean; reason?: string } {
  if (exp.exactCount !== undefined && actual !== exp.exactCount) {
    return { pass: false, reason: `expected exactly ${exp.exactCount}` };
  }
  if (exp.minCount !== undefined && actual < exp.minCount) {
    return { pass: false, reason: `expected ≥ ${exp.minCount}` };
  }
  if (exp.maxCount !== undefined && actual > exp.maxCount) {
    return { pass: false, reason: `expected ≤ ${exp.maxCount}` };
  }
  return { pass: true };
}

async function evaluateClaimCount(
  ctx: EvalContext,
  exp: ClaimCountExpectation,
): Promise<EvalFailure | null> {
  const conditions = [eq(claims.userId, ctx.userId)];
  if (exp.predicate) conditions.push(eq(claims.predicate, exp.predicate));
  if (exp.status) conditions.push(eq(claims.status, exp.status));
  if (exp.assertedByKind)
    conditions.push(eq(claims.assertedByKind, exp.assertedByKind));
  if (exp.scope) conditions.push(eq(claims.scope, exp.scope));
  if (exp.subjectName) {
    const subjectId = ctx.nodes.get(exp.subjectName);
    if (!subjectId) {
      return {
        kind: "claim_count",
        description: exp.description,
        expected: `subject '${exp.subjectName}' registered`,
        actual: "(missing)",
        message: `claim count expectation references unknown node '${exp.subjectName}'`,
      };
    }
    conditions.push(eq(claims.subjectNodeId, subjectId));
  }

  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(claims)
    .where(and(...conditions));
  const actual = row?.count ?? 0;
  const { pass, reason } = checkBound(actual, exp);
  if (pass) return null;
  return {
    kind: "claim_count",
    description: exp.description,
    expected: {
      predicate: exp.predicate,
      status: exp.status,
      assertedByKind: exp.assertedByKind,
      scope: exp.scope,
      subjectName: exp.subjectName,
      minCount: exp.minCount,
      maxCount: exp.maxCount,
      exactCount: exp.exactCount,
    },
    actual,
    message: `${exp.description}: ${reason} (actual=${actual})`,
  };
}

async function evaluateNodeCount(
  ctx: EvalContext,
  exp: NodeCountExpectation,
): Promise<EvalFailure | null> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.userId, ctx.userId), eq(nodes.nodeType, exp.type)));
  const actual = row?.count ?? 0;
  const { pass, reason } = checkBound(actual, exp);
  if (pass) return null;
  return {
    kind: "node_count",
    description: exp.description,
    expected: {
      type: exp.type,
      minCount: exp.minCount,
      maxCount: exp.maxCount,
      exactCount: exp.exactCount,
    },
    actual,
    message: `${exp.description}: ${reason} (actual=${actual})`,
  };
}

async function evaluateAlias(
  ctx: EvalContext,
  exp: AliasExpectation,
): Promise<EvalFailure | null> {
  const normalized = normalizeAliasText(exp.aliasText);
  const conditions = [
    eq(aliases.userId, ctx.userId),
    eq(aliases.normalizedAliasText, normalized),
  ];
  if (exp.canonicalNodeName) {
    const nodeId = ctx.nodes.get(exp.canonicalNodeName);
    if (!nodeId) {
      return {
        kind: "alias_exists",
        description: exp.description,
        expected: `canonical node '${exp.canonicalNodeName}' registered`,
        actual: "(missing)",
        message: `alias expectation references unknown node '${exp.canonicalNodeName}'`,
      };
    }
    conditions.push(eq(aliases.canonicalNodeId, nodeId));
  }
  const rows = await ctx.db
    .select({ id: aliases.id })
    .from(aliases)
    .where(and(...conditions));
  if (rows.length > 0) return null;
  return {
    kind: "alias_exists",
    description: exp.description,
    expected: {
      aliasText: exp.aliasText,
      canonicalNodeName: exp.canonicalNodeName,
    },
    actual: 0,
    message: `${exp.description}: alias '${exp.aliasText}' missing`,
  };
}

async function evaluateCustom(
  ctx: EvalContext,
  exp: CustomAssertion,
): Promise<EvalFailure | null> {
  try {
    const { pass, message } = await exp.run(ctx);
    if (pass) return null;
    return {
      kind: "custom",
      description: exp.description,
      expected: "pass",
      actual: "fail",
      message: message ?? exp.description,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "custom",
      description: exp.description,
      expected: "no throw",
      actual: message,
      message: `${exp.description} threw: ${message}`,
    };
  }
}

/**
 * Snapshot the post-run claim distribution for the user. Keys group by
 * `predicate|status|assertedByKind|scope` so reviewers can scan the artifact
 * for unexpected drift between runs.
 */
export async function snapshotClaimCounts(
  ctx: EvalContext,
): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({
      predicate: claims.predicate,
      status: claims.status,
      assertedByKind: claims.assertedByKind,
      scope: claims.scope,
      count: sql<number>`count(*)::int`,
    })
    .from(claims)
    .where(eq(claims.userId, ctx.userId))
    .groupBy(
      claims.predicate,
      claims.status,
      claims.assertedByKind,
      claims.scope,
    );

  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.predicate}|${row.status}|${row.assertedByKind}|${row.scope}`;
    result[key] = row.count;
  }
  return result;
}
