# Commitment Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@marcelsamyn/memory` emit a `presentation { source, excerpt, why }` object on each commitment **list** item — provenance from a free DB join, a **verbatim-or-null** excerpt and a humane _why_ from a small fail-soft LLM pass that runs when a new Task node is created.

**Architecture:** A dedicated `commitment_presentations` table (1:1 with the Task node) stores the excerpt + why. A pure `locateVerbatim()` enforces the honesty rule in code (the model proposes a quote; we only store text that genuinely appears in the source, or null). `generateCommitmentPresentation()` runs inside `extractGraph` for each newly-minted Task node, reusing the in-memory source `content`. The list query LEFT JOINs `sources` (provenance, for **all** commitments) and `commitment_presentations` (excerpt/why, new commitments only) and assembles `presentation`. Petals already maps this shape — no consumer change beyond a version bump.

**Tech Stack:** TypeScript (ESM), Drizzle ORM (Postgres), Zod 4, OpenAI SDK structured outputs (`zodResponseFormat` via `performStructuredAnalysis`), Vitest. Spec: `docs/superpowers/specs/2026-06-14-commitment-presentation-design.md`.

**Conventions:** Tests are co-located `*.test.ts`; run with `pnpm test --run`. Type/lint gates: `pnpm build:check` (`tsc --noEmit` + `check:structured-outputs`), `pnpm lint`, `pnpm format`. Migrations: `pnpm drizzle:generate` → review → `pnpm drizzle:migrate`. Commit style: `<emoji> <type>(<scope>): <subject>` (no AI mentions).

---

### Task 1: `locateVerbatim` — the honesty function (pure, TDD)

**Files:**

- Create: `src/lib/verbatim.ts`
- Test: `src/lib/verbatim.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/verbatim.test.ts
import { locateVerbatim } from "./verbatim";
import { describe, expect, it } from "vitest";

describe("locateVerbatim", () => {
  it("returns the exact source slice for an exact substring", () => {
    const content = "Let's ship the beta on Friday for sure.";
    expect(locateVerbatim(content, "ship the beta on Friday")).toBe(
      "ship the beta on Friday",
    );
  });

  it("is case-sensitive (never normalizes case)", () => {
    expect(locateVerbatim("Ship the beta", "ship the beta")).toBeNull();
  });

  it("tolerates whitespace drift and returns the ORIGINAL characters", () => {
    const content = "I will\n   ship it tomorrow";
    // model collapsed the newline+spaces to a single space:
    expect(locateVerbatim(content, "I will ship it")).toBe(
      "I will\n   ship it",
    );
  });

  it("collapses repeated whitespace inside the candidate too", () => {
    expect(locateVerbatim("a   b", "a b")).toBe("a   b");
  });

  it("returns null when the candidate is absent", () => {
    expect(locateVerbatim("nothing here", "launch the rocket")).toBeNull();
  });

  it("returns null for null / empty / whitespace-only candidates", () => {
    expect(locateVerbatim("anything", null)).toBeNull();
    expect(locateVerbatim("anything", "")).toBeNull();
    expect(locateVerbatim("anything", "   ")).toBeNull();
  });

  it("trims the candidate before searching", () => {
    expect(locateVerbatim("ship the beta", "  ship the beta  ")).toBe(
      "ship the beta",
    );
  });

  it("returns null for an over-long candidate (cap guards runaway spans)", () => {
    const content = "x".repeat(500);
    expect(locateVerbatim(content, "x".repeat(300))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm test --run src/lib/verbatim.test.ts`
Expected: FAIL (`locateVerbatim` is not defined / module not found).

- [ ] **Step 3: Implement `locateVerbatim`**

