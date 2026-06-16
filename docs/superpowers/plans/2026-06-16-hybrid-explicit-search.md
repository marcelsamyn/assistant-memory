# Hybrid Explicit Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated hybrid (lexical + vector) explicit-search endpoint `POST /search` to the memory service, returning ranked hits with highlights, with entity-type and time-range facets.

**Architecture:** A new Postgres lexical layer (`tsvector` + GIN for keyword/phrase, `pg_trgm` for fuzzy/prefix) runs alongside the existing pgvector HNSW semantic layer. The two rankings are fused with Reciprocal Rank Fusion (RRF). Background context injection (`/context/search`) and graph visualization (`/query/search`) are untouched — hybrid lives only on the new explicit-search surface.

**Tech Stack:** TypeScript, Nitro (file-based routes), Drizzle ORM, PostgreSQL (pgvector + pg_trgm), Zod, Vitest. Test DB on `:5431` (CI runs lint/format/build only — run vitest locally).

**Spec:** `docs/superpowers/specs/2026-06-16-hybrid-explicit-search-design.md`

---

## File Structure

**Memory repo (this plan):**
- `src/db/schema.ts` — MODIFY: add a `tsvector` customType, generated `search_tsv` columns on `claims` + `node_metadata`, GIN (tsvector) + GIN (trgm) indexes.
- `drizzle/0024_hybrid_search_indexes.sql` — CREATE: migration (generated + extension prepended).
- `src/lib/search/fusion.ts` — CREATE: pure RRF.
- `src/lib/search/fusion.test.ts` — CREATE.
- `src/lib/graph.ts` — MODIFY: export `generateTextEmbedding`; add `includeNodeTypes` + `statedBetween` filters; add `findNodesByLexical` / `findClaimsByLexical`.
- `src/lib/search/lexical.test.ts` — CREATE: lexical retrieval tests (real DB).
- `src/lib/search/explicit-search.ts` — CREATE: the hybrid pipeline + `SearchHit` hydration.
- `src/lib/search/explicit-search.test.ts` — CREATE.
- `src/lib/search/test-db.ts` — CREATE: shared migrated-test-DB helper (NOT a `.test.ts`, safe to export from).
- `src/lib/schemas/search.ts` — CREATE: request/response + `SearchHit` schemas.
- `src/routes/search.post.ts` — CREATE: the endpoint.
- `src/search-route.test.ts` — CREATE: handler-level test.
- `src/sdk/memory-client.ts` — MODIFY: add `search()` method.

**Deferred to a follow-on plan (cross-repo, own worktree):** Petals explorer migration, `n8n-nodes-petals` operation, Petals proxy endpoint, and the optional assistant MCP `search_text` tool. Out of scope here so this plan ships working, testable software on its own.

---

## Task 1: Fusion (pure RRF)

Start with the pure function — no DB, no network.

**Files:**
- Create: `src/lib/search/fusion.ts`
- Test: `src/lib/search/fusion.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/search/fusion.test.ts
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, RRF_K } from "./fusion";

describe("reciprocalRankFusion", () => {
  it("sums 1/(k+rank) across rankings and sorts descending", () => {
    // id "a": rank 0 in list1, rank 1 in list2
    // id "b": rank 1 in list1, rank 0 in list2
    // both symmetric -> equal scores; tie broken by id ascending
    const fused = reciprocalRankFusion([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    const expectedScore = 1 / (RRF_K + 0) + 1 / (RRF_K + 1);
    expect(fused[0]!.score).toBeCloseTo(expectedScore, 10);
  });

  it("ranks an id appearing high in both lists above a single-list id", () => {
    const fused = reciprocalRankFusion([
      ["x", "y", "z"],
      ["x", "w"],
    ]);
    expect(fused[0]!.id).toBe("x");
  });

  it("handles empty rankings", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("deduplicates ids within a single ranking by best (first) rank", () => {
    const fused = reciprocalRankFusion([["a", "a", "b"]]);
    const a = fused.find((f) => f.id === "a")!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 0), 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/search/fusion.test.ts`
Expected: FAIL — cannot find module `./fusion`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/search/fusion.ts
/**
 * Reciprocal Rank Fusion (RRF) — merges several independent rankings of the
 * same id space into one ranking without normalising heterogeneous scores.
 * Each id scores Σ 1/(k + rank) over the lists it appears in.
 *
 * Common aliases: rrf, rank fusion, hybrid search fusion, mergeRankings.
 */

