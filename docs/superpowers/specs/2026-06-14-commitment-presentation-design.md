# Commitment Presentation — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design); ready for implementation plan
**Repo:** `assistant-memory` (`@marcelsamyn/memory`)
**Consumer:** Petals — the "caught-promise" candidate card (already shipped, degraded)

---

## Problem & goal

Petals' Inbox renders each AI-inferred candidate commitment as a **caught-promise card**:
provenance ("overheard · 2d ago · <source>"), a **verbatim** quote that evidences the
commitment, and a humane one-line _why_. That card already ships — but the fields are
always `null` because this repo doesn't produce them yet. The card degrades cleanly and
waits.

**Goal:** Make `@marcelsamyn/memory` emit a `presentation { source, excerpt, why }` object
on each commitment **list** item, so the card lights up — **honestly**: the excerpt is a
verbatim substring of real source text or it is `null`; it is never fabricated or
paraphrased.

## The boundary (locked — do not renegotiate)

Petals already consumes and maps this shape (`src/server/commitments-map.ts` → `toPresentationDTO`),
normalizing `Date`→ISO string and `undefined`→`null`. We MUST match it so the consumer
needs **zero** code change beyond a version bump:

```ts
// What Petals expects on each commitment list item (its own DTO):
presentation: {
  source: { sourceId: string; title: string | null; overheardAt: string /*ISO*/ | null } | null;
  excerpt: string | null; // verbatim-or-null
  why: string | null;     // generated, product voice
} | null;
```

`due` and `owner` are **not** part of presentation — Petals already derives those from the
existing `dueOn` / `owner` fields. Presentation is exactly `{ source, excerpt, why }`.

## Decisions (settled in brainstorming)

1. **New commitments only** — no backfill of the LLM-derived excerpt/why for historical
   commitments. The Inbox fills in as fresh commitments flow through ingestion.
2. **All three fields in v1** — provenance + excerpt + why.
3. **Dedicated, isolated LLM pass** — a small structured call that runs only when a new
   `Task` node is created. It does **not** touch the load-bearing `graph_extraction` call
   or its schema/prompt.
4. **Provenance for _all_ commitments** — `source` is a free DB join on the `sourceId` the
   commitment already carries, so every card (old and new) gets the tappable
   "overheard · …" line immediately. Only the LLM-derived `excerpt`/`why` are new-only.
5. **Dedicated `commitment_presentations` table** (1:1 with the Task node) — decouples the
   evidence from claim **supersession** (a task's status claim flips pending→done over its
   life; the evidence must not ride a claim that gets superseded) and gives a clean seam if
   presentation grows later (e.g. detail view, regeneration).
6. **Surface: the list response only** — Petals only wired presentation into
   `toListItemDTO`, not the detail view. YAGNI on `getCommitment` for now.

## Architecture overview

Two independent paths, joined by a small table:

- **Write path (ingestion):** when extraction creates a new `Task` node, a fail-soft
  presentation pass runs over the **in-memory** source `content` (no blob re-fetch — the raw
  text is right there at extraction time, and is otherwise discarded), validates the
  excerpt verbatim in code, and upserts a `commitment_presentations` row.
- **Read path (list query):** `listCommitments` LEFT JOINs `commitment_presentations` (for
  excerpt/why) and `sources` (for provenance title + timestamp), assembling the
  `presentation` object. Provenance is present for every commitment with a resolvable
  source; excerpt/why are present only when a row exists.

## Components & data flow

### 1. Provenance — free, no LLM

The commitment already carries `sourceId` (surfaced today on `commitmentListItemSchema`).
In the list query, LEFT JOIN `sources` and build:

```ts
source: {
  sourceId,                          // existing
  title: deriveTitle(source),        // sources-read.ts — metadata.title fallback chain
  overheardAt: source.createdAt,     // (or lastIngestedAt — pick the "overheard" moment; see open items)
}
```

Present for **all** commitments. If no source resolves, `source` is `null`.