```ts
// src/lib/verbatim.ts
/**
 * Verbatim-or-null source-quote location.
 *
 * Common aliases: locate quote, verbatim excerpt, honest highlight, substring
 * provenance. The model proposes a quote; we only ever return text that
 * genuinely appears in `content` (the ACTUAL source characters), or null.
 */

/** A card quote is a sentence or two; reject runaway spans. */
const MAX_EXCERPT_CHARS = 240;

/**
 * Locate `candidate` as a verbatim span within `content`, returning the actual
 * source characters for the matched range, or `null` if it is not present.
 *
 * 1. Trim the candidate; reject null / empty / over-long → `null`.
 * 2. Exact substring → return `content.slice(...)` of the hit.
 * 3. Whitespace-tolerant: collapse runs of whitespace in both (LLMs flatten
 *    newlines/indentation), find the candidate, and map the hit back to the
 *    original offsets so the returned text is byte-for-byte from the source.
 * 4. Not found → `null`.
 *
 * Case is never normalized — verbatim means verbatim.
 */
export function locateVerbatim(
  content: string,
  candidate: string | null,
): string | null {
  if (!candidate) return null;
  const needle = candidate.trim();
  if (needle.length === 0 || needle.length > MAX_EXCERPT_CHARS) return null;

  const exact = content.indexOf(needle);
  if (exact !== -1) return content.slice(exact, exact + needle.length);

  const { normalized, map } = collapseWhitespace(content);
  const normNeedle = needle.replace(/\s+/g, " ");
  const at = normalized.indexOf(normNeedle);
  if (at === -1) return null;

  const start = map[at];
  const end = map[at + normNeedle.length - 1];
  if (start === undefined || end === undefined) return null;
  return content.slice(start, end + 1);
}

/**
 * Collapse each run of whitespace to a single space. Returns the normalized
 * string and `map[i]` = the index in the ORIGINAL string of normalized char i.
 */
function collapseWhitespace(s: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        normalized += " ";
        map.push(i);
        inWhitespace = true;
      }
    } else {
      normalized += ch;
      map.push(i);
      inWhitespace = false;
    }
  }
  return { normalized, map };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm test --run src/lib/verbatim.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/verbatim.ts src/lib/verbatim.test.ts
git commit -m "✨ feat(commitments): locateVerbatim — verbatim-or-null quote location"
```

---

### Task 2: `commitment_presentation` model task + env override

**Files:**

- Modify: `src/utils/models.ts`
- Modify: `src/utils/env.ts` (add the optional model-id env var, following the existing `MODEL_ID_*` entries)

- [ ] **Step 1: Add the env var**

In `src/utils/env.ts`, find the block declaring `MODEL_ID_DOCUMENT_SPINE` (and siblings) and add, in the same style (optional string, no default → inherits `MODEL_ID_GRAPH_EXTRACTION` at use site):

```ts
    MODEL_ID_COMMITMENT_PRESENTATION: z.string().optional(),
```

- [ ] **Step 2: Add the task to the union + overrides**

In `src/utils/models.ts`:

```ts
// In the ModelTask union, add:
  | "commitment_presentation"

// In TASK_MODEL_OVERRIDES, add:
  commitment_presentation: env.MODEL_ID_COMMITMENT_PRESENTATION,
```

(No default override → `modelForTask("commitment_presentation")` falls back to `MODEL_ID_GRAPH_EXTRACTION`, the cheap/safe default, until an env override is set.)

- [ ] **Step 3: Type-check**

Run: `pnpm build:check`
Expected: PASS (the new task is referenced nowhere yet; union is exhaustive).

- [ ] **Step 4: Commit**

```bash
git add src/utils/models.ts src/utils/env.ts
git commit -m "✨ feat(commitments): commitment_presentation model task"
```

---

### Task 3: `commitment_presentations` table + migration

**Files:**

- Modify: `src/db/schema.ts`
- Generated: `drizzle/00NN_*.sql`

- [ ] **Step 1: Add the table**

In `src/db/schema.ts`, after the `nodeMetadata` table (mirror its idiom — `typeId` FK with cascade, `text()`/`timestamp(... withTimezone)`), add:

