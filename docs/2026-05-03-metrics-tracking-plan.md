# Metrics Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user metrics subsystem (definitions + observations + optional event-node bridge) to Assistant Memory, with three ingestion paths sharing one writer, embedding-based schema dedup, and a focused read API for charts and the agent.

**Architecture:** Two new tables (`metric_definitions`, `metric_observations`) plus per-definition embeddings, alongside the existing claims store. One internal writer (`recordMetricObservations`) handles definition resolution (exact slug → embedding similarity → create), range validation, and atomic insert; bulk REST, single REST, an MCP tool, and the existing extraction job all funnel through it. A small read API (`list_metrics`, `get_metric_series`, `get_metric_summary`) covers charts and conversational queries.

**Tech Stack:** TypeScript, Nitro, Drizzle ORM, PostgreSQL (with pgvector for embedding similarity), Zod schemas, MCP SDK, Vitest.

**Companion design doc:** [`docs/2026-05-03-metrics-tracking-design.md`](2026-05-03-metrics-tracking-design.md)

## Principles

- TDD throughout: write the failing test first, then make it pass.
- Each phase leaves the system in a runnable, tested state. `pnpm run build:check`, `pnpm run lint`, and `pnpm run test` must be clean at every phase boundary.
- Commit at phase boundaries with the project's commit style (`✨ feat(metrics): ...`).
- Reuse existing patterns ruthlessly: source-cascade behavior, embedding indexes, Task-as-commitment surfacing, MCP tool description snapshots.
- Threshold constants (`HIGH_SIMILARITY = 0.85`, `MID_SIMILARITY = 0.70`) live in `src/lib/metrics/constants.ts` so eval-driven tuning is one-file changes.

## File Inventory

**New files:**
- `src/lib/metrics/constants.ts` — threshold constants.
- `src/lib/metrics/definitions.ts` — definition resolver (slug → embedding → create) + review-Task wiring.
- `src/lib/metrics/observations.ts` — `recordMetricObservations` writer, range guard.
- `src/lib/metrics/sources.ts` — source upsert helpers for `metric_push` / `metric_manual`.
- `src/lib/metrics/series.ts` — bucketed series query.
- `src/lib/metrics/summary.ts` — single-metric summary (latest, windows, trend).
- `src/lib/metrics/list.ts` — definition listing with stats.
- `src/lib/metrics/event-nodes.ts` — deterministic event-node creation/dedup helper.
- `src/lib/schemas/metric-definition.ts` — definition zod schema.
- `src/lib/schemas/metric-observation.ts` — observation zod schema.
- `src/lib/schemas/metric-write.ts` — single + bulk write request/response schemas.
- `src/lib/schemas/metric-read.ts` — list + series + summary request/response schemas.
- `src/routes/metrics/observations.post.ts` — single write.
- `src/routes/metrics/observations/bulk.post.ts` — bulk push.
- `src/routes/metrics/list.post.ts` — list metrics.
- `src/routes/metrics/series.post.ts` — series.
- `src/routes/metrics/summary.post.ts` — summary.
- `drizzle/0015_metrics_tables.sql` — generated migration.
- Test files alongside each source file (`*.test.ts`).
- `src/db/migrations-metrics.test.ts` — migration smoke test (mirrors `migrations-claims.test.ts`).
- `src/evals/memory/stories/metrics-extraction.ts` — eval story.

**Modified files:**
- `src/types/typeid.ts` — add `metric_definition`, `metric_observation`, `metric_definition_embedding` typeids.
- `src/types/graph.ts` — add `metric_push` and `metric_manual` to `SourceType`.
- `src/db/schema.ts` — three new tables + relations.
- `src/lib/extract-graph.ts` — extend extraction schema + writer wiring.
- `src/lib/mcp/mcp-server.ts` — register `record_metric`, `list_metrics`, `get_metric_series`, `get_metric_summary`.
- `src/lib/mcp/tool-descriptions.ts` — descriptions for the four new tools.
- `src/lib/mcp/tool-descriptions.test.ts` — pin the four new descriptions via inline snapshots.
- `src/sdk/memory-client.ts` — client methods.
- `src/sdk/index.ts` — schema re-exports.

---

## Phase 1: Schema Foundation

**Goal.** Land the three tables, typeids, and source type variants. Migration applies cleanly; nothing reads or writes them yet.

### Task 1.1: Add typeid prefixes

**Files:**
- Modify: `src/types/typeid.ts`

- [ ] **Step 1: Add three new typeid names + prefixes**

In `src/types/typeid.ts`, extend the `ID_TYPE_NAMES` tuple and `ID_TYPE_PREFIXES` map:

```typescript
export const ID_TYPE_NAMES = [
  "node",
  "claim",
  "node_metadata",
  "node_embedding",
  "claim_embedding",
  "source",
  "alias",
  "source_link",
  "user_profile",
  "message",
  "scratchpad",
  "metric_definition",
  "metric_observation",
  "metric_definition_embedding",
] as const;

export const ID_TYPE_PREFIXES = {
  // ... existing entries unchanged ...
  metric_definition: "mdef",
  metric_observation: "mobs",
  metric_definition_embedding: "memb",
} as const satisfies Record<(typeof ID_TYPE_NAMES)[number], string>;
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run build:check`
Expected: PASS (the satisfies check enforces exhaustiveness).

### Task 1.2: Add metric source types

**Files:**
- Modify: `src/types/graph.ts`

- [ ] **Step 1: Extend SourceType union**

In `src/types/graph.ts`:

```typescript
export type SourceType =
  | "conversation"
  | "conversation_message"
  | "document"
  | "legacy_migration"
  | "manual"
  | "meeting_transcript"
  | "external_conversation"
  | "metric_push"
  | "metric_manual";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run build:check`
Expected: PASS.

### Task 1.3: Add three Drizzle tables

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add metric_definitions table**

Append to `src/db/schema.ts` (after `scratchpads`):

```typescript
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
    reviewTaskNodeId: typeIdNoDefault("node", { name: "review_task_node_id" })
      .references(() => nodes.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
```

Note: `validRangeMin/Max` use `text` (numeric arrives as string from pg driver to preserve precision). Apply `z.coerce.number()` in the read schema. Add the `boolean` import to the existing drizzle-orm/pg-core import block.

- [ ] **Step 2: Add metric_observations table**

```typescript
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
    value: text().notNull(), // numeric; same string-precision concern.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    note: text(),
    eventNodeId: typeIdNoDefault("node", { name: "event_node_id" }).references(
      () => nodes.id,
      { onDelete: "set null" },
    ),
    sourceId: typeId("source")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("metric_observations_user_def_occurred_idx").on(
      table.userId,
      table.metricDefinitionId,
      table.occurredAt,
    ),
    index("metric_observations_user_occurred_idx").on(
      table.userId,
      table.occurredAt,
    ),
    index("metric_observations_event_node_idx")
      .on(table.eventNodeId)
      .where(sql`${table.eventNodeId} IS NOT NULL`),
    index("metric_observations_source_id_idx").on(table.sourceId),
  ],
);
```

- [ ] **Step 3: Add metric_definition_embeddings table**

```typescript
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
```

- [ ] **Step 4: Add relations blocks**

