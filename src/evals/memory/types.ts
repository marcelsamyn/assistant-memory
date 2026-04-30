/**
 * Shared types for the memory regression eval harness (Phase 4 PR 4iii-c).
 *
 * The harness exercises the claims layer against a real Postgres test
 * database. Each fixture describes a story (seed → operations → assertions);
 * the runner produces a structured `EvalResult` suitable for CI artifacts.
 *
 * Fixtures are intentionally direct: most stories seed nodes/sources/claims
 * via the helpers in `seed.ts` and then call lifecycle / cleanup / search
 * functions directly. A handful of stories that hinge on extraction LLM
 * behavior (multi-party transcripts) stub the OpenAI client via vitest's
 * module mocking — those are wired through `runIngestionEval`'s `runtime`
 * parameter so the harness stays the same shape across stories.
 */
import type { DrizzleDB } from "~/db";
import type { CleanupOperation } from "~/lib/jobs/cleanup-operations";
import type {
  AssertedByKind,
  ClaimStatus,
  NodeType,
  Predicate,
  Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";

/**
 * Live state threaded through a fixture's setup → steps → expectations chain.
 * Stories can register named ids on setup, then refer to them in steps and
 * assertions without leaking raw TypeIds into the fixture file.
 */
export interface EvalContext {
  db: DrizzleDB;
  userId: string;
  /** Named TypeId<"node"> aliases registered during setup or step execution. */
  nodes: Map<string, TypeId<"node">>;
  /** Named TypeId<"source"> aliases registered during setup or step execution. */
  sources: Map<string, TypeId<"source">>;
  /** Named TypeId<"claim"> aliases registered during setup or step execution. */
  claims: Map<string, TypeId<"claim">>;
}

export type EvalSetupFn = (ctx: EvalContext) => Promise<void>;

export type EvalStep =
  | { kind: "setup"; run: EvalSetupFn }
  | {
      kind: "applyCleanupOperations";
      operations: (ctx: EvalContext) => CleanupOperation[];
      /** Optional named seed-node ids passed to the cleanup mapper. */
      seedNodeIds?: (ctx: EvalContext) => TypeId<"node">[];
    }
  | { kind: "wait"; ms: number };

export interface ClaimCountExpectation {
  predicate?: Predicate;
  status?: ClaimStatus;
  assertedByKind?: AssertedByKind;
  scope?: Scope;
  subjectName?: string;
  minCount?: number;
  maxCount?: number;
  exactCount?: number;
  /** Human-readable label for the failure message. */
  description: string;
}

export interface NodeCountExpectation {
  type: NodeType;
  minCount?: number;
  maxCount?: number;
  exactCount?: number;
  description: string;
}

export interface AliasExpectation {
  /** Alias text that must exist (normalized via `normalizeAliasText`). */
  aliasText: string;
  /** Optional canonical node name (registered in ctx.nodes). */
  canonicalNodeName?: string;
  description: string;
}

export interface CustomAssertion {
  description: string;
  run: (ctx: EvalContext) => Promise<{ pass: boolean; message?: string }>;
}

export interface EvalExpectations {
  claimCounts?: ClaimCountExpectation[];
  nodeCounts?: NodeCountExpectation[];
  aliases?: AliasExpectation[];
  custom?: CustomAssertion[];
}

export interface EvalFixture {
  /** Snake-cased identifier; matches the artifact key. */
  name: string;
  description: string;
  /** Optional pre-step setup that runs once before any `EvalStep`. */
  setup?: EvalSetupFn;
  steps: EvalStep[];
  expectations: EvalExpectations;
}

export interface EvalFailure {
  kind: string;
  description: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface EvalResult {
  fixture: string;
  description: string;
  passed: boolean;
  failures: EvalFailure[];
  durationMs: number;
  /**
   * `predicate=…|status=…|kind=…|scope=…` → row count. Snapshots the post-run
   * claim landscape so reviewers can spot drift across runs without rerunning
   * the harness.
   */
  claimCounts: Record<string, number>;
}