```ts
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
```

Confirm `typeIdNoDefault` and `index` are already imported in `schema.ts` (they are used by existing tables; add to the import if tree-shaken).

- [ ] **Step 2: Generate the migration**

Run: `pnpm drizzle:generate`
Expected: a new `drizzle/00NN_*.sql` creating `commitment_presentations` with the PK, two FKs (cascade), and the user index. **Open the generated SQL and read it** — confirm it only CREATEs the new table + index and touches nothing else.

- [ ] **Step 3: Type-check**

Run: `pnpm build:check`
Expected: PASS.

- [ ] **Step 4: Commit (schema + migration together)**

```bash
git add src/db/schema.ts drizzle/
git commit -m "✨ feat(commitments): commitment_presentations table + migration"
```

(The migration is **applied** in Task 8 after the readers/writers exist, via `pnpm drizzle:migrate`.)

---

### Task 4: Presentation pass + upsert (TDD, mocked LLM) + structured-output gate

**Files:**

- Create: `src/lib/commitment-presentation.ts`
- Test: `src/lib/commitment-presentation.test.ts`
- Modify: `scripts/check-structured-output-schemas.ts`

- [ ] **Step 1: Write the failing tests (mock the LLM helper)**

```ts
// src/lib/commitment-presentation.test.ts
import { generateCommitmentPresentation } from "./commitment-presentation";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai", () => ({ performStructuredAnalysis: vi.fn() }));
const { performStructuredAnalysis } = await import("./ai");
const mockLlm = vi.mocked(performStructuredAnalysis);

const CONTENT = "Sure — I'll send the investor update by Thursday, promise.";

describe("generateCommitmentPresentation", () => {
  beforeEach(() => mockLlm.mockReset());

  it("stores a real quote verbatim and passes the why through", async () => {
    mockLlm.mockResolvedValue({
      excerpt: "send the investor update by Thursday",
      why: "You named a concrete deliverable and deadline.",
    });
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "Send investor update",
    });
    expect(out.excerpt).toBe("send the investor update by Thursday");
    expect(out.why).toBe("You named a concrete deliverable and deadline.");
  });

  it("nulls a hallucinated excerpt that is not in the source", async () => {
    mockLlm.mockResolvedValue({
      excerpt: "I promise to climb Everest next week",
      why: "Ambitious.",
    });
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "Send investor update",
    });
    expect(out.excerpt).toBeNull();
    expect(out.why).toBe("Ambitious.");
  });

  it("caps an over-long why", async () => {
    mockLlm.mockResolvedValue({ excerpt: null, why: "x".repeat(300) });
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "t",
    });
    expect(out.why?.length).toBe(140);
  });

  it("is fail-soft: an LLM error yields a fully-null presentation", async () => {
    mockLlm.mockRejectedValue(new Error("boom"));
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "t",
    });
    expect(out).toEqual({ excerpt: null, why: null });
  });
});
```

- [ ] **Step 2: Run, verify they fail**

Run: `pnpm test --run src/lib/commitment-presentation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

```ts
// src/lib/commitment-presentation.ts
import type { DrizzleDB } from "../db/client";
import { commitmentPresentations } from "../db/schema";
import type { TypeId } from "../types/typeid";
import { performStructuredAnalysis } from "./ai";
import { locateVerbatim } from "./verbatim";
import { z } from "zod";

const WHY_MAX_CHARS = 140;

/** Structured output for the presentation pass (OpenAI-safe: all keys required, nullable not optional). */
export const commitmentPresentationLlmSchema = z
  .object({
    excerpt: z
      .string()
      .nullable()
      .describe(
        "A SHORT exact quote, copied character-for-character from the provided source text, that directly evidences this commitment. If no single span cleanly evidences it, return null. Never paraphrase, summarize, or invent.",
      ),
    why: z
      .string()
      .nullable()
      .describe(
        "One short second-person line (max ~15 words) explaining why this is a commitment, grounded in the source. e.g. 'You set a concrete launch window.' Null if nothing meaningful to add.",
      ),
  })
  .describe("commitment_presentation");

