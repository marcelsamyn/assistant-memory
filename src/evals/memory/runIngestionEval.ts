/**
 * Run a single eval fixture against a freshly-provisioned test database.
 *
 * Pipeline:
 *   1. Provision a clean DB and apply the harness DDL (`createEvalDatabase`).
 *   2. Override `useDatabase` via the `setTestDatabase` seam so production
 *      helpers (lifecycle, cleanup ops, getOpenCommitments) reach the
 *      ephemeral DB without touching the dev DB.
 *   3. Install harness seams in `~/utils/test-overrides`: stub source
 *      service, skip embedding persistence, skip semantic search. Stories
 *      that drive ingestion swap in a FIFO LLM stub per step.
 *   4. Run optional `setup` to seed nodes/sources/claims/aliases.
 *   5. Walk `steps` in order — including `ingestConversation` /
 *      `ingestTranscript` steps that thread canned LLM responses through the
 *      real ingestion entrypoints.
 *   6. Evaluate `expectations`; collect failures with structured detail.
 *   7. Snapshot the post-run claim landscape into `claimCounts`.
 *
 * The harness uses process-level seams (not vitest module mocks) so the
 * same code runs inside `pnpm run test` AND the standalone `pnpm run
 * eval:memory` CLI.
 *
 * Common aliases: ingestion eval, regression harness, claim layer eval, story
 * runner, fixture runner, extraction stub seam.
 */
import { createEvalDatabase, type EvalDatabase } from "./db-fixture";
import { evaluateExpectations, snapshotClaimCounts } from "./expectations";
import {
  createExtractionStubClient,
  createStubSourceService,
} from "./extraction-stubs";
import type {
  ConversationIngestStep,
  EvalContext,
  EvalFixture,
  EvalResult,
  EvalStep,
  TranscriptIngestStep,
} from "./types";
import type db from "~/db";
import { applyClaimLifecycle } from "~/lib/claims/lifecycle";
import {
  applyCleanupOperations,
  type CleanupOperation,
} from "~/lib/jobs/cleanup-operations";
import type { GraphNode } from "~/lib/jobs/cleanup-graph";
import { TemporaryIdMapper } from "~/lib/temporary-id-mapper";
import type { TypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
  setSkipSemanticSearch,
  setSourceServiceOverride,
} from "~/utils/test-overrides";

export interface RunIngestionEvalOptions {
  /** When true, leave the database intact for post-mortem inspection. */
  keepDatabase?: boolean;
}

/**
 * Execute a single fixture end-to-end. Always returns an `EvalResult`; never
 * throws on assertion failure (failures land in `result.failures`). It does
 * propagate setup errors that prevent the fixture from running at all.
 */