> Consumer interaction note: on the Petals card, a non-null `source` makes
> `hasInlineEvidence` true, which replaces the old lazy "from your chat…" peek with the
> tappable provenance line (same destination — the source — fewer clicks). This is the
> intended upgrade for existing cards.

### 2. The honesty mechanism — `locateVerbatim` (pure, TDD'd)

The crux. The model's proposed excerpt is **never trusted or stored directly**. A pure
function locates it in the real `content` and returns the **actual source characters**, or
`null`.

```ts
/**
 * Locate `candidate` as a verbatim span within `content`, returning the ACTUAL
 * source characters (never the model's reproduction), or null if absent.
 * 1. trim candidate; reject null/empty or over-long (length cap) → null
 * 2. exact substring → return content.slice(hit, hit + len)
 * 3. else whitespace-collapsed search: find the normalized candidate in normalized
 *    content, map the hit back to original offsets, return the original slice
 * 4. not found → null
 */
export function locateVerbatim(
  content: string,
  candidate: string | null,
): string | null;
```

- The whitespace-tolerant step exists because LLMs reproduce quotes with minor whitespace
  drift (newlines collapsed to spaces, etc.). We still store the **source's** exact
  characters for the matched range, so the result is genuinely verbatim.
- **Length cap** (≈240 chars): a card quote is a sentence or two; reject runaway spans → `null`.
- This function is the single chokepoint for the honesty rule and gets the most rigorous
  unit tests.

### 3. The presentation pass — `generateCommitmentPresentation`

```ts
// src/lib/commitment-presentation.ts (new)
const presentationLlmSchema = z.object({
  excerpt: z.string().nullable(), // model's candidate quote (validated downstream)
  why: z.string().nullable(), // one-line, product voice, grounded
});

export async function generateCommitmentPresentation(args: {
  content: string; // raw source text, in hand at extraction
  taskLabel: string; // the commitment's label/statement
  userId: string;
}): Promise<{ excerpt: string | null; why: string | null }>;
```

- Uses the existing `parseStructuredCompletion` + `zodResponseFormat(presentationLlmSchema, "presentation")`
  infra (`src/lib/ai.ts`), model `modelForTask("commitment_presentation")`.
- After the call: `excerpt = locateVerbatim(content, llmOut.excerpt)`; `why` is trimmed and
  length-capped (≈140 chars) and passed through (generated prose is **not** verbatim-bound,
  but the prompt forbids asserting facts beyond the source).
- **Fail-soft:** the whole body is wrapped so that any error (LLM failure, parse, timeout)
  returns `{ excerpt: null, why: null }` and logs — it MUST NOT throw into ingestion. A
  degraded commitment is acceptable; a broken ingestion is not.

**Prompt shape (sketch — finalized in plan):** system sets the honesty rule (quote must be
an exact span of the provided text; if nothing cleanly evidences the commitment, return
`null` excerpt) and the _why_ voice (second person, ≤~15 words, grounded, e.g. "You set a
concrete launch window."). User message carries the task label + the source content.

### 4. Persistence — `commitment_presentations`

```ts
// src/db/schema.ts (new table)
export const commitmentPresentations = pgTable("commitment_presentations", {
  taskId: typeIdNoDefault("node")
    .primaryKey()
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }), // 1:1 with the Task node
  userId: text()
    .references(() => users.id)
    .notNull(), // isolation, consistent with claims/sources
  sourceId: typeIdNoDefault("source")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }), // the source the excerpt was quoted from
  excerpt: text(), // verbatim-or-null
  why: text(), // generated-or-null
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
```

- Upsert (`onConflictDoUpdate` on `taskId`) so a re-extraction of the same task is
  idempotent.
- Drizzle migration generated via the repo's standard flow (see open items for the exact
  generate + apply commands).

### 5. SDK surface — extend the list item

```ts
// src/lib/schemas/list-commitments.ts
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
// commitmentListItemSchema gains:
//   presentation: commitmentPresentationSchema.nullable(),
```