const SYSTEM_PROMPT =
  "You extract honest evidence for a task the assistant inferred from a user's messages. " +
  "The excerpt MUST be an exact, verbatim substring of the provided source — copy it character-for-character, or return null. " +
  "Never fabricate, paraphrase, or stitch together a quote. The 'why' is a single short second-person line grounded in the source.";

/**
 * Produce honest presentation evidence for a freshly-inferred commitment.
 * Fail-soft: any error yields `{ excerpt: null, why: null }` — this MUST NOT
 * throw into ingestion. The excerpt is validated against the real source in
 * code (`locateVerbatim`), so the model cannot fabricate a quote.
 */
export async function generateCommitmentPresentation(args: {
  userId: string;
  content: string;
  taskLabel: string;
}): Promise<{ excerpt: string | null; why: string | null }> {
  try {
    const out = await performStructuredAnalysis({
      userId: args.userId,
      task: "commitment_presentation",
      systemPrompt: SYSTEM_PROMPT,
      prompt: `Task the assistant inferred: "${args.taskLabel}"\n\nSource text:\n"""\n${args.content}\n"""`,
      schema: commitmentPresentationLlmSchema,
    });
    const excerpt = locateVerbatim(args.content, out.excerpt);
    const why = out.why?.trim().slice(0, WHY_MAX_CHARS) || null;
    return { excerpt, why };
  } catch (error) {
    console.warn(`commitment presentation generation failed: ${String(error)}`);
    return { excerpt: null, why: null };
  }
}

/** Upsert presentation evidence for a task (idempotent on re-extraction). */
export async function upsertCommitmentPresentation(
  db: DrizzleDB,
  row: {
    taskId: TypeId<"node">;
    userId: string;
    sourceId: TypeId<"source">;
    excerpt: string | null;
    why: string | null;
  },
): Promise<void> {
  await db
    .insert(commitmentPresentations)
    .values(row)
    .onConflictDoUpdate({
      target: commitmentPresentations.taskId,
      set: { excerpt: row.excerpt, why: row.why, sourceId: row.sourceId },
    });
}
```

> Verify the import paths against the repo: `DrizzleDB` (the type passed as `db` in `extract-graph.ts` — check its export, likely `../db/client` or `../db`), `TypeId` (`../types/typeid`). Match what `extract-graph.ts` already imports.

- [ ] **Step 4: Register the schema in the structured-output gate**

In `scripts/check-structured-output-schemas.ts`, import the schema and add an array entry:

```ts
import { commitmentPresentationLlmSchema } from "../src/lib/commitment-presentation";
// ...
  {
    name: "commitment_presentation",
    schema: zodResponseFormat(
      commitmentPresentationLlmSchema,
      "commitment_presentation",
    ).json_schema.schema,
  },