/** Standard RRF constant; dampens the contribution of low ranks. */
export const RRF_K = 60;

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * @param rankings Ordered id lists (index 0 = best). An id repeated within a
 *   single list contributes only its first (best) rank.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = RRF_K,
): FusedResult[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, rank) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/search/fusion.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/fusion.ts src/lib/search/fusion.test.ts
git commit -m "✨ feat(search): reciprocal rank fusion helper"
```

---

## Task 2: Migration — tsvector + pg_trgm indexes

Declare the lexical indexes in the schema, generate the migration, and prepend the extension.

**Files:**
- Modify: `src/db/schema.ts` (imports; `claims` and `nodeMetadata` table bodies)
- Create: `drizzle/0024_hybrid_search_indexes.sql`

- [ ] **Step 1: Add the `tsvector` customType and `sql` usage to schema imports**

In `src/db/schema.ts`, the top import from `drizzle-orm/pg-core` already includes `index`, `text`, etc. Add `customType` to that import list. `sql` is already imported from `drizzle-orm`. After the imports block (before the first `pgTable`), add:

```typescript
/**
 * Postgres `tsvector` column type for full-text search. Drizzle has no native
 * tsvector type; this customType lets us declare GENERATED ALWAYS AS (...)
 * STORED columns and GIN-index them.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
```

- [ ] **Step 2: Add the generated column + indexes to `node_metadata`**

In the `nodeMetadata` table, add a column after `description`:

```typescript
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(label, '') || ' ' || coalesce(description, ''))`,
    ),
```

And in its index array (after `node_metadata_canonical_label_idx`), add:

```typescript
    index("node_metadata_search_tsv_idx").using("gin", table.searchTsv),
    index("node_metadata_label_trgm_idx").using(
      "gin",
      table.label.op("gin_trgm_ops"),
    ),
```

- [ ] **Step 3: Add the generated column + indexes to `claims`**

In the `claims` table, add a column after `description` (the existing `description: text(),` line):

```typescript
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(statement, '') || ' ' || coalesce(description, ''))`,
    ),
```

And in its index array (after `claims_source_id_idx`), add:

```typescript
    index("claims_search_tsv_idx").using("gin", table.searchTsv),
    index("claims_statement_trgm_idx").using(
      "gin",
      table.statement.op("gin_trgm_ops"),
    ),
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm drizzle:generate --name hybrid_search_indexes`
Expected: creates `drizzle/0024_hybrid_search_indexes.sql` and adds an entry to `drizzle/meta/_journal.json`. The SQL should contain `ADD COLUMN "search_tsv" ... GENERATED ALWAYS AS (...) STORED` for both tables and four `CREATE INDEX ... USING gin (...)` statements.

- [ ] **Step 5: Prepend the extension to the generated migration**

`drizzle-kit` does not emit `CREATE EXTENSION` (the same was true for `vector` in `0000`). Open `drizzle/0024_hybrid_search_indexes.sql` and add as the very first line:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
```

If the generator did **not** emit the generated columns/indexes correctly, replace the file body with this exact target SQL (after the extension line above):

```sql
ALTER TABLE "node_metadata" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(label, '') || ' ' || coalesce(description, ''))) STORED;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(statement, '') || ' ' || coalesce(description, ''))) STORED;--> statement-breakpoint
CREATE INDEX "node_metadata_search_tsv_idx" ON "node_metadata" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "node_metadata_label_trgm_idx" ON "node_metadata" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "claims_search_tsv_idx" ON "claims" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "claims_statement_trgm_idx" ON "claims" USING gin ("statement" gin_trgm_ops);
```

- [ ] **Step 6: Verify the migration applies and builds**

Run: `pnpm run build:check`
Expected: PASS (tsc clean — confirms the schema typechecks with the new columns).

Then sanity-apply against a throwaway DB:

Run:
```bash
psql "postgres://postgres:postgres@localhost:5431/postgres" -c 'CREATE DATABASE mig_smoke_0024;'
RUN_MIGRATIONS=true DATABASE_URL="postgres://postgres:postgres@localhost:5431/mig_smoke_0024" pnpm tsx -e "import('./src/utils/db').then(m=>m.useDatabase()).then(()=>{console.log('migrated ok');process.exit(0)})"
psql "postgres://postgres:postgres@localhost:5431/postgres" -c 'DROP DATABASE mig_smoke_0024;'
```
Expected: prints `migrated ok` with no error.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/0024_hybrid_search_indexes.sql drizzle/meta
git commit -m "✨ feat(search): tsvector + pg_trgm indexes for hybrid search"
```

---

## Task 3: Shared migrated-test-DB helper

A reusable helper that creates a fresh DB, runs all migrations (so `search_tsv` + `pg_trgm` exist), and wires it into `useDatabase()` via the existing `setTestDatabase` seam.

**Files:**
- Create: `src/lib/search/test-db.ts`

- [ ] **Step 1: Write the helper**

```typescript
// src/lib/search/test-db.ts
/**
 * Test-only helper: provision a fresh Postgres database, run all Drizzle
 * migrations against it (so generated tsvector columns and pg_trgm indexes
 * exist exactly as in production), and register it as the global db handle.
 *
 * Common aliases: createMigratedTestDb, search test database, hybrid search
 * test setup.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "~/db/schema";
import { setTestDatabase } from "~/utils/db";
import type { DrizzleDB } from "~/db";

const HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const USER = process.env["TEST_PG_USER"] ?? "postgres";
const PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

export const adminDsn = (): string =>
  `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${ADMIN_DB}`;
const dsnFor = (db: string): string =>
  `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${db}`;

export interface MigratedTestDb {
  db: DrizzleDB;
  client: pg.Client;
  drop: () => Promise<void>;
}

export async function isServerReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function createMigratedTestDb(
  dbName: string,
): Promise<MigratedTestDb> {
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const client = new pg.Client({ connectionString: dsnFor(dbName) });
  await client.connect();
  const db = drizzle(client, {
    schema,
    casing: "snake_case",
  }) as unknown as DrizzleDB;
  await migrate(db, { migrationsFolder: "./drizzle" });
  setTestDatabase(db);

  const drop = async (): Promise<void> => {
    setTestDatabase(null);
    await client.end();
    const a = new pg.Client({ connectionString: adminDsn() });
    await a.connect();
    await a.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await a.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await a.end();
  };

  return { db, client, drop };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/search/test-db.ts
git commit -m "✅ test(search): migrated test-db helper"
```

---

## Task 4: Lexical retrieval functions

Add lexical node/claim retrieval to `graph.ts`, plus the two new filters the facets need (`includeNodeTypes`, `statedBetween`). Export `generateTextEmbedding` for the pipeline.

**Files:**
- Modify: `src/lib/graph.ts`
- Test: `src/lib/search/lexical.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/search/lexical.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDb, isServerReachable } from "./test-db";
import { findClaimsByLexical, findNodesByLexical } from "~/lib/graph";
import { nodes, nodeMetadata, claims, sources, users } from "~/db/schema";
import { newTypeId } from "~/types/typeid";
import type { MigratedTestDb } from "./test-db";

const SERVER = await isServerReachable();
const d = SERVER ? describe : describe.skip;

d("lexical retrieval", () => {
  let h: MigratedTestDb;
  const userId = "user_lex";

  beforeAll(async () => {
    h = await createMigratedTestDb(
      `memory_lex_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    );
    const { db } = h;
    await db.insert(users).values({ id: userId });

    // Source for personal claims.
    const srcId = newTypeId("src");
    await db.insert(sources).values({
      id: srcId,
      userId,
      type: "manual",
      externalId: "ext_lex_1",
      scope: "personal",
    });

    // Node "Boox Note Air" (personal via a claim referencing it).
    const booxId = newTypeId("node");
    await db.insert(nodes).values({
      id: booxId,
      userId,
      nodeType: "Object",
    });
    await db.insert(nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId: booxId,
      label: "Boox Note Air 4C",
      canonicalLabel: "boox note air 4c",
      description: "e-ink tablet",
    });

    // A claim mentioning Boox, stated 2026-05-10.
    await db.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: booxId,
      objectValue: "syncs handwriting to Drive",
      predicate: "HAS_ATTRIBUTE",
      statement: "The Boox Note Air syncs handwriting to Google Drive",
      sourceId: srcId,
      scope: "personal",
      assertedByKind: "user",
      statedAt: new Date("2026-05-10T00:00:00Z"),
      status: "active",
    });
  });

  afterAll(async () => {
    await h.drop();
  });

  it("matches an exact keyword and returns a highlight", async () => {
    const rows = await findClaimsByLexical({ userId, query: "Boox", limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.statement).toContain("Boox");
    expect(rows[0]!.highlight).toMatch(/<mark>|Boox/);
  });

  it("matches a node label via trigram despite a typo", async () => {
    const rows = await findNodesByLexical({ userId, query: "Boux", limit: 10 });
    expect(rows.some((r) => r.label === "Boox Note Air 4C")).toBe(true);
  });

  it("filters claims by stated_at range", async () => {
    const inRange = await findClaimsByLexical({
      userId,
      query: "Boox",
      statedBetween: { from: new Date("2026-05-01Z"), to: new Date("2026-05-31Z") },
    });
    expect(inRange.length).toBeGreaterThan(0);
    const outOfRange = await findClaimsByLexical({
      userId,
      query: "Boox",
      statedBetween: { from: new Date("2026-01-01Z"), to: new Date("2026-02-01Z") },
    });
    expect(outOfRange.length).toBe(0);
  });

  it("does not return reference claims for a personal query", async () => {
    const rows = await findClaimsByLexical({ userId, query: "Boox" });
    expect(rows.every((r) => r.scope === "personal")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/search/lexical.test.ts`
Expected: FAIL — `findClaimsByLexical` / `findNodesByLexical` are not exported.

- [ ] **Step 3: Add new option fields and lexical result types to `graph.ts`**

In `src/lib/graph.ts`, extend the option types:

`Scope` is already imported in `graph.ts` (`type Scope` from `~/types/graph`).
Change the two option aliases to add `includeNodeTypes`, `statedBetween`, and an
explicit single-`scope` filter. **Why `scope` and not `includeReference`:** the
existing `includeReference` boolean means "personal OR both" — it cannot express
"reference only", so using it for `scope: "reference"` would blend scopes. When
`scope` is provided it restricts to exactly that scope and takes precedence.

```typescript
export type FindSimilarNodesOptions = SimilaritySearchBase & {
  excludeNodeTypes?: NodeType[];
  /** When set, restrict to these node types (takes precedence over exclude). */
  includeNodeTypes?: NodeType[];
  includeReference?: boolean;
  /** When set, restrict to exactly this scope (takes precedence over includeReference). */
  scope?: Scope;
};