The `listCommitments` query (and its read model) assembles `presentation` from the two LEFT
JOINs. `presentation` is `null` only when there is no resolvable source.

### 6. Model routing

Add `commitment_presentation` to the `ModelTask` union in `src/utils/models.ts`, env-override
`MODEL_ID_COMMITMENT_PRESENTATION`, defaulting to a **cheap/fast** model (it's a
single-span selection + one-liner — follow the existing cheap-default convention).

## Failure handling

- Presentation generation is **best-effort and fail-soft** at every layer. Ingestion never
  blocks on it; errors log and yield a degraded (null) presentation.
- A model-proposed excerpt that fails `locateVerbatim` → `null` (honesty preserved), not an
  error.
- The read path tolerates missing presentation rows (LEFT JOIN) and missing sources
  (`source: null`).

## Out of scope (YAGNI)

- Backfilling excerpt/why for pre-existing commitments.
- Presentation on the commitment **detail** (`getCommitment`) response.
- Regeneration / refresh / editing of presentation after creation.
- Sub-span highlighting or multiple excerpts — one verbatim string per commitment.
- Any fuzzy/paraphrased excerpt — verbatim-or-null only.

## Testing strategy

- **`locateVerbatim` (pure, TDD — highest rigor):** exact match; whitespace-variant match
  returning real chars; absent → `null`; `null`/empty candidate → `null`; over-cap candidate
  → `null`; leading/trailing-whitespace candidate.
- **`generateCommitmentPresentation` (mocked LLM):** real quote → stored verbatim;
  hallucinated quote (not in `content`) → `excerpt: null`; over-long `why` trimmed/capped;
  LLM throws → `{ excerpt: null, why: null }` (fail-soft, no throw).
- **SDK schema:** `commitmentPresentationSchema` parses populated and fully-null shapes;
  `presentation` is nullable on the list item.
- **List query (integration, test DB):** provenance present for a commitment with a source;
  excerpt/why present when a row exists; `presentation: null` when no source resolves;
  old-style commitment (no row) still returns provenance.

## Cross-repo coordination (flagged — no publish without explicit OK)

- Additive change → SDK **minor** bump `1.23.0` → `1.24.0`.
- Verify how Petals consumes `@marcelsamyn/memory` (published package vs. workspace link).
  If published: publish the new version + bump Petals' dependency. If linked: rebuild.
- Petals' mapper already handles `presentation`, so **no Petals code change** is needed
  beyond the version bump.
- Publishing / Petals PR happen only on Marcel's explicit go-ahead.

## Open items to verify at plan time

> Recon was performed on the (stale) local `main` (`e76ee9c`); this branch is off fresh
> `origin/main` (`c2fe8c7`). Re-pull exact current code (file:line) when writing the plan.

1. **Task-node creation site** in the extraction flow — exactly where new `Task` nodes (and
   their initial `assistant_inferred` status claim) are persisted, and confirm `content` is
   still in scope there to feed the pass.
2. **`listCommitments` query** — the exact file + how `sourceId` is currently derived, so the
   two LEFT JOINs slot in correctly.
3. **`typeId` helper variants** — confirm `typeIdNoDefault` (vs `typeId`) for the new table's
   PK/FK columns, and the `nodes` / `sources` / `users` table references.
4. **Cheap-model default convention** in `src/utils/models.ts`.
5. **Drizzle migration commands** — generate + apply (the repo may use `migrate`, not
   `push`, in dev — confirm before applying).
6. **Petals dependency mechanism** (published vs workspace) — for the cross-repo step.
7. **Structured-output schema gate** — `build:check` runs `check:structured-outputs`
   (`scripts/check-structured-output-schemas.ts`). Confirm whether the new
   `presentationLlmSchema` must be registered/discoverable there, and that it satisfies the
   OpenAI structured-output constraints (all keys required, `.nullable()` not `.optional()`,
   no defaults).

```

```