export async function runIngestionEval(
  fixture: EvalFixture,
  options: RunIngestionEvalOptions = {},
): Promise<EvalResult> {
  const start = Date.now();
  const result: EvalResult = {
    fixture: fixture.name,
    description: fixture.description,
    passed: false,
    failures: [],
    durationMs: 0,
    claimCounts: {},
  };

  let provisioned: EvalDatabase | undefined;
  try {
    provisioned = await createEvalDatabase(fixture.name);

    const harnessDb = provisioned.db;
    // Cast through `unknown` because the harness uses ad-hoc DDL rather than
    // the migrator (mirrors `cleanup-operations.test.ts`); the runtime shape
    // matches the production drizzle instance for every helper exercised
    // here, but the static type is shaped by `~/db`.
    setTestDatabase(harnessDb as unknown as typeof db);
    setSourceServiceOverride(createStubSourceService(harnessDb));
    setSkipEmbeddingPersistence(true);
    setSkipSemanticSearch(true);

    const userId = `eval_user_${fixture.name}`;
    const ctx: EvalContext = {
      db: harnessDb,
      userId,
      nodes: new Map(),
      sources: new Map(),
      claims: new Map(),
    };

    if (fixture.setup) {
      await fixture.setup(ctx);
    }

    for (const step of fixture.steps) {
      await runStep(step, ctx);
    }

    const failures = await evaluateExpectations(ctx, fixture.expectations);
    result.failures = failures;
    result.passed = failures.length === 0;
    result.claimCounts = await snapshotClaimCounts(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.passed = false;
    result.failures.push({
      kind: "harness_error",
      description: "fixture threw before assertions could run",
      expected: "no error",
      actual: message,
      message,
    });
  } finally {
    setTestDatabase(null);
    resetTestOverrides();
    if (provisioned && !options.keepDatabase) {
      await provisioned.cleanup();
    }
    result.durationMs = Date.now() - start;
  }

  return result;
}

async function runStep(step: EvalStep, ctx: EvalContext): Promise<void> {
  switch (step.kind) {
    case "setup":
      await step.run(ctx);
      return;
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      return;
    case "applyCleanupOperations": {
      const operations: CleanupOperation[] = step.operations(ctx);
      const seedNodeIds: TypeId<"node">[] = step.seedNodeIds
        ? step.seedNodeIds(ctx)
        : [...ctx.nodes.values()];
      const mapper = new TemporaryIdMapper<GraphNode, string>(
        (_node, index) => `temp_node_${index}`,
      );
      const graphNodes: GraphNode[] = seedNodeIds.map((id) => ({
        id,
        type: "Concept",
        label: "(seed)",
        description: "",
      }));
      mapper.mapItems(graphNodes);
      await applyCleanupOperations(ctx.db, ctx.userId, operations, mapper);
      return;
    }
    case "ingestConversation":
      await runConversationIngest(step, ctx);
      return;
    case "ingestTranscript":
      await runTranscriptIngest(step, ctx);
      return;
  }
}

async function runConversationIngest(
  step: ConversationIngestStep,
  ctx: EvalContext,
): Promise<void> {
  const { client, remaining } = createExtractionStubClient(step.extractionStubs);
  setExtractionClientOverride(client);

  try {
    const { ingestConversation } = await import("~/lib/jobs/ingest-conversation");
    // Each message goes through its own ingestion call so the FIFO stub queue
    // drains in lockstep with extractGraph invocations. This mirrors
    // production: each /conversation/ingest request typically delivers one
    // new message at a time, and `extractGraph` is invoked per call.
    for (const message of step.messages) {
      await ingestConversation({
        db: ctx.db,
        userId: ctx.userId,
        conversationId: step.conversationId,
        messages: [
          {
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            ...(message.name !== undefined ? { name: message.name } : {}),
          },
        ],
      });
    }
  } finally {
    setExtractionClientOverride(null);
  }

  if (remaining() !== 0) {
    throw new Error(
      `runConversationIngest: ${remaining()} extraction stub response(s) unconsumed for conversation '${step.conversationId}'.`,
    );
  }
}

async function runTranscriptIngest(
  step: TranscriptIngestStep,
  ctx: EvalContext,
): Promise<void> {
  const { client, remaining } = createExtractionStubClient([step.extractionStub]);
  setExtractionClientOverride(client);

  const knownParticipants = step.knownParticipants?.map((kp) => {
    const nodeId = ctx.nodes.get(kp.nodeName);
    if (!nodeId) {
      throw new Error(
        `ingestTranscript step references unknown participant node '${kp.nodeName}'.`,
      );
    }
    return { label: kp.label, nodeId };
  });

  try {
    const { ingestTranscript } = await import("~/lib/jobs/ingest-transcript");
    await ingestTranscript({
      db: ctx.db,
      userId: ctx.userId,
      transcriptId: step.transcriptId,
      scope: step.scope ?? "personal",
      occurredAt: step.occurredAt,
      content: {
        kind: "segmented",
        utterances: step.utterances.map((u) => ({
          speakerLabel: u.speakerLabel,
          content: u.content,
          ...(u.timestamp ? { timestamp: u.timestamp.toISOString() } : {}),
        })),
      },
      ...(knownParticipants !== undefined ? { knownParticipants } : {}),
      ...(step.userSelfAliases !== undefined
        ? { userSelfAliasesOverride: step.userSelfAliases }
        : {}),
    });
  } finally {
    setExtractionClientOverride(null);
  }

  if (remaining() !== 0) {
    throw new Error(
      `runTranscriptIngest: extraction stub response was not consumed for transcript '${step.transcriptId}'.`,
    );
  }
}

/**
 * Convenience wrapper for fixtures that need lifecycle replayed against
 * specific seeded claims (e.g. story 1's `HAS_STATUS` chain).
 *
 * Stories register the claim ids they want lifecycle applied to during
 * `setup`; this helper looks them up and replays `applyClaimLifecycle` so
 * supersession/`validTo`/`supersededByClaimId` get computed.
 */
export async function applyLifecycleByName(
  ctx: EvalContext,
  claimNames: string[],
): Promise<void> {
  const ids = claimNames.map((name) => {
    const id = ctx.claims.get(name);
    if (!id) throw new Error(`applyLifecycleByName: unknown claim '${name}'`);
    return id;
  });
  const { claims } = await import("~/db/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await ctx.db
    .select()
    .from(claims)
    .where(inArray(claims.id, ids));
  await applyClaimLifecycle(ctx.db, rows);
}