export type FindSimilarClaimsOptions = SimilaritySearchBase & {
  statuses?: ClaimStatus[];
  asOf?: Date;
  /** Restrict to claims whose stated_at falls in this (inclusive) range. */
  statedBetween?: { from?: Date; to?: Date };
  includeReference?: boolean;
  /** When set, restrict to exactly this scope (takes precedence over includeReference). */
  scope?: Scope;
  includeAssistantInferred?: boolean;
};
```

Add lexical-specific param + result types near the other result interfaces:

```typescript
export interface LexicalSearchParams {
  userId: string;
  query: string;
  limit?: number;
  /** Single scope to restrict to. Defaults to "personal"; never blends. */
  scope?: Scope;
}

export interface NodeLexicalParams extends LexicalSearchParams {
  excludeNodeTypes?: NodeType[];
  includeNodeTypes?: NodeType[];
}

export interface ClaimLexicalParams extends LexicalSearchParams {
  statuses?: ClaimStatus[];
  asOf?: Date;
  statedBetween?: { from?: Date; to?: Date };
  includeAssistantInferred?: boolean;
}

export interface NodeLexicalResult extends NodeSearchResult {
  /** ts_headline snippet over the matched text. */
  highlight: string;
}

export interface ClaimLexicalResult extends ClaimSearchResult {
  highlight: string;
}
```

- [ ] **Step 4: Export `generateTextEmbedding`**

Change the declaration `async function generateTextEmbedding(` to `export async function generateTextEmbedding(` in `src/lib/graph.ts`.

- [ ] **Step 5: Apply the new filters inside the vector functions**

**`findSimilarNodes`** — also destructure `includeNodeTypes` and `scope` from
opts. Replace the existing base scope clause:

```typescript
    includeReference ? undefined : nodeHasScopeSupport(userId, "personal"),
```

with one that honours an explicit single scope (takes precedence):

```typescript
    scope
      ? nodeHasScopeSupport(userId, scope)
      : includeReference
        ? undefined
        : nodeHasScopeSupport(userId, "personal"),
```

Then after the existing `excludeNodeTypes` block, add the include-filter:

```typescript
  if (includeNodeTypes && includeNodeTypes.length > 0) {
    whereCondition = and(
      whereCondition,
      inArray(nodes.nodeType, includeNodeTypes),
    );
  }
```

**`findSimilarClaims`** — also destructure `statedBetween` and `scope` from opts.
Replace the existing base scope clause:

```typescript
    includeReference ? undefined : eq(claims.scope, "personal"),
```

with:

```typescript
    scope
      ? eq(claims.scope, scope)
      : includeReference
        ? undefined
        : eq(claims.scope, "personal"),
```

Then, after the `inArray(claims.status, statuses)` / validity conditions are
built, add the range filter:

```typescript
  if (statedBetween?.from) {
    whereCondition = and(
      whereCondition,
      sql`${claims.statedAt} >= ${statedBetween.from}`,
    );
  }
  if (statedBetween?.to) {
    whereCondition = and(
      whereCondition,
      sql`${claims.statedAt} <= ${statedBetween.to}`,
    );
  }
```

- [ ] **Step 6: Implement `findNodesByLexical`**

Add to `src/lib/graph.ts`:

```typescript
/**
 * Lexical node retrieval: full-text match on the generated tsvector plus a
 * pg_trgm fuzzy match on the label, ranked by ts_rank_cd. Used by the hybrid
 * explicit-search pipeline (NOT background context injection).
 */
export async function findNodesByLexical(
  params: NodeLexicalParams,
): Promise<NodeLexicalResult[]> {
  const {
    userId,
    query,
    limit = 10,
    scope = "personal",
    excludeNodeTypes,
    includeNodeTypes,
  } = params;
  const db = await useDatabase();

  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank_cd(${nodeMetadata.searchTsv}, ${tsq})`;
  // word_similarity (not similarity): matches the query against the best-matching
  // word in the label, so a short typo ("Boux") still matches a long label
  // ("Boox Note Air 4C"). Full-string similarity() would score near-zero there.
  const matched = sql`(${nodeMetadata.searchTsv} @@ ${tsq} OR word_similarity(${query}, ${nodeMetadata.label}) > 0.3)`;
  const highlight = sql<string>`ts_headline('english', coalesce(${nodeMetadata.label}, '') || ' ' || coalesce(${nodeMetadata.description}, ''), ${tsq}, 'StartSel=<mark>, StopSel=</mark>, MaxFragments=1')`;

  let where = and(
    eq(nodes.userId, userId),
    nodeHasScopeSupport(userId, scope),
    matched,
  );
  if (includeNodeTypes && includeNodeTypes.length > 0) {
    where = and(where, inArray(nodes.nodeType, includeNodeTypes));
  } else if (excludeNodeTypes && excludeNodeTypes.length > 0) {
    where = and(where, notInArray(nodes.nodeType, excludeNodeTypes));
  }

  const rows = await db
    .select({
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      timestamp: nodes.createdAt,
      rank,
      highlight,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodes.id, nodeMetadata.nodeId))
    .where(where)
    .orderBy(desc(rank))
    .limit(limit);

  return rows.map((r) => ({ ...r, similarity: r.rank }));
}
```

- [ ] **Step 7: Implement `findClaimsByLexical`**

```typescript
/**
 * Lexical claim retrieval: full-text match on the generated tsvector plus a
 * pg_trgm fuzzy match on the statement, ranked by ts_rank_cd. Honours the same
 * status/validity/scope filters as findSimilarClaims, plus an optional
 * stated_at range.
 */
export async function findClaimsByLexical(
  params: ClaimLexicalParams,
): Promise<ClaimLexicalResult[]> {
  const {
    userId,
    query,
    limit = 10,
    scope = "personal",
    statuses = ["active"],
    asOf = new Date(),
    statedBetween,
    includeAssistantInferred = false,
  } = params;
  const db = await useDatabase();

  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank_cd(${claims.searchTsv}, ${tsq})`;
  // word_similarity matches the query against the best-matching word in the
  // statement (handles typos against long statements; see findNodesByLexical).
  const matched = sql`(${claims.searchTsv} @@ ${tsq} OR word_similarity(${query}, ${claims.statement}) > 0.3)`;
  const highlight = sql<string>`ts_headline('english', coalesce(${claims.statement}, '') || ' ' || coalesce(${claims.description}, ''), ${tsq}, 'StartSel=<mark>, StopSel=</mark>, MaxFragments=1')`;

  const subjectNodeMetadata = aliasedTable(nodeMetadata, "subjectNodeMetadata");
  const objectNodeMetadata = aliasedTable(nodeMetadata, "objectNodeMetadata");

  let where = and(
    eq(claims.userId, userId),
    eq(claims.scope, scope),
    includeAssistantInferred
      ? undefined
      : ne(claims.assertedByKind, "assistant_inferred"),
    inArray(claims.status, statuses),
    or(isNull(claims.validTo), gt(claims.validTo, asOf)),
    matched,
  );
  if (statedBetween?.from) {
    where = and(where, sql`${claims.statedAt} >= ${statedBetween.from}`);
  }
  if (statedBetween?.to) {
    where = and(where, sql`${claims.statedAt} <= ${statedBetween.to}`);
  }

  const rows = await db
    .select({
      id: claims.id,
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
      objectValue: claims.objectValue,
      subjectLabel: subjectNodeMetadata.label,
      objectLabel: objectNodeMetadata.label,
      predicate: claims.predicate,
      statement: claims.statement,
      description: claims.description,
      sourceId: claims.sourceId,
      scope: claims.scope,
      assertedByKind: claims.assertedByKind,
      assertedByNodeId: claims.assertedByNodeId,
      status: claims.status,
      statedAt: claims.statedAt,
      timestamp: claims.createdAt,
      rank,
      highlight,
    })
    .from(claims)
    .leftJoin(
      subjectNodeMetadata,
      eq(subjectNodeMetadata.nodeId, claims.subjectNodeId),
    )
    .leftJoin(
      objectNodeMetadata,
      eq(objectNodeMetadata.nodeId, claims.objectNodeId),
    )
    .where(where)
    .orderBy(desc(rank))
    .limit(limit);

  return rows.map((r) => ({ ...r, similarity: r.rank }));
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test src/lib/search/lexical.test.ts`
Expected: PASS (4 tests). If the server on `:5431` is not running the suite skips — start it and re-run; do not leave it skipped.

- [ ] **Step 9: Commit**

```bash
git add src/lib/graph.ts src/lib/search/lexical.test.ts
git commit -m "✨ feat(search): lexical node/claim retrieval with facet filters"
```

---

## Task 5: Search schemas

**Files:**
- Create: `src/lib/schemas/search.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/schemas/search.test.ts
import { describe, expect, it } from "vitest";
import { searchRequestSchema, searchResponseSchema } from "./search";

describe("search schemas", () => {
  it("applies defaults and rejects empty query", () => {
    const parsed = searchRequestSchema.parse({ userId: "u", query: "boox" });
    expect(parsed.limit).toBe(20);
    expect(parsed.scope).toBe("personal");
    expect(() => searchRequestSchema.parse({ userId: "u", query: "" })).toThrow();
  });

  it("accepts entityTypes and statedBetween filters", () => {
    const parsed = searchRequestSchema.parse({
      userId: "u",
      query: "x",
      filters: {
        entityTypes: ["Person", "Task"],
        statedBetween: { from: "2026-05-01T00:00:00Z" },
      },
    });
    expect(parsed.filters?.entityTypes).toEqual(["Person", "Task"]);
    expect(parsed.filters?.statedBetween?.from).toBeInstanceOf(Date);
  });

  it("validates a hit-shaped response", () => {
    const ok = searchResponseSchema.parse({
      query: "x",
      hits: [
        {
          kind: "claim",
          nodeId: "node_abc",
          claimId: "claim_abc",
          text: "The Boox syncs to Drive",
          highlight: "The <mark>Boox</mark> syncs to Drive",
          score: 0.123,
          source: { sourceId: "src_abc", type: "manual" },
          statedAt: "2026-05-10T00:00:00Z",
        },
      ],
    });
    expect(ok.hits[0]!.kind).toBe("claim");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/schemas/search.test.ts`
Expected: FAIL — cannot find module `./search`.

- [ ] **Step 3: Write the schemas**

```typescript
// src/lib/schemas/search.ts
/**
 * Request/response schemas for the hybrid explicit-search route (`POST /search`).
 * Distinct from `/context/search` (card-shaped, semantic background context):
 * this surface returns ranked hits with highlights for intentional lookups.
 *
 * Common aliases: search schema, explicit search, hybrid search, SearchHit.
 */
import { z } from "zod";
import { NodeTypeEnum } from "~/types/graph.js";

export const searchRequestSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(20),
  scope: z.enum(["personal", "reference"]).optional().default("personal"),
  filters: z
    .object({
      /** Restrict hits to these entity (node) types. */
      entityTypes: z.array(NodeTypeEnum).optional(),
      /** Restrict claim hits to this stated_at range (inclusive). */
      statedBetween: z
        .object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

const sourceTypeEnum = z.enum([
  "conversation",
  "conversation_message",
  "document",
  "legacy_migration",
  "manual",
  "meeting_transcript",
  "external_conversation",
  "metric_push",
  "metric_manual",
  "rollup",
]);

export const searchHitSchema = z.object({
  kind: z.enum(["node", "claim"]),
  nodeId: z.string(),
  claimId: z.string().optional(),
  text: z.string(),
  highlight: z.string(),
  score: z.number(),
  source: z.object({
    sourceId: z.string(),
    type: sourceTypeEnum,
    title: z.string().nullish(),
    author: z.string().nullish(),
  }),
  statedAt: z.coerce.date().optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/schemas/search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/search.ts src/lib/schemas/search.test.ts
git commit -m "✨ feat(search): request/response schemas for /search"
```

---

## Task 6: Hybrid pipeline + hit hydration

Assemble the two legs (vector + lexical) for nodes and claims, fuse per id space, merge into one ranked `SearchHit[]`, and hydrate source provenance.

**Files:**
- Create: `src/lib/search/explicit-search.ts`
- Test: `src/lib/search/explicit-search.test.ts`

- [ ] **Step 1: Write the failing test**

This test mocks the four retrieval functions and the embedding call (so it needs no Jina key) and injects a stub `hydrate` (so it needs no DB), then asserts fusion ordering, hit shape, highlight passthrough, claim ownership, and that scope is forwarded to every leg.

```typescript
// src/lib/search/explicit-search.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateTextEmbedding: vi.fn(),
  findSimilarNodes: vi.fn(),
  findSimilarClaims: vi.fn(),
  findNodesByLexical: vi.fn(),
  findClaimsByLexical: vi.fn(),
}));

vi.mock("~/lib/graph", () => ({
  generateTextEmbedding: mocks.generateTextEmbedding,
  findSimilarNodes: mocks.findSimilarNodes,
  findSimilarClaims: mocks.findSimilarClaims,
  findNodesByLexical: mocks.findNodesByLexical,
  findClaimsByLexical: mocks.findClaimsByLexical,
}));

import { explicitSearch } from "./explicit-search";

// Stub hydrator: maps src_1 -> a manual source. Injected so the pipeline never
// touches the DB in this unit test.
const stubHydrate = async (ids: string[]) =>
  new Map(ids.map((id) => [id, { sourceId: id, type: "manual" as const }]));

describe("explicitSearch", () => {
  afterEach(() => vi.clearAllMocks());

  it("fuses legs, builds hits, and orders by fused score", async () => {
    mocks.generateTextEmbedding.mockResolvedValue([0.1, 0.2]);
    mocks.findSimilarNodes.mockResolvedValue([
      { id: "node_1", type: "Object", label: "Boox", description: null, timestamp: new Date(), similarity: 0.9 },
    ]);
    mocks.findNodesByLexical.mockResolvedValue([
      { id: "node_1", type: "Object", label: "Boox", description: null, timestamp: new Date(), similarity: 1, highlight: "<mark>Boox</mark>" },
    ]);
    mocks.findSimilarClaims.mockResolvedValue([]);
    mocks.findClaimsByLexical.mockResolvedValue([
      {
        id: "claim_1", subjectNodeId: "node_1", objectNodeId: null, objectValue: "v",
        subjectLabel: "Boox", objectLabel: null, predicate: "HAS_ATTRIBUTE",
        statement: "Boox syncs", description: null, sourceId: "src_1", scope: "personal",
        assertedByKind: "user", assertedByNodeId: null, status: "active",
        statedAt: new Date("2026-05-10Z"), timestamp: new Date(), similarity: 1,
        highlight: "<mark>Boox</mark> syncs",
      },
    ]);

    const result = await explicitSearch(
      { userId: "u", query: "Boox", limit: 20, scope: "personal" },
      stubHydrate,
    );

    // node_1 appears in both node legs (high fused score) -> first.
    expect(result.hits[0]!.kind).toBe("node");
    expect(result.hits[0]!.nodeId).toBe("node_1");
    expect(result.hits[0]!.source).toBeDefined(); // node provenance is a placeholder in v1
    const claimHit = result.hits.find((h) => h.kind === "claim")!;
    expect(claimHit.nodeId).toBe("node_1"); // owning subject
    expect(claimHit.claimId).toBe("claim_1");
    expect(claimHit.highlight).toContain("<mark>");
    expect(claimHit.source.type).toBe("manual"); // from stubHydrate
  });

  it("forwards scope to every retrieval leg", async () => {
    mocks.generateTextEmbedding.mockResolvedValue([0.1]);
    mocks.findSimilarNodes.mockResolvedValue([]);
    mocks.findNodesByLexical.mockResolvedValue([]);
    mocks.findSimilarClaims.mockResolvedValue([]);
    mocks.findClaimsByLexical.mockResolvedValue([]);

    await explicitSearch(
      { userId: "u", query: "x", limit: 20, scope: "reference" },
      stubHydrate,
    );

    expect(mocks.findSimilarClaims).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "reference" }),
    );
    expect(mocks.findNodesByLexical).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "reference" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/search/explicit-search.test.ts`
Expected: FAIL — cannot find module `./explicit-search`.

- [ ] **Step 3: Write the pipeline**

Source hydration needs the DB. To keep the unit test hermetic, the pipeline accepts an optional `hydrate` injection (defaulting to the real DB-backed implementation); the test passes a stub. Implementation:

```typescript
// src/lib/search/explicit-search.ts
/**
 * Hybrid explicit-search pipeline: runs vector + lexical retrieval for nodes
 * and claims in parallel, fuses each id space with RRF, merges into one ranked
 * SearchHit list, and hydrates source provenance. Powers `POST /search`.
 *
 * Common aliases: hybrid search, explicit search, search pipeline, runSearch.
 */
import { inArray } from "drizzle-orm";
import {
  generateTextEmbedding,
  findSimilarNodes,
  findSimilarClaims,
  findNodesByLexical,
  findClaimsByLexical,
  type NodeLexicalResult,
  type ClaimLexicalResult,
  type NodeSearchResult,
  type ClaimSearchResult,
} from "~/lib/graph";
import { reciprocalRankFusion } from "./fusion";
import { sources } from "~/db/schema";
import { useDatabase } from "~/utils/db";
import type { NodeType, Scope, SourceType } from "~/types/graph";
import type { SearchHit, SearchResponse } from "~/lib/schemas/search";
import type { TypeId } from "~/types/typeid";
import { z } from "zod";

export interface ExplicitSearchParams {
  userId: string;
  query: string;
  limit: number;
  scope: Scope;
  filters?: {
    entityTypes?: NodeType[];
    statedBetween?: { from?: Date; to?: Date };
  };
}

interface HitSource {
  sourceId: string;
  type: SourceType;
  title?: string | null;
  author?: string | null;
}

/** Document sources carry title/author in metadata; parse leniently. */
const docMetaSchema = z
  .object({ title: z.string().nullish(), author: z.string().nullish() })
  .partial()
  .passthrough();

export type SourceHydrator = (
  sourceIds: TypeId<"source">[],
) => Promise<Map<string, HitSource>>;

const dbHydrateSources: SourceHydrator = async (sourceIds) => {
  const map = new Map<string, HitSource>();
  if (sourceIds.length === 0) return map;
  const db = await useDatabase();
  const rows = await db
    .select({
      id: sources.id,
      type: sources.type,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(inArray(sources.id, sourceIds));
  for (const row of rows) {
    const meta = docMetaSchema.safeParse(row.metadata ?? {});
    map.set(row.id, {
      sourceId: row.id,
      type: row.type,
      title: meta.success ? meta.data.title : null,
      author: meta.success ? meta.data.author : null,
    });
  }
  return map;
};

export async function explicitSearch(
  params: ExplicitSearchParams,
  hydrate: SourceHydrator = dbHydrateSources,
): Promise<SearchResponse> {
  const { userId, query, limit, scope, filters } = params;
  const includeNodeTypes = filters?.entityTypes;
  const statedBetween = filters?.statedBetween;
  const legLimit = Math.max(limit * 2, 20);

  const embedding = await generateTextEmbedding(query);

  const [vecNodes, lexNodes, vecClaims, lexClaims]: [
    NodeSearchResult[],
    NodeLexicalResult[],
    ClaimSearchResult[],
    ClaimLexicalResult[],
  ] = await Promise.all([
    findSimilarNodes({
      userId,
      embedding,
      limit: legLimit,
      scope,
      includeNodeTypes,
    }),
    findNodesByLexical({
      userId,
      query,
      limit: legLimit,
      scope,
      includeNodeTypes,
    }),
    findSimilarClaims({
      userId,
      embedding,
      limit: legLimit,
      scope,
      statedBetween,
    }),
    findClaimsByLexical({
      userId,
      query,
      limit: legLimit,
      scope,
      statedBetween,
    }),
  ]);

  const nodeFusion = reciprocalRankFusion([
    vecNodes.map((n) => n.id),
    lexNodes.map((n) => n.id),
  ]);
  const claimFusion = reciprocalRankFusion([
    vecClaims.map((c) => c.id),
    lexClaims.map((c) => c.id),
  ]);

  // Index rows for hit assembly. Lexical rows carry highlights; prefer them.
  const nodeById = new Map<string, NodeSearchResult | NodeLexicalResult>();
  for (const n of vecNodes) nodeById.set(n.id, n);
  for (const n of lexNodes) nodeById.set(n.id, n);
  const nodeHighlight = new Map(lexNodes.map((n) => [n.id, n.highlight]));

  const claimById = new Map<string, ClaimSearchResult | ClaimLexicalResult>();
  for (const c of vecClaims) claimById.set(c.id, c);
  for (const c of lexClaims) claimById.set(c.id, c);
  const claimHighlight = new Map(lexClaims.map((c) => [c.id, c.highlight]));

  const claimSourceIds = claimFusion
    .map((f) => claimById.get(f.id)?.sourceId)
    .filter((s): s is TypeId<"source"> => Boolean(s));
  const sourceMap = await hydrate(claimSourceIds);

  const nodeHits: SearchHit[] = nodeFusion.flatMap((f) => {
    const row = nodeById.get(f.id);
    if (!row) return [];
    return [
      {
        kind: "node",
        nodeId: row.id,
        text: row.label ?? "",
        highlight: nodeHighlight.get(row.id) ?? row.label ?? "",
        score: f.score,
        // Node provenance is a v1 placeholder (a node has many sources); the
        // UI fetches full provenance via get_entity when needed.
        source: { sourceId: "", type: "manual" },
      },
    ];
  });

  const claimHits: SearchHit[] = claimFusion.flatMap((f) => {
    const row = claimById.get(f.id);
    if (!row) return [];
    const source: HitSource = sourceMap.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      type: "manual",
      title: null,
      author: null,
    };
    return [
      {
        kind: "claim",
        nodeId: row.subjectNodeId,
        claimId: row.id,
        text: row.statement,
        highlight: claimHighlight.get(row.id) ?? row.statement,
        score: f.score,
        source,
        statedAt: row.statedAt,
      },
    ];
  });

  const hits = [...nodeHits, ...claimHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { query, hits };
}
```

> **Node-hit source note:** a node has many sources, so node-hit `source` is a v1 placeholder (`{ sourceId: "", type: "manual" }`); the UI calls `get_entity` for full provenance. Real provenance is asserted on **claim** hits only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/search/explicit-search.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/explicit-search.ts src/lib/search/explicit-search.test.ts
git commit -m "✨ feat(search): hybrid retrieval pipeline with RRF and hit hydration"
```

---

## Task 7: The `POST /search` route

**Files:**
- Create: `src/routes/search.post.ts`
- Test: `src/search-route.test.ts`

- [ ] **Step 1: Write the failing test (handler-level, mirrors `src/digest-route.test.ts`)**

```typescript
// src/search-route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { H3Event } from "h3";

const mocks = vi.hoisted(() => ({ explicitSearch: vi.fn() }));
vi.mock("~/lib/search/explicit-search", () => ({
  explicitSearch: mocks.explicitSearch,
}));

import handler from "./routes/search.post";
import { searchResponseSchema } from "~/lib/schemas/search";

describe("POST /search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("validates the request, calls the pipeline, and round-trips the response", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "u", query: "Boox" }));
    mocks.explicitSearch.mockResolvedValue({
      query: "Boox",
      hits: [
        {
          kind: "claim",
          nodeId: "node_1",
          claimId: "claim_1",
          text: "Boox syncs",
          highlight: "<mark>Boox</mark> syncs",
          score: 0.5,
          source: { sourceId: "src_1", type: "manual" },
          statedAt: new Date("2026-05-10Z"),
        },
      ],
    });

    const response = searchResponseSchema.parse(await handler({} as H3Event));
    expect(response.hits).toHaveLength(1);
    // Defaults applied by the request schema reached the pipeline.
    expect(mocks.explicitSearch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u", query: "Boox", limit: 20, scope: "personal" }),
    );
  });

  it("rejects an empty query", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "u", query: "" }));
    await expect(handler({} as H3Event)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/search-route.test.ts`
Expected: FAIL — cannot find module `./routes/search.post`.

- [ ] **Step 3: Write the route**

```typescript
// src/routes/search.post.ts
/**
 * `POST /search` — hybrid explicit-search route.
 *
 * The intentional-lookup surface: a human typing in a search box, or an
 * assistant deliberately looking something up. Fuses lexical (tsvector +
 * pg_trgm) and vector retrieval (RRF) and returns ranked hits with highlights.
 *
 * Distinct from `POST /context/search` (semantic, card-shaped, auto-injected
 * background context) and the legacy `POST /query/search` (raw graph for
 * visualization). See docs/superpowers/specs/2026-06-16-hybrid-explicit-search-design.md.
 */
import { explicitSearch } from "~/lib/search/explicit-search";
import {
  searchRequestSchema,
  searchResponseSchema,
} from "~/lib/schemas/search";

export default defineEventHandler(async (event) => {
  const { userId, query, limit, scope, filters } = searchRequestSchema.parse(
    await readBody(event),
  );

  const result = await explicitSearch({ userId, query, limit, scope, filters });

  return searchResponseSchema.parse(result);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/search-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/search.post.ts src/search-route.test.ts
git commit -m "✨ feat(search): POST /search hybrid explicit-search route"
```

---

## Task 8: SDK `search()` method

**Files:**
- Modify: `src/sdk/memory-client.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sdk/memory-client-search.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryClient } from "./memory-client";

describe("MemoryClient.search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /search and parses the hit-shaped response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        query: "Boox",
        hits: [
          {
            kind: "node",
            nodeId: "node_1",
            text: "Boox",
            highlight: "<mark>Boox</mark>",
            score: 0.4,
            source: { sourceId: "src_1", type: "manual" },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    const res = await client.search({ userId: "u", query: "Boox" });

    expect(res.hits[0]!.nodeId).toBe("node_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/search",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/sdk/memory-client-search.test.ts`
Expected: FAIL — `client.search` is not a function.

- [ ] **Step 3: Add imports and the method**

At the top of `src/sdk/memory-client.ts`, add to the import block:

```typescript
import {
  searchResponseSchema,
  type SearchRequest,
  type SearchResponse,
} from "../lib/schemas/search.js";
```

Inside the `MemoryClient` class, after `contextSearch`, add:

```typescript
  /**
   * Hybrid explicit search: lexical + vector retrieval fused with RRF, returning
   * ranked hits with highlights. Use for intentional lookups (a search box, or
   * the assistant deliberately looking something up) — not for automatic
   * conversation context, which is `contextSearch`.
   */
  async search(payload: SearchRequest): Promise<SearchResponse> {
    return this._fetch("POST", "/search", searchResponseSchema, payload);
  }
```

- [ ] **Step 4: Run tests + SDK build**

Run: `pnpm test src/sdk/memory-client-search.test.ts`
Expected: PASS.

Run: `pnpm run build-sdk`
Expected: PASS (SDK compiles and the verify script is happy with the new export path).

- [ ] **Step 5: Commit**

```bash
git add src/sdk/memory-client.ts src/sdk/memory-client-search.test.ts
git commit -m "✨ feat(sdk): MemoryClient.search() for hybrid explicit search"
```

---

## Task 9: Full verification gate

- [ ] **Step 1: Typecheck + structured-output check**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 2: Lint + format**

Run: `pnpm run lint && pnpm run format`
Expected: PASS (run `pnpm run lint:fix` / `pnpm run format:fix` if needed, then re-run).

- [ ] **Step 3: Full test suite (local, server on :5431 running)**

Run: `pnpm test`
Expected: PASS. Confirm the lexical suite did NOT skip (server reachable).

- [ ] **Step 4: SDK build**

Run: `pnpm run build-sdk`
Expected: PASS.

- [ ] **Step 5: Final commit if any fixups**

```bash
git add -A
git commit -m "🔧 chore(search): lint/format/typecheck fixups"
```

---

## Follow-on (separate plan, separate worktree)

Not in this plan; track as next steps:

1. **Petals manual explorer** (`~/code/petals`, `/memory/explore`): migrate `searchMemory` server fn from `querySearch` → `search()`; render ranked hits + highlights. Dedicated Petals worktree.
2. **`n8n-nodes-petals`**: add a `search` operation.
3. **Petals proxy endpoint** for `/search`.
4. **Assistant MCP tool** `search_text` → `/search` (open decision from the spec — confirm whether to add it or leave explicit search host/UI-only).
5. **Rerank toggle**: expose the off-by-default Jina rerank seam if relevance tuning needs it.