```typescript
export const metricDefinitionsRelations = relations(
  metricDefinitions,
  ({ one, many }) => ({
    user: one(users, { fields: [metricDefinitions.userId], references: [users.id] }),
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
    user: one(users, { fields: [metricObservations.userId], references: [users.id] }),
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
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm run build:check`
Expected: PASS.

### Task 1.4: Generate and inspect migration

**Files:**
- Create: `drizzle/0015_metrics_tables.sql`

- [ ] **Step 1: Generate the migration**

Run: `pnpm run drizzle:generate`
Expected: a new file `drizzle/0015_*.sql` and updated meta journal.

- [ ] **Step 2: Inspect**

Run: `cat drizzle/0015_*.sql`
Expected: `CREATE TABLE` statements for all three tables, indexes, foreign keys, the partial index for `needs_review`, the HNSW vector index, and the unique constraints. Verify no destructive statements against existing tables.

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm run drizzle:migrate`
Expected: migration applies; postgres logs no errors.

### Task 1.5: Migration smoke test

**Files:**
- Create: `src/db/migrations-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror `src/db/migrations-claims.test.ts`. Insert a user, a definition, an observation, an embedding; assert round-trip fidelity, FK cascade on definition delete, FK cascade on source delete.

```typescript
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./index";
import {
  metricDefinitions,
  metricObservations,
  metricDefinitionEmbeddings,
  sources,
  users,
} from "./schema";
import { newTypeId } from "~/types/typeid";

describe("metrics schema migration", () => {
  it("supports definition + observation + embedding round-trip and source-cascade delete", async () => {
    const db = getDb();
    const userId = `test-user-${crypto.randomUUID()}`;
    await db.insert(users).values({ id: userId });

    const sourceId = newTypeId("source");
    await db.insert(sources).values({
      id: sourceId,
      userId,
      type: "metric_push",
      externalId: `oura-${crypto.randomUUID()}`,
    });

    const defId = newTypeId("metric_definition");
    await db.insert(metricDefinitions).values({
      id: defId,
      userId,
      slug: "test_resting_hr",
      label: "Resting HR",
      description: "Morning resting heart rate",
      unit: "bpm",
      aggregationHint: "avg",
    });

    await db.insert(metricObservations).values({
      userId,
      metricDefinitionId: defId,
      value: "54",
      occurredAt: new Date(),
      sourceId,
    });

    await db.insert(metricDefinitionEmbeddings).values({
      metricDefinitionId: defId,
      embedding: Array(1024).fill(0.01),
      modelName: "test-model",
    });

    // Cascade: deleting source nukes observations but not the definition.
    await db.delete(sources).where(eq(sources.id, sourceId));

    const obs = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.metricDefinitionId, defId));
    expect(obs).toHaveLength(0);

    const defs = await db
      .select()
      .from(metricDefinitions)
      .where(eq(metricDefinitions.id, defId));
    expect(defs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm run test src/db/migrations-metrics.test.ts`
Expected: PASS.

### Task 1.6: Phase 1 commit

- [ ] **Step 1: Run full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test`
Expected: all clean.

- [ ] **Step 2: Commit**

```bash
git add src/types/typeid.ts src/types/graph.ts src/db/schema.ts \
        drizzle/0015_*.sql drizzle/meta src/db/migrations-metrics.test.ts
git commit -m "✨ feat(metrics): schema foundation — definitions, observations, embeddings"
```

---

## Phase 2: Definition Resolver

**Goal.** A pure function that takes a proposed metric definition and returns an existing-or-newly-created `metricDefinitions` row, with mid-confidence matches creating a `Task` commitment for review.

### Task 2.1: Threshold constants and proposed-definition schema

**Files:**
- Create: `src/lib/metrics/constants.ts`
- Create: `src/lib/schemas/metric-definition.ts`

- [ ] **Step 1: Write the constants module**

```typescript
/** Cosine similarity thresholds for metric definition dedup. */
export const HIGH_SIMILARITY = 0.85;
export const MID_SIMILARITY = 0.70;
```

- [ ] **Step 2: Write the proposed-definition schema (single source of truth)**

This schema is shared by the resolver (Phase 2), the write APIs (Phase 4), and the extractor (Phase 7). Defining it now avoids parallel TypeScript-only types drifting from the zod schema.

```typescript
// src/lib/schemas/metric-definition.ts
import { z } from "zod";

export const aggregationHintSchema = z.enum(["avg", "sum", "min", "max"]);

export const proposedMetricDefinitionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{1,80}$/, "lowercase slug, snake_case, max 80 chars"),
  label: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  unit: z.string().min(1).max(40),
  aggregationHint: aggregationHintSchema,
  validRangeMin: z.number().optional(),
  validRangeMax: z.number().optional(),
});

export type ProposedMetricDefinition = z.infer<typeof proposedMetricDefinitionSchema>;
```

- [ ] **Step 3: Commit at end of phase, not now.**

### Task 2.2: Range guard utility

**Files:**
- Create: `src/lib/metrics/observations.ts` (initial — guard only; writer comes in Phase 3)
- Create: `src/lib/metrics/observations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { assertWithinRange, RangeViolationError } from "./observations";