```

- [ ] **Step 5: Run tests + the structured-output gate**

Run: `pnpm test --run src/lib/commitment-presentation.test.ts && pnpm run check:structured-outputs`
Expected: tests PASS (4); the gate prints "Validated 3 structured-output JSON schema." with no validation error (confirms the schema is OpenAI-structured-output-legal).

- [ ] **Step 6: Commit**

```bash
git add src/lib/commitment-presentation.ts src/lib/commitment-presentation.test.ts scripts/check-structured-output-schemas.ts
git commit -m "✨ feat(commitments): presentation pass (verbatim excerpt + why), fail-soft"
```

---

### Task 5: Hook the pass into extraction

**Files:**

- Modify: `src/lib/extract-graph.ts`

- [ ] **Step 1: Add the call after embeddings are generated**

In `extractGraph`, immediately after the embeddings `Promise.all([...])` (the block ending around line 536, where `generateAndInsertNodeEmbeddings` runs), insert — `content`, `userId`, `sourceId`, `db`, and `detailsOfNewlyCreatedNodes` are all in scope here:

```ts
// Honest presentation evidence for each freshly-inferred commitment, using
// the source text we still hold in memory. Best-effort: never let it break
// ingestion (the pass is itself fail-soft; we also guard the upsert).
const newTaskNodes = detailsOfNewlyCreatedNodes.filter(
  (node) => node.nodeType === "Task",
);
for (const task of newTaskNodes) {
  try {
    const { excerpt, why } = await generateCommitmentPresentation({
      userId,
      content,
      taskLabel: task.label,
    });
    if (excerpt !== null || why !== null) {
      await upsertCommitmentPresentation(db, {
        taskId: task.id,
        userId,
        sourceId,
        excerpt,
        why,
      });
    }
  } catch (error) {
    console.warn(
      `commitment presentation upsert failed for ${task.id}: ${String(error)}`,
    );
  }
}
```

Add the import at the top of `extract-graph.ts`:

```ts
import {
  generateCommitmentPresentation,
  upsertCommitmentPresentation,
} from "./commitment-presentation";
```

> Confirm `task.label` is non-null on `ProcessedNode` (the recon shows `label: llmNode.label` is set on every pushed entry). If the type is `string | undefined`, pass `task.label ?? ""` and let the pass handle it.

- [ ] **Step 2: Type-check**

Run: `pnpm build:check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/extract-graph.ts
git commit -m "✨ feat(commitments): generate presentation for new task nodes in extraction"
```

---

### Task 6: SDK list schema — the `presentation` field

**Files:**

- Modify: `src/lib/schemas/list-commitments.ts`

- [ ] **Step 1: Add the presentation sub-schemas + field**

In `src/lib/schemas/list-commitments.ts`, before `commitmentListItemSchema`, add:

```ts
export const presentationSourceSchema = z.object({
  sourceId: typeIdSchema("source"),
  title: z.string().nullable(),
  overheardAt: z.coerce.date().nullable(),
});

export const commitmentPresentationSchema = z.object({
  source: presentationSourceSchema.nullable(),
  excerpt: z.string().nullable(),
  why: z.string().nullable(),
});
export type CommitmentPresentation = z.infer<
  typeof commitmentPresentationSchema
>;
```

Then add the field to `commitmentListItemSchema` (after `sourceId`):

```ts
  sourceId: typeIdSchema("source"),
  /** Inline evidence for the inbox card. Null when no source resolves. */
  presentation: commitmentPresentationSchema.nullable(),
