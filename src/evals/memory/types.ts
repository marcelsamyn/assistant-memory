/**
 * Shared types for the memory regression eval harness (Phase 4 PR 4iii-c).
 *
 * The harness exercises the claims layer against a real Postgres test
 * database. Each fixture describes a story (seed → operations → assertions);
 * the runner produces a structured `EvalResult` suitable for CI artifacts.
 *
 * Fixtures fall into two shapes:
 * - Direct seed: most stories use `seed.ts` to insert nodes/sources/claims
 *   and then drive lifecycle / cleanup / search helpers — extraction is not
 *   in scope.
 * - Pipeline-driven: stories 03 and 10 use `ingestConversation` /
 *   `ingestTranscript` step kinds. The runtime threads canned LLM responses
 *   (`ExtractionStubResponse[]`) through process-level seams in
 *   `~/utils/test-overrides`, exercising the full `extractGraph` →
 *   identity-resolution → claim-write path against the harness DB.
 */
import type { DrizzleDB } from "~/db";
import type { CleanupOperation } from "~/lib/jobs/cleanup-operations";
import type {
  AssertedByKind,
  AttributePredicate,
  ClaimStatus,
  NodeType,
  Predicate,
  RelationshipPredicate,
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

/**
 * Canned LLM extraction response. Mirrors the structured-output shape that
 * `extractGraph` parses from `client.beta.chat.completions.parse`. Stub
 * fixtures can omit any unused arrays — they default to empty.
 */
export interface ExtractionStubResponse {
  nodes?: Array<{
    id: string;
    type: NodeType;
    label: string;
    description?: string;
  }>;
  relationshipClaims?: Array<{
    subjectId: string;
    objectId: string;
    predicate: RelationshipPredicate;
    statement: string;
    sourceRef: string;
    assertionKind: AssertedByKind;
    assertedBySpeakerLabel?: string;
    statedAt?: string;
    validFrom?: string;
    validTo?: string;
  }>;
  attributeClaims?: Array<{
    subjectId: string;
    predicate: AttributePredicate;
    objectValue: string;
    statement: string;
    sourceRef: string;
    assertionKind: AssertedByKind;
    assertedBySpeakerLabel?: string;
    statedAt?: string;
    validFrom?: string;
    validTo?: string;
  }>;
  aliases?: Array<{ subjectId: string; aliasText: string }>;
}

/**
 * Canned segmentation response — used by transcript ingestion when input is
 * `{ kind: "raw" }`. Pre-segmented input bypasses the segmenter and so does
 * not need a stub.
 */
export interface SegmentationStubResponse {
  utterances: Array<{
    speakerLabel: string;
    content: string;
    timestamp?: string;
  }>;
}

export interface ConversationIngestStep {
  kind: "ingestConversation";
  conversationId: string;
  /** Each message becomes one extraction call. */
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
    name?: string;
  }>;
  /**
   * One canned extraction response per message, in order. The harness throws
   * if the production code asks for more responses than are queued.
   */
  extractionStubs: ExtractionStubResponse[];
}

export interface TranscriptIngestStep {
  kind: "ingestTranscript";
  transcriptId: string;
  occurredAt: Date;
  scope?: Scope;
  /** Pre-segmented avoids needing a segmentation stub. */
  utterances: Array<{
    speakerLabel: string;
    content: string;
    timestamp?: Date;
  }>;
  userSelfAliases?: string[];
  knownParticipants?: Array<{ label: string; nodeName: string }>;
  /** Single extraction response — transcript ingestion runs `extractGraph` once. */
  extractionStub: ExtractionStubResponse;
}

export type EvalStep =
  | { kind: "setup"; run: EvalSetupFn }
  | {
      kind: "applyCleanupOperations";
      operations: (ctx: EvalContext) => CleanupOperation[];
      /** Optional named seed-node ids passed to the cleanup mapper. */
      seedNodeIds?: (ctx: EvalContext) => TypeId<"node">[];
    }
  | { kind: "wait"; ms: number }
  | ConversationIngestStep
  | TranscriptIngestStep;

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