describe("assertWithinRange", () => {
  it("passes when no range is set", () => {
    expect(() =>
      assertWithinRange({ value: 999, validRangeMin: null, validRangeMax: null }),
    ).not.toThrow();
  });
  it("rejects below min", () => {
    expect(() =>
      assertWithinRange({ value: 1, validRangeMin: "30", validRangeMax: "200" }),
    ).toThrow(RangeViolationError);
  });
  it("rejects above max", () => {
    expect(() =>
      assertWithinRange({ value: 500, validRangeMin: "30", validRangeMax: "200" }),
    ).toThrow(RangeViolationError);
  });
  it("accepts on the boundary", () => {
    expect(() =>
      assertWithinRange({ value: 30, validRangeMin: "30", validRangeMax: "200" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/observations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

```typescript
export class RangeViolationError extends Error {
  constructor(public readonly value: number, public readonly min: number | null, public readonly max: number | null) {
    super(`Value ${value} outside allowed range [${min ?? "-∞"}, ${max ?? "∞"}]`);
    this.name = "RangeViolationError";
  }
}

export function assertWithinRange(input: {
  value: number;
  validRangeMin: string | null;
  validRangeMax: string | null;
}): void {
  const min = input.validRangeMin === null ? null : Number(input.validRangeMin);
  const max = input.validRangeMax === null ? null : Number(input.validRangeMax);
  if (min !== null && input.value < min) throw new RangeViolationError(input.value, min, max);
  if (max !== null && input.value > max) throw new RangeViolationError(input.value, min, max);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm run test src/lib/metrics/observations.test.ts`
Expected: PASS.

### Task 2.3: Embedding helper for definitions

**Files:**
- Create: `src/lib/metrics/definitions.ts`

- [ ] **Step 1: Locate the existing embedding service**

Run: `grep -r "embed(" src/lib --include="*.ts" -l | head -5`

Identify the function used for `node_embeddings` / `claim_embeddings`. Reuse it. (If the codebase exposes `embedTexts(strings: string[]): Promise<{ vectors, modelName }[]>`, use that. The plan assumes such a helper; if naming differs, follow the existing pattern.)

- [ ] **Step 2: Add `embedDefinition` thin wrapper to `definitions.ts`**

```typescript
import { embedTexts } from "../embedding"; // adjust to the actual import path
import { db } from "~/db";
import { metricDefinitionEmbeddings } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

export interface DefinitionEmbeddingInput {
  label: string;
  description: string;
}

export function embeddingTextFor(input: DefinitionEmbeddingInput): string {
  return `${input.label}\n${input.description}`;
}

export async function upsertDefinitionEmbedding(
  metricDefinitionId: TypeId<"metric_definition">,
  input: DefinitionEmbeddingInput,
): Promise<void> {
  const [{ vectors, modelName }] = await embedTexts([embeddingTextFor(input)]);
  // The unique constraint enforces one embedding per definition.
  await db
    .insert(metricDefinitionEmbeddings)
    .values({ metricDefinitionId, embedding: vectors[0], modelName })
    .onConflictDoUpdate({
      target: metricDefinitionEmbeddings.metricDefinitionId,
      set: { embedding: vectors[0], modelName },
    });
}
```

If the codebase doesn't expose a re-usable `embedTexts`, refactor the existing call site (likely in `lib/extract-graph.ts` or under `lib/`) to extract one before continuing. Do not duplicate embedding-call code.

- [ ] **Step 3: No test yet — covered in Task 2.4 resolver tests.**

### Task 2.4: Resolver — exact slug match

**Files:**
- Create: `src/lib/metrics/definitions.test.ts`
- Modify: `src/lib/metrics/definitions.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db";
import { metricDefinitions, users } from "~/db/schema";
import { resolveDefinition } from "./definitions";

describe("resolveDefinition — exact slug match", () => {
  const userId = `test-user-${crypto.randomUUID()}`;
  beforeEach(async () => {
    await db.insert(users).values({ id: userId });
    await db.insert(metricDefinitions).values({
      userId,
      slug: "running_pace_min_per_km",
      label: "Running pace",
      description: "Average pace per km on a run",
      unit: "min/km",
      aggregationHint: "avg",
    });
  });
  afterEach(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns the existing definition when slug matches exactly", async () => {
    const result = await resolveDefinition({
      userId,
      proposed: {
        slug: "running_pace_min_per_km",
        label: "Pace",
        description: "Run pace",
        unit: "min/km",
        aggregationHint: "avg",
      },
    });
    expect(result.created).toBe(false);
    expect(result.definition.slug).toBe("running_pace_min_per_km");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/definitions.test.ts`
Expected: FAIL — `resolveDefinition` not exported.

- [ ] **Step 3: Implement exact-match arm**

```typescript
import type { ProposedMetricDefinition } from "~/lib/schemas/metric-definition";

export interface ResolveResult {
  definition: typeof metricDefinitions.$inferSelect;
  created: boolean;
  needsReview: boolean;
  reviewTaskNodeId: TypeId<"node"> | null;
}

export async function resolveDefinition(input: {
  userId: string;
  proposed: ProposedMetricDefinition;
}): Promise<ResolveResult> {
  // 1. Exact slug.
  const [existing] = await db
    .select()
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, input.userId),
        eq(metricDefinitions.slug, input.proposed.slug),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      definition: existing,
      created: false,
      needsReview: existing.needsReview,
      reviewTaskNodeId: existing.reviewTaskNodeId,
    };
  }
  throw new Error("not implemented yet — embedding arm in next task");
}
```

- [ ] **Step 4: Run to confirm exact-match test passes**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "exact slug"`
Expected: PASS.

### Task 2.5: Resolver — high similarity (auto-reuse)

- [ ] **Step 1: Write the failing test**

Append to `definitions.test.ts`:

```typescript
describe("resolveDefinition — high similarity", () => {
  it("reuses existing definition when cosine ≥ 0.85", async () => {
    // Seed a definition + embedding manually with a known vector.
    // Then call resolveDefinition with a proposal whose embedding will be
    // identical (mock embedTexts to return the same vector).
    // Assert: result.created === false, result.definition.slug === existing.slug.
  });
});
```

Implement using the existing test mocking pattern (look at `src/lib/extract-graph.test.ts` for how the embedding service is mocked in tests).

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "high similarity"`
Expected: FAIL.

- [ ] **Step 3: Implement embedding-similarity arm**

In `definitions.ts`, replace the `throw` with a similarity query using pgvector cosine distance:

```typescript
import { sql } from "drizzle-orm";
import { HIGH_SIMILARITY, MID_SIMILARITY } from "./constants";

// ... inside resolveDefinition, after exact-match miss:
const [{ vectors }] = await embedTexts([
  embeddingTextFor({ label: input.proposed.label, description: input.proposed.description }),
]);
const proposedVec = vectors[0];

const candidates = await db
  .select({
    def: metricDefinitions,
    similarity: sql<number>`1 - (${metricDefinitionEmbeddings.embedding} <=> ${proposedVec}::vector)`,
  })
  .from(metricDefinitions)
  .innerJoin(
    metricDefinitionEmbeddings,
    eq(metricDefinitionEmbeddings.metricDefinitionId, metricDefinitions.id),
  )
  .where(eq(metricDefinitions.userId, input.userId))
  .orderBy(sql`${metricDefinitionEmbeddings.embedding} <=> ${proposedVec}::vector`)
  .limit(1);

const top = candidates[0];

if (top && top.similarity >= HIGH_SIMILARITY) {
  return {
    definition: top.def,
    created: false,
    needsReview: top.def.needsReview,
    reviewTaskNodeId: top.def.reviewTaskNodeId,
  };
}
// Mid- and low-confidence arms in next task.
throw new Error("not implemented yet");
```

- [ ] **Step 4: Run to confirm test passes**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "high similarity"`
Expected: PASS.

### Task 2.6: Resolver — mid similarity (create + review Task)

- [ ] **Step 1: Write the failing test**

Append to `definitions.test.ts`:

```typescript
describe("resolveDefinition — mid similarity", () => {
  it("creates definition with needsReview=true and a linked Task commitment", async () => {
    // Seed an existing definition + embedding so that the proposal lands
    // in the 0.70–0.85 band (mock embedTexts to control distance).
    // Assert: result.created === true, result.needsReview === true,
    //         result.reviewTaskNodeId !== null,
    //         a Task node exists with HAS_TASK_STATUS=pending,
    //         the new definition row carries the same reviewTaskNodeId.
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "mid similarity"`
Expected: FAIL.

- [ ] **Step 3: Implement the mid-similarity arm**

Wrap the steps in a single `db.transaction(async (tx) => { ... })` so the definition + embedding + node + claim land atomically. Reuse the existing claim-creation helper for `HAS_TASK_STATUS` (look at `src/lib/claim.ts` and `src/lib/jobs/identity-reeval.ts` for reference patterns).

```typescript
if (top && top.similarity >= MID_SIMILARITY) {
  return await db.transaction(async (tx) => {
    const newDef = await insertDefinition(tx, input.userId, input.proposed, {
      needsReview: true,
    });
    await upsertDefinitionEmbedding(newDef.id, input.proposed); // run on tx-bound db
    const reviewTaskNodeId = await createReviewTaskNode(tx, {
      userId: input.userId,
      proposedDef: newDef,
      candidateDef: top.def,
    });
    await tx
      .update(metricDefinitions)
      .set({ reviewTaskNodeId })
      .where(eq(metricDefinitions.id, newDef.id));
    return {
      definition: { ...newDef, reviewTaskNodeId },
      created: true,
      needsReview: true,
      reviewTaskNodeId,
    };
  });
}
```

`createReviewTaskNode` lives in `definitions.ts`. It creates a `Task` node with `nodeMetadata.label = "Review proposed metric: '${proposedDef.label}'"`, then a `HAS_TASK_STATUS` claim with `objectValue = "pending"`, plus `assertedByKind = "system"`. Reference the existing Task creation paths (search for `HAS_TASK_STATUS` to find them).

- [ ] **Step 4: Run to confirm test passes**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "mid similarity"`
Expected: PASS.

### Task 2.7: Resolver — low similarity (create outright)

- [ ] **Step 1: Write the failing test**

```typescript
describe("resolveDefinition — low similarity", () => {
  it("creates definition with needsReview=false when cosine < 0.70", async () => {
    // No seeded definitions, or seeded ones with totally different embeddings.
    // Assert: result.created === true, result.needsReview === false,
    //         result.reviewTaskNodeId === null.
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/definitions.test.ts -t "low similarity"`
Expected: FAIL.

- [ ] **Step 3: Implement low-similarity arm**

Replace the trailing `throw new Error("not implemented yet")` with:

```typescript
return await db.transaction(async (tx) => {
  const newDef = await insertDefinition(tx, input.userId, input.proposed, {
    needsReview: false,
  });
  await upsertDefinitionEmbedding(newDef.id, input.proposed);
  return { definition: newDef, created: true, needsReview: false, reviewTaskNodeId: null };
});
```

- [ ] **Step 4: Run to confirm passes**

Run: `pnpm run test src/lib/metrics/definitions.test.ts`
Expected: ALL PASS.

### Task 2.8: Phase 2 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test`
Expected: clean.

- [ ] **Step 2: Commit**

```bash
git add src/lib/metrics/
git commit -m "✨ feat(metrics): definition resolver with embedding-based dedup"
```

---

## Phase 3: Internal Writer

**Goal.** `recordMetricObservations` — the single internal entry point all three ingestion paths share. Handles definition resolution per observation, range validation, optional event-node creation, and atomic insert.

### Task 3.1: Source upsert helper

**Files:**
- Create: `src/lib/metrics/sources.ts`
- Create: `src/lib/metrics/sources.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ensureMetricSource } from "./sources";

describe("ensureMetricSource", () => {
  it("returns existing source on second call with same externalId", async () => {
    const userId = `test-user-${crypto.randomUUID()}`;
    // ... insert user ...
    const a = await ensureMetricSource({
      userId, type: "metric_push", externalId: "oura_2026-05-03",
    });
    const b = await ensureMetricSource({
      userId, type: "metric_push", externalId: "oura_2026-05-03",
    });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/sources.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { sources } from "~/db/schema";
import type { SourceType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { newTypeId } from "~/types/typeid";

export async function ensureMetricSource(input: {
  userId: string;
  type: Extract<SourceType, "metric_push" | "metric_manual">;
  externalId: string;
}): Promise<TypeId<"source">> {
  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, input.userId),
        eq(sources.type, input.type),
        eq(sources.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = newTypeId("source");
  await db.insert(sources).values({
    id,
    userId: input.userId,
    type: input.type,
    externalId: input.externalId,
    status: "completed",
  });
  return id;
}
```

- [ ] **Step 4: Run test**

Run: `pnpm run test src/lib/metrics/sources.test.ts`
Expected: PASS.

### Task 3.2: Event-node helper with deterministic id

**Files:**
- Create: `src/lib/metrics/event-nodes.ts`
- Create: `src/lib/metrics/event-nodes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ensureEventNode } from "./event-nodes";

describe("ensureEventNode", () => {
  it("is idempotent for the same (sourceId, eventKey)", async () => {
    // Seed user + source.
    const a = await ensureEventNode({
      userId, sourceId, eventKey: "morning-run-1", label: "Morning run", occurredAt: new Date(),
    });
    const b = await ensureEventNode({
      userId, sourceId, eventKey: "morning-run-1", label: "Morning run", occurredAt: new Date(),
    });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/event-nodes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The dedup key lives on `nodeMetadata.additionalData` as `{ metricEventKey: <sourceId>:<eventKey> }`. On second call, look up by that key.

```typescript
import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { newTypeId, type TypeId } from "~/types/typeid";

export async function ensureEventNode(input: {
  userId: string;
  sourceId: TypeId<"source">;
  eventKey: string;
  label: string;
  occurredAt: Date;
}): Promise<TypeId<"node">> {
  const fullKey = `${input.sourceId}:${input.eventKey}`;
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, input.userId),
        sql`${nodeMetadata.additionalData} ->> 'metricEventKey' = ${fullKey}`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  return await db.transaction(async (tx) => {
    const id = newTypeId("node");
    await tx.insert(nodes).values({ id, userId: input.userId, nodeType: "Event" });
    await tx.insert(nodeMetadata).values({
      nodeId: id,
      label: input.label,
      additionalData: { metricEventKey: fullKey, occurredAt: input.occurredAt.toISOString() },
    });
    return id;
  });
}
```

- [ ] **Step 4: Run test**

Run: `pnpm run test src/lib/metrics/event-nodes.test.ts`
Expected: PASS.

### Task 3.3: `recordMetricObservations` writer

**Files:**
- Modify: `src/lib/metrics/observations.ts`
- Modify: `src/lib/metrics/observations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("recordMetricObservations", () => {
  it("writes observations with resolved definition + range guard + optional event node", async () => {
    // Seed user + source.
    const result = await recordMetricObservations({
      userId,
      sourceId,
      events: [
        {
          eventKey: "run-1",
          label: "Morning run",
          occurredAt: new Date("2026-05-03T06:30:00Z"),
          observations: [
            {
              metric: { slug: "running_distance_km", label: "Run distance", description: "km", unit: "km", aggregationHint: "sum" },
              value: 5.0,
              note: null,
            },
            {
              metric: { slug: "running_avg_hr", label: "Run HR", description: "bpm", unit: "bpm", aggregationHint: "avg", validRangeMax: 250 },
              value: 158,
              note: "felt sluggish",
            },
          ],
        },
      ],
      standalone: [],
    });
    expect(result.inserted).toBe(2);
    expect(result.errors).toHaveLength(0);
    // Assert: both observations share an eventNodeId.
    // Assert: a Node of type "Event" exists with the right label.
  });

  it("rejects an out-of-range observation with a typed error and continues", async () => {
    // Seed a definition with validRangeMax = 250.
    const result = await recordMetricObservations({
      userId, sourceId,
      events: [],
      standalone: [
        { metric: { slug: "running_avg_hr", ... }, value: 500, occurredAt: new Date() },
        { metric: { slug: "body_weight",     ... }, value: 78, occurredAt: new Date() },
      ],
    });
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([{ index: 0, code: "RANGE_VIOLATION", message: expect.any(String) }]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/observations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the writer**

```typescript
import type { ProposedMetricDefinition } from "~/lib/schemas/metric-definition";

export interface ObservationInput {
  metric: ProposedMetricDefinition;
  value: number;
  occurredAt: Date;
  note?: string | null;
}

export interface EventInput {
  eventKey: string;
  label: string;
  occurredAt: Date;
  observations: Omit<ObservationInput, "occurredAt">[];
}

export interface RecordResult {
  inserted: number;
  errors: { index: number; code: "RANGE_VIOLATION" | "RESOLVE_FAILED"; message: string }[];
}

export async function recordMetricObservations(input: {
  userId: string;
  sourceId: TypeId<"source">;
  events: EventInput[];
  standalone: ObservationInput[];
}): Promise<RecordResult> {
  // Per-event: ensureEventNode, then for each obs: resolveDefinition + assertWithinRange + insert.
  // Per-standalone: same minus event node.
  // Index for error reporting is positional across (events flattened in order, then standalone).
  // Errors do not abort the whole call; each row is its own try/catch.
  // Returns counts; emits structured logs on inserts/errors.
}
```

(The full implementation is mechanical given the helpers from Tasks 2.4–3.2 — write it out following the test's expectations.)

- [ ] **Step 4: Run tests**

Run: `pnpm run test src/lib/metrics/observations.test.ts`
Expected: PASS.

### Task 3.4: Phase 3 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test`
Expected: clean.

- [ ] **Step 2: Commit**

```bash
git add src/lib/metrics/
git commit -m "✨ feat(metrics): unified observation writer with event-node bridge"
```

---

## Phase 4: Write APIs (REST + SDK)

**Goal.** Externalize the writer through two REST endpoints and SDK methods. No MCP yet.

### Task 4.1: Write request/response schemas

**Files:**
- Create: `src/lib/schemas/metric-write.ts`

(`metric-definition.ts` already exists from Task 2.1.)

- [ ] **Step 1: Write schemas**

```typescript
// metric-write.ts
import { z } from "zod";
import { proposedMetricDefinitionSchema } from "./metric-definition";

export const singleWriteRequestSchema = z.object({
  userId: z.string().min(1),
  metric: proposedMetricDefinitionSchema,
  value: z.number(),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  note: z.string().max(2000).nullable().optional(),
});

export const bulkWriteRowSchema = z.object({
  metricSlug: z.string().regex(/^[a-z0-9_]{1,80}$/),
  value: z.number(),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  note: z.string().max(2000).nullable().optional(),
});

export const bulkWriteRequestSchema = z.object({
  userId: z.string().min(1),
  sourceExternalId: z.string().min(1).max(200),
  observations: z.array(bulkWriteRowSchema).min(1).max(5000),
});

export const writeResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      code: z.enum(["RANGE_VIOLATION", "RESOLVE_FAILED", "DEFINITION_NOT_FOUND"]),
      message: z.string(),
    }),
  ),
  // For single writes only:
  definitionCreated: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  reviewTaskNodeId: z.string().nullable().optional(),
});

export type SingleWriteRequest = z.infer<typeof singleWriteRequestSchema>;
export type BulkWriteRequest = z.infer<typeof bulkWriteRequestSchema>;
export type WriteResponse = z.infer<typeof writeResponseSchema>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

### Task 4.2: Single write route

**Files:**
- Create: `src/routes/metrics/observations.post.ts`
- Create: `src/routes/metrics/observations.test.ts` *(NOTE: per `AGENTS.md`, route tests must NOT live under `src/routes/`. Place at `src/lib/metrics/routes-observations.test.ts` instead and import the route module.)*

- [ ] **Step 1: Write the failing integration test**

Drive the route as a normal Nitro handler test (look at `src/lib/extract-graph.test.ts` or any existing route test for the pattern, calling the handler with a mock H3 event).

```typescript
// src/lib/metrics/routes-observations.test.ts
import { describe, expect, it } from "vitest";
import handler from "~/routes/metrics/observations.post";
// Minimal H3 event mock or your existing test helper:
import { createTestEvent, readJson } from "../../../tests/h3-helpers"; // adjust to your helper

describe("POST /metrics/observations", () => {
  it("creates a definition + observation on first call", async () => {
    const body = {
      userId: "test-user",
      metric: { slug: "body_weight", label: "Weight", description: "kg",
                unit: "kg", aggregationHint: "avg" },
      value: 78.2,
      occurredAt: new Date().toISOString(),
    };
    const event = createTestEvent({ method: "POST", body });
    const res = await handler(event);
    expect(res).toMatchObject({
      inserted: 1, errors: [], definitionCreated: true, needsReview: false,
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm run test src/lib/metrics/routes-observations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```typescript
// src/routes/metrics/observations.post.ts
import { defineEventHandler, readValidatedBody } from "h3";
import { singleWriteRequestSchema } from "~/lib/schemas/metric-write";
import { recordMetricObservations } from "~/lib/metrics/observations";
import { resolveDefinition } from "~/lib/metrics/definitions";
import { ensureMetricSource } from "~/lib/metrics/sources";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { db } from "~/db";

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, (data) =>
    singleWriteRequestSchema.parse(data),
  );
  await ensureUser(db, body.userId);

  // Single writes get a fresh source per call.
  const sourceId = await ensureMetricSource({
    userId: body.userId,
    type: "metric_manual",
    externalId: `manual_${crypto.randomUUID()}`,
  });

  // Resolve definition once up front so we can return definitionCreated.
  const resolved = await resolveDefinition({
    userId: body.userId,
    proposed: body.metric,
  });

  const result = await recordMetricObservations({
    userId: body.userId,
    sourceId,
    events: [],
    standalone: [
      {
        metric: body.metric,
        value: body.value,
        occurredAt: body.occurredAt,
        note: body.note ?? null,
      },
    ],
  });

  return {
    ...result,
    definitionCreated: resolved.created,
    needsReview: resolved.needsReview,
    reviewTaskNodeId: resolved.reviewTaskNodeId,
  };
});
```

- [ ] **Step 4: Run test**

Run: `pnpm run test src/lib/metrics/routes-observations.test.ts`
Expected: PASS.

### Task 4.3: Bulk write route

**Files:**
- Create: `src/routes/metrics/observations/bulk.post.ts`
- Create: `src/lib/metrics/routes-bulk.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("POST /metrics/observations/bulk", () => {
  it("inserts known-slug observations and returns errors for unknown slugs", async () => {
    // Seed userId + a single definition with slug "oura_readiness".
    const event = createTestEvent({
      method: "POST",
      body: {
        userId, sourceExternalId: "oura_2026-05-03",
        observations: [
          { metricSlug: "oura_readiness", value: 87, occurredAt: "2026-05-03T07:14:00Z" },
          { metricSlug: "unknown_slug",   value: 1,  occurredAt: "2026-05-03T07:14:00Z" },
        ],
      },
    });
    const res = await handler(event);
    expect(res.inserted).toBe(1);
    expect(res.errors).toEqual([
      { index: 1, code: "DEFINITION_NOT_FOUND", message: expect.any(String) },
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL.

- [ ] **Step 3: Implement the route**

The bulk route does NOT call `recordMetricObservations` for definition resolution. Instead:

1. Validate the body.
2. Upsert the source via `ensureMetricSource({ type: "metric_push", externalId })`.
3. Fetch all referenced slugs in one query: `SELECT id, slug FROM metric_definitions WHERE user_id = $1 AND slug IN (...)`.
4. For each row, if the slug exists, write the observation directly (with range guard); else push `{ index, code: "DEFINITION_NOT_FOUND", message }` into errors.
5. Return `{ inserted, errors }`. (No `definitionCreated` field — bulk never creates definitions.)

The `DEFINITION_NOT_FOUND` error code is exclusive to this route — `recordMetricObservations` itself only emits `RANGE_VIOLATION` and `RESOLVE_FAILED`.

- [ ] **Step 4: Run test**

Expected: PASS.

### Task 4.4: SDK client methods

**Files:**
- Modify: `src/sdk/memory-client.ts`
- Modify: `src/sdk/index.ts`

- [ ] **Step 1: Add client methods**

Mirror the existing pattern (look at how `saveMemory`, `searchMemory`, etc. are exposed):

```typescript
// memory-client.ts
async recordMetricObservation(input: SingleWriteRequest): Promise<WriteResponse> {
  return this.post("/metrics/observations", input, writeResponseSchema);
}
async recordMetricObservationsBulk(input: BulkWriteRequest): Promise<WriteResponse> {
  return this.post("/metrics/observations/bulk", input, writeResponseSchema);
}
```

- [ ] **Step 2: Re-export schemas**

```typescript
// sdk/index.ts
export * from "../lib/schemas/metric-definition.js";
export * from "../lib/schemas/metric-observation.js";
export * from "../lib/schemas/metric-write.js";
```

- [ ] **Step 3: SDK build verification**

Run: `pnpm run build-sdk`
Expected: clean build, no missing-export warnings.

### Task 4.5: Phase 4 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test && pnpm run build-sdk`
Expected: clean.

- [ ] **Step 2: Commit**

```bash
git add src/routes/metrics src/lib/metrics src/lib/schemas src/sdk
git commit -m "✨ feat(metrics): single + bulk write APIs and SDK methods"
```

---

## Phase 5: Read APIs

**Goal.** `list_metrics`, `get_metric_series`, `get_metric_summary` REST + SDK. No MCP yet.

### Task 5.1: Read schemas

**Files:**
- Create: `src/lib/schemas/metric-read.ts`

- [ ] **Step 1: Schemas**

```typescript
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid";
import { aggregationHintSchema } from "./metric-definition";

export const listMetricsRequestSchema = z.object({
  userId: z.string().min(1),
  filter: z.object({
    needsReview: z.boolean().optional(),
    search: z.string().min(1).max(200).optional(),
  }).optional(),
});

export const metricListItemSchema = z.object({
  id: typeIdSchema("metric_definition"),
  slug: z.string(),
  label: z.string(),
  unit: z.string(),
  aggregationHint: aggregationHintSchema,
  validRange: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
  needsReview: z.boolean(),
  reviewTaskNodeId: typeIdSchema("node").nullable(),
  stats: z.object({
    observationCount: z.number().int().nonnegative(),
    firstAt: z.string().datetime().nullable(),
    latestAt: z.string().datetime().nullable(),
    latestValue: z.number().nullable(),
  }),
});

export const listMetricsResponseSchema = z.object({
  metrics: z.array(metricListItemSchema),
});

export const seriesRequestSchema = z.object({
  userId: z.string().min(1),
  metricIds: z.array(typeIdSchema("metric_definition")).min(1).max(20),
  from: z.string().datetime().pipe(z.coerce.date()),
  to: z.string().datetime().pipe(z.coerce.date()),
  bucket: z.enum(["none", "hour", "day", "week", "month"]),
  agg: z.enum(["avg", "sum", "min", "max", "p50", "p90"]).optional(),
});

export const seriesPointSchema = z.object({
  t: z.string().datetime(),
  value: z.number(),
});

export const seriesResponseSchema = z.object({
  series: z.array(z.object({
    metricId: typeIdSchema("metric_definition"),
    points: z.array(seriesPointSchema),
    truncated: z.boolean().optional(),
  })),
});

export const summaryRequestSchema = z.object({
  userId: z.string().min(1),
  metricId: typeIdSchema("metric_definition"),
});

export const summaryResponseSchema = z.object({
  metricId: typeIdSchema("metric_definition"),
  latest: z.object({ value: z.number(), occurredAt: z.string().datetime() }).nullable(),
  windows: z.object({
    "7d": z.object({ avg: z.number(), min: z.number(), max: z.number(), count: z.number().int() }).nullable(),
    "30d": z.object({ avg: z.number(), min: z.number(), max: z.number(), count: z.number().int() }).nullable(),
    "90d": z.object({ avg: z.number(), min: z.number(), max: z.number(), count: z.number().int() }).nullable(),
  }),
  trend: z.enum(["up", "down", "flat"]).nullable(),
});
```

### Task 5.2: List metrics implementation

**Files:**
- Create: `src/lib/metrics/list.ts`
- Create: `src/lib/metrics/list.test.ts`

- [ ] **Step 1: Write the failing test**

Cover three rows: a definition with no observations (stats are zero/null), a definition with multiple observations (stats reflect them), a definition with `needsReview = true` (the response includes `reviewTaskNodeId`).

- [ ] **Step 2: Implement**

A single SQL with a left join + grouped aggregates for the stats (count, min/max occurredAt, last-value via `(SELECT value FROM metric_observations WHERE metric_definition_id = ... ORDER BY occurred_at DESC LIMIT 1)` correlated subquery — or compute latestValue in a separate per-definition pass if SQL gets unwieldy; correctness first). Filter by `needsReview` and `search` (ILIKE on `label`).

- [ ] **Step 3: Run test**

Expected: PASS.

### Task 5.3: Series implementation

**Files:**
- Create: `src/lib/metrics/series.ts`
- Create: `src/lib/metrics/series.test.ts`

- [ ] **Step 1: Write the failing test**

Seed 30 daily observations for one definition. Query `bucket: "week"`, `agg: "avg"` over a 4-week window. Assert: 4 buckets, each value equals the manually computed average.

Also assert: `bucket: "none"` returns raw points; `metricIds` array of 2 returns 2 series.

- [ ] **Step 2: Implement**

Use Drizzle raw SQL for bucketing:

```typescript
const bucketExpr = sql<string>`date_trunc(${input.bucket}, ${metricObservations.occurredAt})`;
const aggExpr = (() => {
  switch (agg) {
    case "avg": return sql<number>`AVG(${metricObservations.value}::numeric)`;
    case "sum": return sql<number>`SUM(${metricObservations.value}::numeric)`;
    case "min": return sql<number>`MIN(${metricObservations.value}::numeric)`;
    case "max": return sql<number>`MAX(${metricObservations.value}::numeric)`;
    case "p50": return sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${metricObservations.value}::numeric)`;
    case "p90": return sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${metricObservations.value}::numeric)`;
  }
})();
```

For `bucket: "none"` skip the GROUP BY and return raw rows; cap at 10000 rows and set `truncated: true` if hit. For `agg` defaulting, look up each metric's `aggregationHint` first and apply per-metric.

- [ ] **Step 3: Run test**

Expected: PASS.

### Task 5.4: Summary implementation

**Files:**
- Create: `src/lib/metrics/summary.ts`
- Create: `src/lib/metrics/summary.test.ts`

- [ ] **Step 1: Write the failing test**

Seed observations across 100 days. Assert: latest value matches the most recent obs, 7d/30d/90d windows have correct averages, trend is "down" when 30d avg < 90d avg (or "up" when greater, "flat" when within 1% of each other).

- [ ] **Step 2: Implement**

One SQL with `FILTER (WHERE occurred_at >= now() - interval '7 days')` clauses for each window aggregate; one short `latest` query. Trend computation in JS from the windows.

- [ ] **Step 3: Run test**

Expected: PASS.

### Task 5.5: Routes + SDK methods

**Files:**
- Create: `src/routes/metrics/list.post.ts`, `series.post.ts`, `summary.post.ts`
- Modify: `src/sdk/memory-client.ts`, `src/sdk/index.ts`

- [ ] **Step 1: Write thin route handlers**

Each route validates the body against its schema, calls the corresponding `lib/metrics/*` function, returns the result.

- [ ] **Step 2: Add SDK methods**

```typescript
async listMetrics(input: ListMetricsRequest): Promise<ListMetricsResponse> { ... }
async getMetricSeries(input: SeriesRequest): Promise<SeriesResponse> { ... }
async getMetricSummary(input: SummaryRequest): Promise<SummaryResponse> { ... }
```

- [ ] **Step 3: Re-export `metric-read` schemas from `src/sdk/index.ts`.**

### Task 5.6: Phase 5 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test && pnpm run build-sdk`
Expected: clean.

- [ ] **Step 2: Commit**

```bash
git add src/lib/metrics src/lib/schemas src/routes/metrics src/sdk
git commit -m "✨ feat(metrics): list, series, and summary read APIs"
```

---

## Phase 6: MCP Integration

**Goal.** Four new MCP tools wired to the existing read/write paths, with pinned descriptions.

### Task 6.1: Tool descriptions

**Files:**
- Modify: `src/lib/mcp/tool-descriptions.ts`
- Modify: `src/lib/mcp/tool-descriptions.test.ts`

- [ ] **Step 1: Add the four descriptions**

Append to `tool-descriptions.ts`:

```typescript
export const RECORD_METRIC_DESCRIPTION =
  "Records a single numeric reading the user is tracking (weight, distance, sleep duration, mood score). Provide a metric definition (slug, label, unit, aggregation hint) — the system reuses existing definitions for similar concepts and creates new ones automatically. Use for ad-hoc readings the user mentions in chat (\"log that I weighed 78kg\"). Do not use for retrospective bulk imports.";

export const LIST_METRICS_DESCRIPTION =
  "Returns the user's tracked metric definitions with lightweight stats (count, latest value, first/latest timestamps). Call before answering questions about what's being tracked, or before get_metric_series so you have a definition id and the right unit. Optionally filter by needsReview to surface metrics that need user disambiguation.";

export const GET_METRIC_SERIES_DESCRIPTION =
  "Returns time-bucketed series for one or more metrics. Use for charts and for answering \"how has X changed over time\" questions. Pass metric ids from list_metrics, a from/to range, and a bucket size (none|hour|day|week|month). The aggregation defaults to each metric's stored hint (steps→sum, HR→avg) — only override agg if the question demands a different statistic.";

export const GET_METRIC_SUMMARY_DESCRIPTION =
  "Returns a quick summary for one metric: latest value, 7d/30d/90d window stats, and a coarse trend (up|down|flat). Use for \"what's my X been like lately\" questions where a full series is overkill. For comparisons across metrics or precise charts, use get_metric_series instead.";
```

- [ ] **Step 2: Add inline snapshots in `tool-descriptions.test.ts`**

Mirror the existing snapshot pattern — one `it("pins ...")` block per description.

- [ ] **Step 3: Run snapshot tests**

Run: `pnpm run test src/lib/mcp/tool-descriptions.test.ts`
Expected: PASS (snapshots write on first run; `-u` if needed).

### Task 6.2: Register tools in MCP server

**Files:**
- Modify: `src/lib/mcp/mcp-server.ts`

- [ ] **Step 1: Import descriptions and request schemas**

```typescript
import {
  RECORD_METRIC_DESCRIPTION,
  LIST_METRICS_DESCRIPTION,
  GET_METRIC_SERIES_DESCRIPTION,
  GET_METRIC_SUMMARY_DESCRIPTION,
} from "./tool-descriptions";
import {
  singleWriteRequestSchema,
  writeResponseSchema,
} from "~/lib/schemas/metric-write";
import {
  listMetricsRequestSchema, listMetricsResponseSchema,
  seriesRequestSchema, seriesResponseSchema,
  summaryRequestSchema, summaryResponseSchema,
} from "~/lib/schemas/metric-read";
import { listMetrics } from "~/lib/metrics/list";
import { getMetricSeries } from "~/lib/metrics/series";
import { getMetricSummary } from "~/lib/metrics/summary";
import { resolveDefinition } from "~/lib/metrics/definitions";
import { ensureMetricSource } from "~/lib/metrics/sources";
import { recordMetricObservations } from "~/lib/metrics/observations";
```

- [ ] **Step 2: Register the four tools**

Match the existing tool registration style in this file. `record_metric` reuses the same logic as `POST /metrics/observations` — extract a shared helper `handleSingleMetricWrite(input)` in `lib/metrics/observations.ts` so the route and the tool both call it (no logic duplication).

- [ ] **Step 3: Refactor the single-write route to call `handleSingleMetricWrite`.**

This is a small refactor of Task 4.2's route — the route becomes a thin wrapper.

- [ ] **Step 4: Run all tests**

Run: `pnpm run test`
Expected: PASS.

### Task 6.3: Phase 6 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test && pnpm run build-sdk`
Expected: clean.

- [ ] **Step 2: Commit**

```bash
git add src/lib/mcp src/lib/metrics src/routes/metrics
git commit -m "✨ feat(metrics): MCP tools for record / list / series / summary"
```

---

## Phase 7: Implicit Extraction Integration

**Goal.** The existing `extract-graph.ts` pipeline returns metrics alongside claims and writes them through `recordMetricObservations`. Event nodes are deduplicated across re-ingestion via the `metricEventKey` mechanism from Task 3.2.

### Task 7.1: Extend extraction zod schema

**Files:**
- Modify: `src/lib/extract-graph.ts`

- [ ] **Step 1: Read current extractor**

Run: `head -200 src/lib/extract-graph.ts`

Identify the LLM response schema (likely a zod object with `claims` etc.).

- [ ] **Step 2: Add `metrics` to the response schema**

```typescript
const extractedMetricSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{1,80}$/),
  label: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  unit: z.string().min(1).max(40),
  aggregationHint: z.enum(["avg", "sum", "min", "max"]),
  value: z.number(),
  note: z.string().max(2000).nullable().optional(),
});

const extractedEventSchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  label: z.string().min(1).max(200),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  observations: z.array(extractedMetricSchema).min(1),
});

const extractedStandaloneSchema = z.object({
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  metric: extractedMetricSchema,
});

// Add to the existing extraction schema:
metrics: z.object({
  events: z.array(extractedEventSchema).default([]),
  standalone: z.array(extractedStandaloneSchema).default([]),
}).optional().default({ events: [], standalone: [] }),
```

- [ ] **Step 3: Update the extraction prompt**

Find the prompt string in `extract-graph.ts`. Append a section:

```text
=== METRICS (optional) ===

If the user mentions numeric quantities they appear to be tracking about
themselves (running pace/distance/HR, sleep duration, body weight,
readiness scores, etc.), extract them into `metrics`. Otherwise return
`{events:[], standalone:[]}`.

For each metric, propose:
  - slug: lowercase snake_case stable identifier (e.g. "running_pace_min_per_km")
  - label: human display name
  - description: one-line meaning, used to dedupe near-duplicate definitions
  - unit: canonical unit (e.g. "min/km", "bpm", "kg", "seconds")
  - aggregationHint: avg | sum | min | max — what makes sense to aggregate over time
  - value: in the canonical unit (convert if the user said "5:30 min/km" → 5.5)
  - note: optional free-text accompanying the reading (e.g. "felt sluggish")

Group readings that belong to one event (a single run, a single sleep) into
`events` with a stable `eventKey` (slug-shaped, unique within this extraction).
Standalone readings with no event grouping go in `standalone`.

DO NOT extract:
  - Categorical values (mood: tired, took meds: yes) — those are claims.
  - Aspirational targets ("I want to run 10k") — those are claims.
  - Numbers about other people or things (only the user's tracking data).
```

- [ ] **Step 4: Wire post-processing**

After claim writing, if `extracted.metrics` has any rows:

```typescript
await recordMetricObservations({
  userId,
  sourceId,
  events: extracted.metrics.events.map((e) => ({
    eventKey: e.eventKey,
    label: e.label,
    occurredAt: e.occurredAt,
    observations: e.observations.map((o) => ({
      metric: { slug: o.slug, label: o.label, description: o.description,
                unit: o.unit, aggregationHint: o.aggregationHint },
      value: o.value,
      note: o.note ?? null,
    })),
  })),
  standalone: extracted.metrics.standalone.map((s) => ({
    metric: { slug: s.metric.slug, label: s.metric.label,
              description: s.metric.description, unit: s.metric.unit,
              aggregationHint: s.metric.aggregationHint },
    value: s.metric.value,
    occurredAt: s.occurredAt,
    note: s.metric.note ?? null,
  })),
});
```

- [ ] **Step 5: Run existing extract-graph tests**

Run: `pnpm run test src/lib/extract-graph.test.ts`
Expected: PASS (existing tests should be unaffected because `metrics` defaults to empty).

### Task 7.2: Eval story

**Files:**
- Create: `src/evals/memory/stories/metrics-extraction.ts`
- Modify: `src/evals/memory/run-all.ts` (or whichever file enumerates stories)

- [ ] **Step 1: Add a story**

Mirror the existing eval-story shape (look at any file in `src/evals/memory/stories/`). The fixture is a journal entry like:

> "Did 5k this morning, pace 5:30/km, avg HR 158. Felt sluggish. Weighed 78.2 after."

Assertions:
- One Event node with label including "morning" or "run".
- Three observations linked to that event (`distance_km`, `pace_min_per_km`, `avg_hr`).
- One standalone observation (`body_weight`) with value 78.2.
- The Event node has a `claim` for `EXHIBITED_EMOTION` linking to a "sluggish" emotion node (this falls out of normal claim extraction; assert it's still present).

- [ ] **Step 2: Run the eval**

Run: `pnpm run eval:memory`
Expected: the new story runs and passes.

### Task 7.3: Re-ingestion idempotency test

**Files:**
- Create: `src/lib/metrics/extraction-idempotency.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("re-ingesting the same source replaces observations and reuses event nodes", async () => {
  // Run the extractor over the same source twice (or call recordMetricObservations
  // twice with the same sourceId + same eventKey).
  // Assert: total observation count for that source is N (not 2N) — i.e. the writer
  // deletes existing observations for the source on re-write.
  // Assert: the event Node id is the same across the two runs (ensureEventNode
  // is idempotent on (sourceId, eventKey)).
});
```

- [ ] **Step 2: Update `recordMetricObservations` to delete-by-source on re-entry**

Before writing, `DELETE FROM metric_observations WHERE source_id = $1`. Same shape as the existing claim re-ingestion behavior. (Confirm with the test.)

- [ ] **Step 3: Run the test**

Expected: PASS.

### Task 7.4: Phase 7 commit

- [ ] **Step 1: Full check**

Run: `pnpm run build:check && pnpm run lint && pnpm run test && pnpm run eval:memory`
Expected: all clean.

- [ ] **Step 2: Commit**

```bash
git add src/lib/extract-graph.ts src/lib/metrics src/evals
git commit -m "✨ feat(metrics): extract observations during conversation/document ingestion"
```

---

## Phase 8: Documentation and Final Polish

**Goal.** Make the subsystem discoverable. Update README integration contract, run a build of the SDK, smoke-test the full surface.

### Task 8.1: README addendum

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a "Metrics" section**

Document: the three ingestion paths (with curl examples), the read endpoints (with example responses), and a note about the schema-dedup behavior with the soft-confirm Task surfacing.

Keep it short — link to the design doc for the full spec.

- [ ] **Step 2: Verify markdown renders cleanly**

Run: `head -100 README.md` and skim for broken formatting.

### Task 8.2: Full system smoke

- [ ] **Step 1: Run all checks together**

Run: `pnpm run build:check && pnpm run lint && pnpm run test && pnpm run build-sdk && pnpm run eval:memory`
Expected: all green.

### Task 8.3: Phase 8 commit

- [ ] **Step 1: Commit**

```bash
git add README.md
git commit -m "📚 docs(metrics): document ingestion paths and read APIs in README"
```

---

## Acceptance Gates (per phase)

| Phase | Gate |
| --- | --- |
| 1 | `migrations-metrics.test.ts` passes; full `pnpm run test` passes; migration applied locally. |
| 2 | All four resolver bands have tests passing; mid-similarity creates a `Task` node visible in `list_open_commitments`. |
| 3 | `recordMetricObservations` test green for both happy path and per-row range error path; event node dedup test green. |
| 4 | `POST /metrics/observations` and `POST /metrics/observations/bulk` integration tests green; SDK build clean. |
| 5 | `list_metrics` / `series` / `summary` tests green for all aggregation modes and bucket sizes. |
| 6 | `tool-descriptions.test.ts` snapshots pinned for all four new tools; MCP tool calls smoke-tested. |
| 7 | Extractor returns metrics for the eval story; re-ingestion test green. |
| 8 | README updated; full check passes; SDK build verified. |

## Open Items Inherited from the Spec

The implementation addresses these design-spec open items:

- **Event-node idempotency**: solved in Task 3.2 via `metricEventKey` on `nodeMetadata.additionalData`. No new column required.
- **Metric merge tooling**: deferred. The Task surfaced by mid-similarity uses existing claim/node operations to resolve.
- **Backfill of historical chat data**: deferred; new extraction is forward-only.
- **TimescaleDB**: not introduced in this plan. Plain Postgres + indexes from Task 1.3 cover v1 expected volume.