```

- [ ] **Step 2: Type-check (expected to fail at the query)**

Run: `pnpm build:check`
Expected: FAIL in `src/lib/query/commitments-list.ts` — the mapper now omits the required `presentation`. Task 7 fixes it. (If you prefer a green build per task, do Tasks 6 + 7 as one commit.)

- [ ] **Step 3: (defer commit — fold into Task 7 so the build stays green)**

---

### Task 7: List query — assemble `presentation`

**Files:**

- Modify: `src/lib/query/commitments-list.ts`
- Modify: `src/lib/sources-read.ts` (export `deriveTitle`)

- [ ] **Step 1: Export `deriveTitle`**

In `src/lib/sources-read.ts`, change `function deriveTitle(` → `export function deriveTitle(`.

- [ ] **Step 2: Add the joins + selected columns**

In `src/lib/query/commitments-list.ts`, import the table, `sources`, and `deriveTitle`:

```ts
import { commitmentPresentations, sources } from "../../db/schema";
import { deriveTitle } from "../sources-read";
```

Add to the `.select({...})` (alongside `sourceId: claims.sourceId`):

```ts
    sourceMetadata: sources.metadata,
    sourceCreatedAt: sources.createdAt,
    sourceLastIngestedAt: sources.lastIngestedAt,
    presentationExcerpt: commitmentPresentations.excerpt,
    presentationWhy: commitmentPresentations.why,
```

Add two LEFT JOINs (place after the existing joins, before `.where(...)`):

```ts
    .leftJoin(sources, eq(sources.id, claims.sourceId))
    .leftJoin(
      commitmentPresentations,
      eq(commitmentPresentations.taskId, nodes.id),
    )
```

- [ ] **Step 3: Assemble `presentation` in the row mapping**

Add a small builder near the mapping loop:

```ts
function buildPresentation(row: {
  sourceId: TypeId<"source">;
  sourceMetadata: unknown;
  sourceCreatedAt: Date | null;
  sourceLastIngestedAt: Date | null;
  presentationExcerpt: string | null;
  presentationWhy: string | null;
}): CommitmentPresentation {
  const source =
    row.sourceCreatedAt === null
      ? null
      : {
          sourceId: row.sourceId,
          title: deriveTitle(row.sourceMetadata),
          overheardAt: row.sourceLastIngestedAt ?? row.sourceCreatedAt,
        };
  return {
    source,
    excerpt: row.presentationExcerpt,
    why: row.presentationWhy,
  };
}
```

Import the `CommitmentPresentation` type and `TypeId`, then add to the `commitments.push({...})` object:

```ts
    sourceId: row.sourceId,
    presentation: buildPresentation(row),
```

> `claims.sourceId` is NOT NULL, so the `sources` LEFT JOIN resolves for every live commitment — provenance shows on **all** cards. `source` is null only if the source row was deleted.

- [ ] **Step 4: Build + run the commitments tests**

Run: `pnpm build:check && pnpm test --run src/lib/query`
Expected: PASS. (If no query test exists, `build:check` green is the gate; a focused round-trip test is optional but welcome — see Task 8.)

- [ ] **Step 5: Commit (Tasks 6 + 7 together)**

```bash
git add src/lib/schemas/list-commitments.ts src/lib/query/commitments-list.ts src/lib/sources-read.ts
git commit -m "✨ feat(commitments): presentation on the list response (provenance + excerpt + why)"
```

---

### Task 8: Full verification, migration, version bump

**Files:**

- Modify: `package.json` (version)

- [ ] **Step 1: Apply the migration**

Run: `pnpm drizzle:migrate`
Expected: applies `00NN_*.sql`; `commitment_presentations` now exists. (If the dev DB is push-managed and `migrate` errors, STOP and report — do not silently `push`; confirm the dev flow.)

- [ ] **Step 2: Full gate sweep**

Run, in order, and confirm each is green:

```bash
pnpm build:check
pnpm lint
pnpm format        # prettier --check . ; use format:fix if needed
pnpm test --run
```

- [ ] **Step 3: Optional — list-query round-trip test**

If an existing test harness for `listCommitments` exists (DB-backed), add a case asserting: a commitment with a `commitment_presentations` row returns populated `excerpt`/`why`; a commitment without one still returns non-null `presentation.source` (provenance) and null excerpt/why; the result parses through `listCommitmentsResponseSchema`. Model it on `src/digest-route.test.ts` (schema `.parse` round-trip).

- [ ] **Step 4: Version bump**

Bump `package.json` `version` `1.23.0` → `1.24.0` (additive minor).

```bash
git add package.json
git commit -m "🔧 chore(release): 1.24.0 — commitment presentation"
```

- [ ] **Step 5: STOP — do not publish or open the PR without Marcel's OK**

Report completion + green gates. Publishing `@marcelsamyn/memory@1.24.0` and the downstream **Petals** wiring (it consumes the **published** package — bump its dep so `CommitmentListItem.presentation` flows; the proxy + Petals `commitments-map.ts` already map it) are a separate, explicitly-authorized step. The n8n node is write-only and unaffected.

---

## Out of scope (per spec)

Backfill of existing commitments' excerpt/why; presentation on `getCommitment` (detail); regeneration/refresh; case-insensitive excerpt matching; any non-verbatim excerpt.
