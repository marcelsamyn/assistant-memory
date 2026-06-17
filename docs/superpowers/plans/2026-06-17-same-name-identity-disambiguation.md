# Same-Name Identity Disambiguation & Self-Identity Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the knowledge graph from attributing the user's own statements (and other people's) to the wrong same-named node by giving the user-self node a distinguishing identity, wiring transcript speakers in as claim *subjects*, and making the resolver refuse to guess on ambiguous name ties.

**Architecture:** Four components in leverage order. (1) **Self-node hygiene** — a new `src/lib/user-self-identity.ts` module names the self node with the user's full name and seeds only multi-token aliases; called from both the config endpoint and transcript ingest. (2) **Subject-wiring** — `extractGraph` registers transcript speaker nodes into `idMap` and the prompt tells the model to use the user-self speaker's nodeId as the subject of first-person claims. (3) **Resolver never guesses** — `resolveIdentity` resolves only on a *unique* canonical/alias match; >1 match splits + logs `identity.ambiguous_skip`. (4) **Prompt insurance** — inject "who the user is" into document/conversation prompts and add a static anti-conflation rule.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Drizzle ORM, Postgres (+pgvector), Zod, h3/Nitro file-based routes, Vitest (real-Postgres integration tests on port **5431**). Spec: `docs/superpowers/specs/2026-06-17-same-name-identity-disambiguation-design.md`.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `src/lib/user-self-identity.ts` | User-self Person node identity: lazy creation, primary-label selection, distinguishing-alias seeding, `buildUserIdentityNote`. Pure helpers + DB helpers. |
| `src/lib/user-self-identity.test.ts` | Unit tests: pure helpers (no DB) + `ensureUserSelfIdentity` (DB). |
| `src/lib/jobs/backfill-user-self-identity.ts` | One-off maintenance: bring an existing self node to the new contract; remove bare self alias. |
| `src/lib/schemas/backfill-user-self-identity.ts` | Request/response Zod schemas for the backfill route. |
| `src/routes/maintenance/backfill-user-self-identity.post.ts` | HTTP trigger for the backfill job (Nitro auto-routed). |

**Modified files**

| File | Change |
| --- | --- |
| `src/lib/transcript/resolve-speakers.ts` | Import `ensureUserSelfPersonNode` from the new module; delete the local copy; stop writing the bare self alias; drop now-unused `sql` import. |
| `src/lib/user-profile.ts` | `setUserSelfAliases` calls `ensureUserSelfIdentity` after persisting. |
| `src/lib/jobs/ingest-transcript.ts` | Call `ensureUserSelfIdentity` with the effective alias list before resolving speakers. |
| `src/lib/extract-graph.ts` | Register speaker nodes into `idMap`; subject-wiring in `_formatSpeakerMapSection` + static few-shot; static anti-conflation rule; new `userIdentityNote` param + render. |
| `src/lib/identity-resolution.ts` | Unique-match-wins; `ambiguous` trace field; `identity.ambiguous_skip` log. |
| `src/lib/jobs/ingest-conversation.ts` | Build + pass `userIdentityNote`. |
| `src/lib/ingestion/extract-document-graph.ts` | Build + pass `userIdentityNote`. |
| `src/lib/ingestion/chunked-extract.ts` | Thread `userIdentityNote` through to each `extractGraph` call. |
| `src/lib/identity-resolution.test.ts` | Ambiguity tests + self-by-full-name vs bare-name test. |
| `src/lib/jobs/ingest-transcript.test.ts` | Subject-wiring integration test. |

**Build order:** Tasks 1→6 deliver Component 1 (kills the reported bug at the source). Tasks 7–8 = Component 2. Task 9 = Component 3. Tasks 10–11 = Component 4. Task 12 = full verification.

**Testing note:** CI does **not** run vitest — run targeted tests locally against Postgres on `:5431` (`docker compose up db` first if needed). Run a single test file once with:
`pnpm run test -- run <path>` (vitest treats `run <path>` as run-once + filter).

---

## Task 1: New module `user-self-identity.ts` + pure-helper tests

**Files:**
- Create: `src/lib/user-self-identity.ts`
- Test: `src/lib/user-self-identity.test.ts`

- [ ] **Step 1: Write the failing pure-helper tests**

Create `src/lib/user-self-identity.test.ts` with ONLY the pure-helper suite for now (the DB suite is added in Task 5):

```ts
import { describe, expect, it } from "vitest";
import {
  buildUserIdentityNote,
  distinguishingAliases,
  selectPrimarySelfLabel,
} from "./user-self-identity";

describe("selectPrimarySelfLabel", () => {
  it("picks the alias with the most tokens", () => {
    expect(selectPrimarySelfLabel(["Marcel", "Marcel Samyn"])).toBe(
      "Marcel Samyn",
    );
  });

  it("returns null when only single-token aliases are present", () => {
    expect(selectPrimarySelfLabel(["Marcel"])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectPrimarySelfLabel([])).toBeNull();
  });

  it("prefers the longest string when token counts tie", () => {
    expect(selectPrimarySelfLabel(["Jo Lee", "Joanna Lee"])).toBe("Joanna Lee");
  });
});

describe("distinguishingAliases", () => {
  it("keeps only multi-token aliases, de-duplicated by normalized form", () => {
    expect(
      distinguishingAliases(["Marcel", "Marcel Samyn", "marcel samyn"]),
    ).toEqual(["Marcel Samyn"]);
  });

  it("drops bare single-token names", () => {
    expect(distinguishingAliases(["Marcel", "MS"])).toEqual([]);
  });
});

describe("buildUserIdentityNote", () => {
  it("returns null when there are no aliases", () => {
    expect(buildUserIdentityNote([])).toBeNull();
  });

  it("names the primary, lists aliases, and warns against conflation", () => {
    const note = buildUserIdentityNote(["Marcel", "Marcel Samyn"]);
    expect(note).toContain("Marcel Samyn");
    expect(note).toContain("most specific");
    expect(note).toContain("share a first name");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- run src/lib/user-self-identity.test.ts`
Expected: FAIL — `Cannot find module './user-self-identity'`.

- [ ] **Step 3: Create the module**

Create `src/lib/user-self-identity.ts`:

```ts
/**
 * User-self Person node identity management.
 *
 * Centralizes everything about the account owner's own Person node: lazy
 * creation (advisory-lock-guarded), naming it with a distinguishing label,
 * and seeding only unambiguous (multi-token) aliases into the global alias
 * table used by `resolveIdentity`. Bare first names are deliberately kept out
 * of the alias table so a same-named contact can never be merged into the
 * user (or vice versa) on a single-token match. Also builds the "who the user
 * is" note injected into document/conversation extraction prompts.
 *
 * Common aliases: user self node, self identity, primary self label,
 * distinguishing aliases, user identity prompt note, isUserSelf.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { createAlias } from "~/lib/alias";
import { normalizeLabel } from "~/lib/label";
import type { TypeId } from "~/types/typeid";

/** Count whitespace-separated tokens in an alias (after trimming). */
function tokenCount(alias: string): number {
  return alias
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

/**
 * Aliases safe to write to the global alias table and to use as a node label:
 * multi-token only, de-duplicated by normalized form. Single-token names
 * (e.g. "Marcel") are inherently ambiguous and are intentionally excluded.
 */
export function distinguishingAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (tokenCount(trimmed) < 2) continue;
    const key = normalizeLabel(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Pick the most-specific distinguishing alias to use as the self node's
 * primary label: most tokens, then longest string. Returns null when no
 * multi-token alias is available, so the node keeps its existing label rather
 * than being downgraded to an ambiguous single-token name.
 */
export function selectPrimarySelfLabel(aliases: string[]): string | null {
  const candidates = distinguishingAliases(aliases);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestTokens = tokenCount(best);
    const currentTokens = tokenCount(current);
    if (currentTokens > bestTokens) return current;
    if (currentTokens === bestTokens && current.length > best.length) {
      return current;
    }
    return best;
  });
}

/**
 * Build the "who the user is" note injected into document/conversation
 * extraction prompts. Returns null when no aliases are configured so callers
 * can omit the section entirely.
 */
export function buildUserIdentityNote(aliases: string[]): string | null {
  const cleaned = aliases.map((a) => a.trim()).filter((a) => a.length > 0);
  if (cleaned.length === 0) return null;
  const primary = selectPrimarySelfLabel(cleaned) ?? cleaned[0]!;
  const aliasList = [...new Set(cleaned)].join(", ");
  return `About the user: the account owner is "${primary}" (also referred to as: ${aliasList}). When the content refers to the user by name, use their most specific name as the node label. Do NOT merge a different person who happens to share a first name with the user, and never attribute a same-named other person's statements to the user.`;
}

/**
 * Ensure the user's own Person node exists, returning its id. Looked up by
 * `nodeMetadata.additionalData.isUserSelf = true`; created lazily on first use.
 *
 * Concurrency: serialized per-user via a transaction-scoped Postgres advisory
 * lock keyed on `hashtext('user_self_person:' || userId)`. Two concurrent
 * callers for the same user queue at the lock and observe each other's INSERT,
 * so only one user-self Person row is ever created. The lock releases
 * automatically at transaction commit.
 */
export async function ensureUserSelfPersonNode(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"node">> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"user_self_person:" + userId}))`,
    );

    const personNodes = await tx
      .select({
        id: nodes.id,
        label: nodeMetadata.label,
        additionalData: nodeMetadata.additionalData,
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(and(eq(nodes.userId, userId), eq(nodes.nodeType, "Person")));

    for (const row of personNodes) {
      const additional = row.additionalData;
      if (
        additional &&
        typeof additional === "object" &&
        !Array.isArray(additional) &&
        (additional as Record<string, unknown>)["isUserSelf"] === true
      ) {
        return row.id;
      }
    }

    const [newNode] = await tx
      .insert(nodes)
      .values({ userId, nodeType: "Person" })
      .returning();
    if (!newNode) {
      throw new Error(`Failed to create user-self Person node for ${userId}`);
    }
    await tx.insert(nodeMetadata).values({
      nodeId: newNode.id,
      label: userId,
      canonicalLabel: normalizeLabel(userId),
      additionalData: { isUserSelf: true },
    });
    return newNode.id;
  });
}

/**
 * Ensure the user-self Person node exists, carries a distinguishing primary
 * label, and has the user's multi-token aliases seeded into the alias table.
 * Single-token (ambiguous) aliases are deliberately NOT written to the alias
 * table — they remain usable for transcript speaker matching via the
 * `userSelfAliases` config set, but must never drive an identity merge.
 *
 * Idempotent: safe to call on every transcript ingest and every config write.
 */
export async function ensureUserSelfIdentity(
  db: DrizzleDB,
  userId: string,
  aliases: string[],
): Promise<TypeId<"node">> {
  const nodeId = await ensureUserSelfPersonNode(db, userId);

  const primaryLabel = selectPrimarySelfLabel(aliases);
  if (primaryLabel) {
    await db
      .update(nodeMetadata)
      .set({
        label: primaryLabel,
        canonicalLabel: normalizeLabel(primaryLabel),
      })
      .where(eq(nodeMetadata.nodeId, nodeId));
  }

  for (const alias of distinguishingAliases(aliases)) {
    await createAlias(db, {
      userId,
      canonicalNodeId: nodeId,
      aliasText: alias,
    });
  }

  return nodeId;
}
```

- [ ] **Step 4: Run the pure-helper tests to verify they pass**

Run: `pnpm run test -- run src/lib/user-self-identity.test.ts`
Expected: PASS (the pure-helper suites). The DB suite is added in Task 5.

- [ ] **Step 5: Typecheck**

Run: `pnpm run build:check`
Expected: PASS. (`ensureUserSelfPersonNode` now also exists in `resolve-speakers.ts`; two distinct functions, no conflict yet — reconciled in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/user-self-identity.ts src/lib/user-self-identity.test.ts
git commit -m "✨ feat(identity): user-self identity module (label + distinguishing aliases)"
```

---

## Task 2: Rewire `resolve-speakers.ts` to the shared self-node helper

**Files:**
- Modify: `src/lib/transcript/resolve-speakers.ts`

- [ ] **Step 1: Replace the drizzle import (drop `sql`)**

Find:
```ts
import { and, eq, inArray, sql } from "drizzle-orm";
```
Replace with:
```ts
import { and, eq, inArray } from "drizzle-orm";
```

- [ ] **Step 2: Import the shared helper**

Find:
```ts
import { normalizeLabel } from "~/lib/label";
```
Replace with:
```ts
import { normalizeLabel } from "~/lib/label";
import { ensureUserSelfPersonNode } from "~/lib/user-self-identity";
```

- [ ] **Step 3: Stop writing the bare self alias in the user-self branch**

Find:
```ts
    // 1. user-self
    if (userSelfNormalized.has(normalized)) {
      const nodeId = await ensureUserSelfNode();
      map.set(label, { nodeId, isUserSelf: true, resolution: "user_self" });
      // Persist the alias on the user-self node so future identity resolution
      // picks it up too.
      await createAlias(db, {
        userId,
        canonicalNodeId: nodeId,
        aliasText: label,
      });
      continue;
    }
```
Replace with:
```ts
    // 1. user-self. Resolution matches against the `userSelfAliases` config
    // set directly, so we deliberately do NOT write the (often bare,
    // ambiguous) speaker label into the alias table — that is exactly what let
    // a same-named contact merge into the user. Distinguishing aliases are
    // seeded separately via `ensureUserSelfIdentity`.
    if (userSelfNormalized.has(normalized)) {
      const nodeId = await ensureUserSelfNode();
      map.set(label, { nodeId, isUserSelf: true, resolution: "user_self" });
      continue;
    }
```

- [ ] **Step 4: Delete the local `ensureUserSelfPersonNode`**

Delete the entire local function and its doc comment — the block that begins:
```ts
/**
 * Ensure the user's own Person node exists. Looked up by
 * `nodeMetadata.additionalData.isUserSelf = true` for the user's Person nodes;
```
…through the closing brace of `ensureUserSelfPersonNode` (the `return newNode.id;\n  });\n}` right before `async function createPlaceholderPersonNode(`). The closure `ensureUserSelfNode` near the top of `resolveSpeakers` still calls `ensureUserSelfPersonNode(db, userId)` — it now resolves to the imported version. Leave `createPlaceholderPersonNode` intact.

- [ ] **Step 5: Typecheck**

Run: `pnpm run build:check`
Expected: PASS. If it reports `createAlias` or `normalizeAliasText` unused, leave them — both are still used by the known-participant and placeholder branches. Only `sql` was removed.

- [ ] **Step 6: Run the speaker-resolution tests**

Run: `pnpm run test -- run src/lib/transcript/resolve-speakers.test.ts`
Expected: PASS. (Neither test asserts a bare self alias is written.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/transcript/resolve-speakers.ts
git commit -m "♻️ refactor(transcript): use shared self-node helper; stop seeding bare self alias"
```

---

## Task 3: `setUserSelfAliases` ensures self identity

**Files:**
- Modify: `src/lib/user-profile.ts`

- [ ] **Step 1: Import the helper**

Find:
```ts
import { newTypeId } from "~/types/typeid";
```
Replace with:
```ts
import { newTypeId } from "~/types/typeid";
import { ensureUserSelfIdentity } from "~/lib/user-self-identity";
```

- [ ] **Step 2: Call `ensureUserSelfIdentity` after persisting**

Find:
```ts
  const existing = await readMetadata(db, userId);
  if (existing === null) {
    await db.insert(userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: "",
      metadata: { ...parsed, userSelfAliases: nextAliases },
    });
    return { aliases: nextAliases };
  }

  // Merge: replace `userSelfAliases`, preserve catchall keys.
  const nextMetadata: UserProfileMetadata = {
    ...existing,
    userSelfAliases: nextAliases,
  };
  await db
    .update(userProfiles)
    .set({ metadata: nextMetadata, lastUpdatedAt: sql`now()` })
    .where(eq(userProfiles.userId, userId));

  return { aliases: nextAliases };
```
Replace with:
```ts
  const existing = await readMetadata(db, userId);
  if (existing === null) {
    await db.insert(userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: "",
      metadata: { ...parsed, userSelfAliases: nextAliases },
    });
  } else {
    // Merge: replace `userSelfAliases`, preserve catchall keys.
    const nextMetadata: UserProfileMetadata = {
      ...existing,
      userSelfAliases: nextAliases,
    };
    await db
      .update(userProfiles)
      .set({ metadata: nextMetadata, lastUpdatedAt: sql`now()` })
      .where(eq(userProfiles.userId, userId));
  }

  // Keep the self node's label + distinguishing aliases in sync with config.
  await ensureUserSelfIdentity(db, userId, nextAliases);

  return { aliases: nextAliases };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/user-profile.ts
git commit -m "✨ feat(identity): setUserSelfAliases names the self node + seeds aliases"
```

---

## Task 4: Transcript ingest ensures self identity with effective aliases

**Files:**
- Modify: `src/lib/jobs/ingest-transcript.ts`

- [ ] **Step 1: Import the helper**

Find:
```ts
import { getUserSelfAliases } from "~/lib/user-profile";
```
Replace with:
```ts
import { getUserSelfAliases } from "~/lib/user-profile";
import { ensureUserSelfIdentity } from "~/lib/user-self-identity";
```

- [ ] **Step 2: Ensure self identity before resolving speakers**

Find:
```ts
  const userSelfAliases =
    userSelfAliasesOverride ?? (await getUserSelfAliases(db, userId));

  const speakerLabels = utterances.map((u) => u.speakerLabel);
```
Replace with:
```ts
  const userSelfAliases =
    userSelfAliasesOverride ?? (await getUserSelfAliases(db, userId));

  // WhatsApp (and other transcript hosts) send `userSelfAliasesOverride` per
  // request and never call /user/self-aliases, so the stored list may be
  // empty. Use the EFFECTIVE list so the self node still gets a distinguishing
  // label + aliases on the real ingestion path.
  await ensureUserSelfIdentity(db, userId, userSelfAliases);

  const speakerLabels = utterances.map((u) => u.speakerLabel);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 4: Run the existing transcript tests (regression)**

Run: `pnpm run test -- run src/lib/jobs/ingest-transcript.test.ts`
Expected: PASS. The existing self-node assertion (`isUserSelf = true` exists) still holds; the bare-alias change does not break it (self nodes stay non-orphan via their source links).

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/ingest-transcript.ts
git commit -m "✨ feat(transcript): ensure user-self identity from effective aliases on ingest"
```

---

## Task 5: DB test for `ensureUserSelfIdentity`

**Files:**
- Modify: `src/lib/user-self-identity.test.ts`

- [ ] **Step 1: Add the DB-integration suite**

Append to `src/lib/user-self-identity.test.ts` (after the existing pure-helper suites). Add these imports at the TOP of the file (extend the existing `vitest` import and add the others):

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
```

(Note: the existing top import `import { describe, expect, it } from "vitest";` is now redundant — merge it into the line above so `vitest` is imported once.)

Then append the suite:

```ts
const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

async function createIdentityHygieneTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "nodes" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "node_type" varchar(50) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "node_metadata" (
      "id" text PRIMARY KEY NOT NULL,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "label" text,
      "canonical_label" text,
      "description" text,
      "additional_data" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "aliases_user_normalized_canonical_unique"
        UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
    );
  `);
}

describeIfServer("ensureUserSelfIdentity", () => {
  const dbName = `memory_self_identity_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("names the self node with the full name and seeds only multi-token aliases", async () => {
    const userId = "user_self_identity_a";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      await createIdentityHygieneTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      const database = drizzle(client, { schema, casing: "snake_case" });

      const { ensureUserSelfIdentity } = await import("./user-self-identity");
      const nodeId = await ensureUserSelfIdentity(database, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);

      const meta = await client.query<{
        label: string;
        canonical_label: string;
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT label, canonical_label, additional_data FROM node_metadata WHERE node_id = $1`,
        [nodeId],
      );
      expect(meta.rows[0]?.label).toBe("Marcel Samyn");
      expect(meta.rows[0]?.canonical_label).toBe("marcel samyn");
      expect(meta.rows[0]?.additional_data).toMatchObject({ isUserSelf: true });

      const aliasRows = await client.query<{ normalized_alias_text: string }>(
        `SELECT normalized_alias_text FROM aliases WHERE user_id = $1 AND canonical_node_id = $2`,
        [userId, nodeId],
      );
      const normalized = aliasRows.rows.map((r) => r.normalized_alias_text);
      expect(normalized).toContain("marcel samyn");
      expect(normalized).not.toContain("marcel");

      // Idempotent: a second call adds nothing and keeps a single self node.
      const nodeId2 = await ensureUserSelfIdentity(database, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);
      expect(nodeId2).toBe(nodeId);
      const selfCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM node_metadata
         WHERE (additional_data ->> 'isUserSelf') = 'true'`,
      );
      expect(selfCount.rows[0]?.count).toBe("1");
    } finally {
      await client.end();
    }
  });

  it("leaves the label unchanged when only single-token aliases are given", async () => {
    const userId = "user_self_identity_b";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      await createIdentityHygieneTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      const database = drizzle(client, { schema, casing: "snake_case" });

      const { ensureUserSelfIdentity } = await import("./user-self-identity");
      const nodeId = await ensureUserSelfIdentity(database, userId, ["Marcel"]);

      const meta = await client.query<{ label: string }>(
        `SELECT label FROM node_metadata WHERE node_id = $1`,
        [nodeId],
      );
      // No multi-token alias → primary label stays the placeholder (userId).
      expect(meta.rows[0]?.label).toBe(userId);

      const aliasRows = await client.query<{ id: string }>(
        `SELECT id FROM aliases WHERE user_id = $1 AND canonical_node_id = $2`,
        [userId, nodeId],
      );
      expect(aliasRows.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
```

- [ ] **Step 2: Run the test (DB on :5431)**

Run: `pnpm run test -- run src/lib/user-self-identity.test.ts`
Expected: PASS (pure suites + both DB tests).

- [ ] **Step 3: Commit**

```bash
git add src/lib/user-self-identity.test.ts
git commit -m "✅ test(identity): ensureUserSelfIdentity names node + seeds multi-token aliases"
```

---

## Task 6: Self-node backfill (job + schema + route)

**Files:**
- Create: `src/lib/jobs/backfill-user-self-identity.ts`
- Create: `src/lib/schemas/backfill-user-self-identity.ts`
- Create: `src/routes/maintenance/backfill-user-self-identity.post.ts`

- [ ] **Step 1: Create the schemas**

Create `src/lib/schemas/backfill-user-self-identity.ts`:

```ts
import { z } from "zod";

export const backfillUserSelfIdentityRequestSchema = z.object({
  userId: z.string().min(1),
  /** When omitted, the stored `userSelfAliases` are used. */
  aliases: z.array(z.string().min(1)).optional(),
});

export const backfillUserSelfIdentityResponseSchema = z.object({
  selfNodeId: z.string(),
  primaryAliasesSeeded: z.array(z.string()),
  removedAmbiguousAliases: z.number().int().nonnegative(),
});
```

- [ ] **Step 2: Create the job**

Create `src/lib/jobs/backfill-user-self-identity.ts`:

```ts
/**
 * One-off maintenance: bring an existing user-self Person node up to the
 * current identity-hygiene contract — distinguishing primary label, seeded
 * multi-token aliases, and NO ambiguous bare-first-name alias.
 *
 * Idempotent. Operates on the explicitly-passed aliases when given, else the
 * stored `userSelfAliases`.
 */
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { aliases as aliasesTable } from "~/db/schema";
import { normalizeAliasText } from "~/lib/alias";
import { getUserSelfAliases } from "~/lib/user-profile";
import {
  distinguishingAliases,
  ensureUserSelfIdentity,
} from "~/lib/user-self-identity";

export interface BackfillUserSelfIdentityParams {
  db: DrizzleDB;
  userId: string;
  aliases?: string[];
}

export interface BackfillUserSelfIdentityResult {
  selfNodeId: string;
  primaryAliasesSeeded: string[];
  removedAmbiguousAliases: number;
}

export async function backfillUserSelfIdentity(
  params: BackfillUserSelfIdentityParams,
): Promise<BackfillUserSelfIdentityResult> {
  const { db, userId } = params;
  const effectiveAliases =
    params.aliases ?? (await getUserSelfAliases(db, userId));

  const selfNodeId = await ensureUserSelfIdentity(db, userId, effectiveAliases);
  const seeded = distinguishingAliases(effectiveAliases);
  const keep = new Set(seeded.map((a) => normalizeAliasText(a)));

  // Remove any previously-written single-token (ambiguous) alias rows on the
  // self node; keep only the multi-token distinguishing aliases.
  const selfAliasRows = await db
    .select({
      id: aliasesTable.id,
      normalized: aliasesTable.normalizedAliasText,
    })
    .from(aliasesTable)
    .where(
      and(
        eq(aliasesTable.userId, userId),
        eq(aliasesTable.canonicalNodeId, selfNodeId),
      ),
    );

  let removed = 0;
  for (const row of selfAliasRows) {
    if (!keep.has(row.normalized)) {
      await db.delete(aliasesTable).where(eq(aliasesTable.id, row.id));
      removed += 1;
    }
  }

  return {
    selfNodeId,
    primaryAliasesSeeded: seeded,
    removedAmbiguousAliases: removed,
  };
}
```

- [ ] **Step 3: Create the route**

Create `src/routes/maintenance/backfill-user-self-identity.post.ts`:

```ts
import { defineEventHandler, readBody } from "h3";
import { backfillUserSelfIdentity } from "~/lib/jobs/backfill-user-self-identity";
import {
  backfillUserSelfIdentityRequestSchema,
  backfillUserSelfIdentityResponseSchema,
} from "~/lib/schemas/backfill-user-self-identity";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, aliases } = backfillUserSelfIdentityRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await backfillUserSelfIdentity({
    db,
    userId,
    ...(aliases !== undefined ? { aliases } : {}),
  });
  return backfillUserSelfIdentityResponseSchema.parse(result);
});
```

- [ ] **Step 4: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/backfill-user-self-identity.ts src/lib/schemas/backfill-user-self-identity.ts src/routes/maintenance/backfill-user-self-identity.post.ts
git commit -m "✨ feat(maintenance): backfill route to repair existing user-self identity"
```

---

## Task 7: Component 2 — register speaker nodes as subjects + prompt wiring

**Files:**
- Modify: `src/lib/extract-graph.ts`

- [ ] **Step 1: Register speaker nodes into `idMap`**

Find:
```ts
  const { nodesForPromptFormatting, idMap, nodeLabels } =
    _prepareInitialNodeMappings(cappedNodes);
```
Replace with:
```ts
  const { nodesForPromptFormatting, idMap, nodeLabels } =
    _prepareInitialNodeMappings(cappedNodes);

  // Register every resolved speaker node so the LLM can use its real id as a
  // claim subjectId (e.g. the user-self speaker's first-person statements).
  // Unconditional — speaker subjects must not be dropped by the 150-node cap.
  if (speakerMap) {
    for (const entry of speakerMap.values()) {
      idMap.set(entry.nodeId.toString(), entry.nodeId);
    }
  }
```

- [ ] **Step 2: Make the speaker section teach subject-wiring**

Find the whole `_formatSpeakerMapSection` function:
```ts
function _formatSpeakerMapSection(
  speakerMap: ExtractGraphSpeakerMap | undefined,
): string {
  if (!speakerMap || speakerMap.size === 0) return "";
  const lines = [...speakerMap.entries()].map(([label, entry]) => {
    const role = entry.isUserSelf ? "user-self" : "other-participant";
    return `- speakerLabel: ${label}; nodeId: ${entry.nodeId}; role: ${role}`;
  });
  return `Speakers in this transcript:
For each claim, set "assertedBySpeakerLabel" to the speaker who said it, using these labels exactly. Claims whose speaker label is missing or not in this list will be dropped.
${lines.join("\n")}`;
}
```
Replace with:
```ts
function _formatSpeakerMapSection(
  speakerMap: ExtractGraphSpeakerMap | undefined,
): string {
  if (!speakerMap || speakerMap.size === 0) return "";
  const lines = [...speakerMap.entries()].map(([label, entry]) => {
    const role = entry.isUserSelf
      ? "user-self (the user / 'you')"
      : "other-participant";
    return `- speakerLabel: ${label}; nodeId: ${entry.nodeId}; role: ${role}`;
  });
  return `Speakers in this transcript:
For each claim, set "assertedBySpeakerLabel" to the speaker who said it, using these labels exactly. Claims whose speaker label is missing or not in this list will be dropped.
When a speaker states a fact about themselves (first-person "I…/my…"), use that speaker's nodeId above as the claim's subjectId — do NOT mint a new node for a speaker already listed here. In particular, attribute the user-self speaker's self-statements to their nodeId, never to a newly created same-named node.
${lines.join("\n")}`;
}
```

- [ ] **Step 3: Demonstrate subject-wiring in the static transcript few-shot**

Find:
```ts
- Speaker "Alice" (user-self) says "I shipped the spec." → assertionKind: "user", assertedBySpeakerLabel: "Alice".
```
Replace with:
```ts
- Speaker "Alice" (user-self) says "I live in Lisbon." → create the (LIVES_IN, Lisbon) claim with subjectId set to Alice's nodeId from "Speakers in this transcript" (do NOT mint a new "Alice" node), assertionKind: "user", assertedBySpeakerLabel: "Alice".
```

- [ ] **Step 4: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 5: Regression — existing transcript tests still pass**

Run: `pnpm run test -- run src/lib/jobs/ingest-transcript.test.ts`
Expected: PASS. (Existing stubs reference minted node ids, not speaker ids, so they are unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/extract-graph.ts
git commit -m "✨ feat(transcript): wire user-self speaker as claim subject in extraction"
```

---

## Task 8: Component 2 — transcript subject-wiring integration test

**Files:**
- Modify: `src/lib/jobs/ingest-transcript.test.ts`

- [ ] **Step 1: Add the integration test**

Insert this `it(...)` block inside the `describeIfServer("ingestTranscript", () => { ... })` block, after the last existing `it(...)` (i.e. just before the closing `});` of the describe at the end of the file):

```ts
  it("attributes a user-self first-person claim to the self node, not a same-named participant", async () => {
    const userId = "user_transcript_subject";
    const transcriptId = "trans_subject_1";
    const occurredAt = new Date("2026-05-01T10:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    // Captured so the LLM stub can emit the real self node id as subjectId.
    let selfNodeIdForStub = "";

    applyCommonMocks(database);
    vi.doMock("../ai", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../ai")>()),
      createCompletionClient: async () => ({
        chat: {
          completions: {
            parse: async () => ({
              choices: [
                {
                  message: {
                    parsed: {
                      nodes: [
                        { id: "loc_1", type: "Location", label: "Lisbon" },
                      ],
                      relationshipClaims: [
                        {
                          subjectId: selfNodeIdForStub,
                          objectId: "loc_1",
                          predicate: "LIVES_IN",
                          statement: "Marcel lives in Lisbon.",
                          sourceRef: `${transcriptId}:0`,
                          assertionKind: "user",
                          assertedBySpeakerLabel: "Marcel",
                        },
                      ],
                      attributeClaims: [],
                      aliases: [],
                    },
                  },
                },
              ],
            }),
          },
        },
      }),
    }));

    try {
      await createTranscriptTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      // A different, same-first-name person already in the graph.
      const otherMarcelId = newTypeId("node");
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [otherMarcelId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Marcel', 'marcel')`,
        [newTypeId("node_metadata"), otherMarcelId],
      );

      const { ensureUserSelfIdentity } = await import("../user-self-identity");
      const selfNodeId = await ensureUserSelfIdentity(database, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);
      selfNodeIdForStub = selfNodeId;

      const { ingestTranscript } = await import("./ingest-transcript");
      await ingestTranscript({
        db: database,
        userId,
        transcriptId,
        scope: "personal",
        occurredAt,
        content: {
          kind: "segmented",
          utterances: [
            { speakerLabel: "Marcel", content: "I live in Lisbon now." },
          ],
        },
        userSelfAliasesOverride: ["Marcel", "Marcel Samyn"],
      });

      const livesIn = await client.query<{
        subject_node_id: string;
        asserted_by_kind: string;
      }>(
        `SELECT subject_node_id, asserted_by_kind FROM claims WHERE user_id = $1 AND predicate = 'LIVES_IN'`,
        [userId],
      );
      expect(livesIn.rows).toHaveLength(1);
      expect(livesIn.rows[0]?.subject_node_id).toBe(selfNodeId);
      expect(livesIn.rows[0]?.subject_node_id).not.toBe(otherMarcelId);
      expect(livesIn.rows[0]?.asserted_by_kind).toBe("user");
    } finally {
      unmockCommon();
      await client.end();
    }
  });
```

- [ ] **Step 2: Run the transcript tests**

Run: `pnpm run test -- run src/lib/jobs/ingest-transcript.test.ts`
Expected: PASS (all existing + the new subject-wiring test).

- [ ] **Step 3: Commit**

```bash
git add src/lib/jobs/ingest-transcript.test.ts
git commit -m "✅ test(transcript): user-self first-person claim attaches to self node"
```

---

## Task 9: Component 3 — resolver never guesses on a tie

**Files:**
- Modify: `src/lib/identity-resolution.ts`
- Modify: `src/lib/identity-resolution.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Insert these two `it(...)` blocks inside the `describeIfServer("resolveIdentity", () => { ... })` block in `src/lib/identity-resolution.test.ts`, after the last existing `it(...)` (just before the describe's closing `});`):

```ts
  it("signal 1 — multiple same-scope canonical matches do not resolve (ambiguous)", async () => {
    await withDb(async (client) => {
      const userId = "user_ambiguous";
      const marcelA = newTypeId("node");
      const marcelB = newTypeId("node");
      const sourceId = newTypeId("source");
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$2,'document','p1','personal')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type")
           VALUES ($1,$3,'Person'),($2,$3,'Person')`,
        [marcelA, marcelB, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$3,'Marcel','marcel'),($2,$4,'Marcel','marcel')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          marcelA,
          marcelB,
        ],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id")
           VALUES ($1,$3,$4),($2,$3,$5)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          sourceId,
          marcelA,
          marcelB,
        ],
      );

      const { resolveIdentity } = await import("./identity-resolution");
      const { setLogSink } = await import("~/lib/observability/log");
      const captured: Array<Record<string, unknown>> = [];
      setLogSink((event) => captured.push(event));
      try {
        const resolution = await resolveIdentity({
          userId,
          candidate: {
            proposedLabel: "Marcel",
            normalizedLabel: "marcel",
            nodeType: "Person",
            scope: "personal",
          },
        });
        expect(resolution.resolvedNodeId).toBeNull();
        expect(resolution.decision.signal).toBe("none");
        const canonical = resolution.decision.trace.find(
          (t) => t.signal === "canonical_label",
        );
        expect(canonical?.fired).toBe(true);
        expect(canonical?.candidates).toHaveLength(2);
        expect(
          canonical?.signal === "canonical_label" && canonical.ambiguous,
        ).toMatchObject({
          candidateNodeIds: expect.arrayContaining([marcelA, marcelB]),
        });
        const skip = captured.find(
          (e) => e["event"] === "identity.ambiguous_skip",
        );
        expect(skip).toMatchObject({
          event: "identity.ambiguous_skip",
          userId,
          normalizedLabel: "marcel",
          signal: "canonical_label",
          candidateCount: 2,
        });
      } finally {
        setLogSink();
      }
    });
  });

  it("self resolves by full name; a bare same-first-name does not merge into self", async () => {
    await withDb(async (client) => {
      const userId = "user_self_fullname";
      await createIdentityTables(client);
      await client.query(`INSERT INTO "users"("id") VALUES ($1)`, [userId]);

      const { useDatabase } = await import("~/utils/db");
      const db = await useDatabase();
      const { ensureUserSelfIdentity } = await import("./user-self-identity");
      const selfNodeId = await ensureUserSelfIdentity(db, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);

      // A separate third-party "Marcel" with personal-scope support.
      const otherMarcel = newTypeId("node");
      const sourceId = newTypeId("source");
      await client.query(
        `INSERT INTO "sources"("id","user_id","type","external_id","scope")
           VALUES ($1,$2,'document','d1','personal')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes"("id","user_id","node_type") VALUES ($1,$2,'Person')`,
        [otherMarcel, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata"("id","node_id","label","canonical_label")
           VALUES ($1,$2,'Marcel','marcel')`,
        [newTypeId("node_metadata"), otherMarcel],
      );
      await client.query(
        `INSERT INTO "source_links"("id","source_id","node_id") VALUES ($1,$2,$3)`,
        [newTypeId("source_link"), sourceId, otherMarcel],
      );

      const { resolveIdentity } = await import("./identity-resolution");

      const full = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Marcel Samyn",
          normalizedLabel: "marcel samyn",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(full.resolvedNodeId).toBe(selfNodeId);

      const bare = await resolveIdentity({
        userId,
        candidate: {
          proposedLabel: "Marcel",
          normalizedLabel: "marcel",
          nodeType: "Person",
          scope: "personal",
        },
      });
      expect(bare.resolvedNodeId).toBe(otherMarcel);
      expect(bare.resolvedNodeId).not.toBe(selfNodeId);
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run test -- run src/lib/identity-resolution.test.ts`
Expected: FAIL — the ambiguous test currently resolves to `candidates[0]` (non-null) and there is no `ambiguous` field / `identity.ambiguous_skip` event yet.

- [ ] **Step 3: Add the `ambiguous` field to the exact-match trace variants**

In `src/lib/identity-resolution.ts`, find:
```ts
  | {
      signal: "canonical_label";
      fired: boolean;
      candidates: SignalCandidate[];
      /** Set when a same-label match exists in a different scope. */
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
    }
  | {
      signal: "alias";
      fired: boolean;
      candidates: SignalCandidate[];
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
    }
```
Replace with:
```ts
  | {
      signal: "canonical_label";
      fired: boolean;
      candidates: SignalCandidate[];
      /** Set when a same-label match exists in a different scope. */
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
      /** Set when >1 same-scope/type candidate matched; resolver refuses to guess. */
      ambiguous?: { candidateNodeIds: TypeId<"node">[] };
    }
  | {
      signal: "alias";
      fired: boolean;
      candidates: SignalCandidate[];
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
      /** Set when >1 same-scope/type candidate matched; resolver refuses to guess. */
      ambiguous?: { candidateNodeIds: TypeId<"node">[] };
    }
```

- [ ] **Step 4: Resolve only on a unique canonical match**

Find:
```ts
  if (canonicalTrace.signal === "canonical_label" && canonicalTrace.fired) {
    const winner = canonicalTrace.candidates[0];
    if (winner) {
      return _resolved(
        winner.nodeId,
        "canonical_label",
        winner.score,
        trace,
        candidate,
        userId,
      );
    }
  }
```
Replace with:
```ts
  if (canonicalTrace.signal === "canonical_label" && canonicalTrace.fired) {
    if (canonicalTrace.candidates.length === 1) {
      const winner = canonicalTrace.candidates[0]!;
      return _resolved(
        winner.nodeId,
        "canonical_label",
        winner.score,
        trace,
        candidate,
        userId,
      );
    }
    // More than one same-scope/type candidate: do not guess. Record the
    // ambiguity, log it, and fall through to later (more discriminating)
    // signals; at extraction time those are absent, so the caller splits.
    canonicalTrace.ambiguous = {
      candidateNodeIds: canonicalTrace.candidates.map((c) => c.nodeId),
    };
    _logAmbiguousSkip(
      userId,
      candidate,
      "canonical_label",
      canonicalTrace.candidates,
    );
  }
```

- [ ] **Step 5: Resolve only on a unique alias match**

Find:
```ts
  if (aliasTrace.signal === "alias" && aliasTrace.fired) {
    const winner = aliasTrace.candidates[0];
    if (winner) {
      return _resolved(
        winner.nodeId,
        "alias",
        winner.score,
        trace,
        candidate,
        userId,
      );
    }
  }
```
Replace with:
```ts
  if (aliasTrace.signal === "alias" && aliasTrace.fired) {
    if (aliasTrace.candidates.length === 1) {
      const winner = aliasTrace.candidates[0]!;
      return _resolved(
        winner.nodeId,
        "alias",
        winner.score,
        trace,
        candidate,
        userId,
      );
    }
    aliasTrace.ambiguous = {
      candidateNodeIds: aliasTrace.candidates.map((c) => c.nodeId),
    };
    _logAmbiguousSkip(userId, candidate, "alias", aliasTrace.candidates);
  }
```

- [ ] **Step 6: Add the `_logAmbiguousSkip` helper**

In `src/lib/identity-resolution.ts`, find the start of `_logCrossScopeRefusal`:
```ts
function _logCrossScopeRefusal(
```
Insert this function immediately ABOVE it:
```ts
function _logAmbiguousSkip(
  userId: string,
  candidate: IdentityCandidate,
  signal: "canonical_label" | "alias",
  candidates: SignalCandidate[],
): void {
  logEvent("identity.ambiguous_skip", {
    userId,
    candidateLabel: candidate.proposedLabel,
    normalizedLabel: candidate.normalizedLabel,
    nodeType: candidate.nodeType,
    scope: candidate.scope,
    signal,
    candidateNodeIds: candidates.map((c) => c.nodeId),
    candidateCount: candidates.length,
  });
}

```

- [ ] **Step 7: Run the resolver tests + full identity suite**

Run: `pnpm run test -- run src/lib/identity-resolution.test.ts`
Expected: PASS (existing single-match + cross-scope tests still pass; the two new tests pass).

- [ ] **Step 8: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/identity-resolution.ts src/lib/identity-resolution.test.ts
git commit -m "✨ feat(identity): unique-match-wins resolver + identity.ambiguous_skip"
```

---

## Task 10: Component 4 — `userIdentityNote` param + render + static rule

**Files:**
- Modify: `src/lib/extract-graph.ts`

- [ ] **Step 1: Add the param to `ExtractGraphParams`**

Find:
```ts
  contentNote?: string;
  /**
   * Debug hook fired exactly once after the LLM call returns, before
```
Replace with:
```ts
  contentNote?: string;
  /**
   * Optional "who the user is" note (primary name + aliases) injected into the
   * trailing user message so the model emits the user's most specific label
   * and never conflates a same-named other person with the user. Used by
   * document and conversation ingestion (transcripts use the speaker map
   * instead). Cache-safe: lives in the dynamic user message, not the system
   * prompt.
   */
  userIdentityNote?: string;
  /**
   * Debug hook fired exactly once after the LLM call returns, before
```

- [ ] **Step 2: Destructure it**

Find:
```ts
  content,
  speakerMap,
  replaceClaimsForSources = true,
  contentNote,
  onLlmIO,
}: ExtractGraphParams) {
```
Replace with:
```ts
  content,
  speakerMap,
  replaceClaimsForSources = true,
  contentNote,
  userIdentityNote,
  onLlmIO,
}: ExtractGraphParams) {
```

- [ ] **Step 3: Build the render section alongside the others**

Find:
```ts
  const speakerMapPromptSection = _formatSpeakerMapSection(speakerMap);
```
Replace with:
```ts
  const speakerMapPromptSection = _formatSpeakerMapSection(speakerMap);

  const userIdentityPromptSection = userIdentityNote
    ? `${userIdentityNote}\n\n`
    : "";
```

- [ ] **Step 4: Inject the section into the user message**

Find:
```ts
${speakerMapPromptSection}

Extract the graph from the following ${sourceType}:
```
Replace with:
```ts
${speakerMapPromptSection}

${userIdentityPromptSection}Extract the graph from the following ${sourceType}:
```

- [ ] **Step 5: Add the static anti-conflation rule**

Find:
```ts
- In node names use full names, eg. "John Doe" instead of "John"
```
Replace with:
```ts
- In node names use full names, eg. "John Doe" instead of "John"
- If multiple people could share a name, use the most specific distinguishing label available (e.g. a full name) and NEVER merge or conflate two different people who share a first name.
```

- [ ] **Step 6: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/extract-graph.ts
git commit -m "✨ feat(extraction): userIdentityNote injection + anti-conflation rule"
```

---

## Task 11: Component 4 — wire conversation + document paths

**Files:**
- Modify: `src/lib/jobs/ingest-conversation.ts`
- Modify: `src/lib/ingestion/extract-document-graph.ts`
- Modify: `src/lib/ingestion/chunked-extract.ts`

- [ ] **Step 1: Conversation — imports**

In `src/lib/jobs/ingest-conversation.ts`, find:
```ts
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";
```
Replace with:
```ts
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { getUserSelfAliases } from "~/lib/user-profile";
import { buildUserIdentityNote } from "~/lib/user-self-identity";
```

- [ ] **Step 2: Conversation — build + pass the note**

Find:
```ts
  await extractGraph({
    userId,
    sourceType: "conversation",
    sourceId,
    statedAt: firstTurn.timestamp,
    linkedNodeId: conversationNodeId,
    sourceRefs,
    content: formatConversationAsXml(insertedTurns),
  });
```
Replace with:
```ts
  const userIdentityNote = buildUserIdentityNote(
    await getUserSelfAliases(db, userId),
  );
  await extractGraph({
    userId,
    sourceType: "conversation",
    sourceId,
    statedAt: firstTurn.timestamp,
    linkedNodeId: conversationNodeId,
    sourceRefs,
    content: formatConversationAsXml(insertedTurns),
    ...(userIdentityNote ? { userIdentityNote } : {}),
  });
```

- [ ] **Step 3: Document — imports**

In `src/lib/ingestion/extract-document-graph.ts`, find:
```ts
import { runChunkedExtraction } from "./chunked-extract";
import { ensureSourceNode } from "./ensure-source-node";
import { DrizzleDB } from "~/db";
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";
```
Replace with:
```ts
import { runChunkedExtraction } from "./chunked-extract";
import { ensureSourceNode } from "./ensure-source-node";
import { DrizzleDB } from "~/db";
import { getUserSelfAliases } from "~/lib/user-profile";
import { buildUserIdentityNote } from "~/lib/user-self-identity";
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";
```

- [ ] **Step 4: Document — build + pass the note**

Find:
```ts
  const linkedNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId,
    timestamp,
    nodeType: NodeTypeEnum.enum.Document,
  });

  await runChunkedExtraction({
    userId,
    sourceType: "document",
    sourceId,
    statedAt: timestamp,
    linkedNodeId,
    sourceRefs: [{ externalId, sourceId, statedAt: timestamp }],
    content,
    logLabel,
    documentMetadata: {
      ...(title !== undefined && { title }),
      ...(author !== undefined && { author }),
    },
  });
```
Replace with:
```ts
  const linkedNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId,
    timestamp,
    nodeType: NodeTypeEnum.enum.Document,
  });

  const userIdentityNote = buildUserIdentityNote(
    await getUserSelfAliases(db, userId),
  );

  await runChunkedExtraction({
    userId,
    sourceType: "document",
    sourceId,
    statedAt: timestamp,
    linkedNodeId,
    sourceRefs: [{ externalId, sourceId, statedAt: timestamp }],
    content,
    logLabel,
    documentMetadata: {
      ...(title !== undefined && { title }),
      ...(author !== undefined && { author }),
    },
    ...(userIdentityNote ? { userIdentityNote } : {}),
  });
```

- [ ] **Step 5: Chunked-extract — add param to the interface**

In `src/lib/ingestion/chunked-extract.ts`, find:
```ts
  documentMetadata?: {
    title?: string;
    author?: string;
  };
}
```
Replace with:
```ts
  documentMetadata?: {
    title?: string;
    author?: string;
  };
  /**
   * "Who the user is" note forwarded verbatim to every chunk's `extractGraph`
   * call so per-fragment extraction resolves the user's name correctly.
   */
  userIdentityNote?: string;
}
```

- [ ] **Step 6: Chunked-extract — destructure + forward to every chunk**

Find:
```ts
  const {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
    content,
    logLabel,
    documentMetadata,
  } = params;
```
Replace with:
```ts
  const {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
    content,
    logLabel,
    documentMetadata,
    userIdentityNote,
  } = params;
```

Then find:
```ts
  const baseExtractParams = {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
  };
```
Replace with:
```ts
  const baseExtractParams = {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
    ...(userIdentityNote ? { userIdentityNote } : {}),
  };
```

- [ ] **Step 7: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/jobs/ingest-conversation.ts src/lib/ingestion/extract-document-graph.ts src/lib/ingestion/chunked-extract.ts
git commit -m "✨ feat(extraction): inject user identity into document + conversation prompts"
```

---

## Task 12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + structured-output schema check**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `pnpm run lint`
Expected: PASS (no errors). Fix any unused-import warnings introduced (most likely the removed `sql` in `resolve-speakers.ts` — already handled in Task 2).

- [ ] **Step 3: Format**

Run: `pnpm run format`
Expected: PASS. If it reports formatting diffs, run `pnpm run format:fix` and re-commit the touched files.

- [ ] **Step 4: Run the full affected test set (DB on :5431)**

Run:
```bash
pnpm run test -- run \
  src/lib/user-self-identity.test.ts \
  src/lib/transcript/resolve-speakers.test.ts \
  src/lib/jobs/ingest-transcript.test.ts \
  src/lib/identity-resolution.test.ts
```
Expected: all PASS. (Start Postgres first if needed: `docker compose up -d db`.)

- [ ] **Step 5: Final commit (only if format:fix or lint:fix changed files)**

```bash
git add -p
git commit -m "🎨 style(identity): lint/format cleanup"
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task(s) |
| --- | --- |
| C1 primary label = longest/most-token alias | Task 1 (`selectPrimarySelfLabel`) |
| C1 `ensureUserSelfIdentity` from both call sites (config + transcript, effective aliases) | Tasks 3, 4 |
| C1 keep single-token aliases out of the alias table | Task 1 (`distinguishingAliases`) |
| C1 stop writing bare self alias in `resolveSpeakers` | Task 2 |
| C1 backfill maintenance route | Task 6 |
| C2 register speaker nodes into `idMap` unconditionally | Task 7 (Step 1) |
| C2 surface user-self as "you" + subject-wiring in prompt | Task 7 (Steps 2–3) |
| C2 caching contract preserved (dynamic stays in user message) | Task 7 (speaker section) + Task 10 (note in user message) |
| C3 unique-match-wins; >1 → split + `identity.ambiguous_skip` | Task 9 |
| C3 no blunt self-prior | Confirmed: no self-preference added to the resolver anywhere |
| C4 inject identity into document + conversation prompts | Tasks 10, 11 |
| C4 instruct most-specific labels / no conflation | Task 10 (Step 5, static rule) |
| Testing: resolver ambiguity/unique/cross-scope | Task 9 |
| Testing: self hygiene seeds only multi-token; no bare alias | Tasks 5, 2 |
| Testing: transcript self-utterance attaches to self with same-named participant present | Task 8 |
| Testing: document "Marcel Samyn" → self; bare "Marcel" ↛ self | Task 9 (Step 1, second test) |

**2. Deliberate deviation from the spec (flagged):** the spec's "Testing (Integration document)" and "extend eval story 10" are delivered as **vitest integration/unit tests** (Task 8 transcript, Task 9 document-case) rather than as `src/evals/memory/stories/*` fixtures. Rationale: the vitest tests run against real Postgres and assert the exact subject/resolution behavior directly, giving equivalent coverage without the eval-harness stub plumbing; an eval-story extension can be added later if the probe harness needs it. No spec *behavior* is left unverified.

**3. Placeholder scan:** none — every code step contains complete copy-pasteable content; every test step contains full assertions.

**4. Type consistency:** `ensureUserSelfIdentity(db, userId, aliases) → Promise<TypeId<"node">>` and `ensureUserSelfPersonNode(db, userId) → Promise<TypeId<"node">>` are used consistently across Tasks 1–6, 8, 9. `buildUserIdentityNote(aliases) → string | null` and the `...(userIdentityNote ? { userIdentityNote } : {})` spread (for `exactOptionalPropertyTypes`) are used consistently in Tasks 10–11. The `ambiguous?: { candidateNodeIds: TypeId<"node">[] }` field name matches between the type addition (Task 9 Step 3) and the writes (Steps 4–5) and the test assertion (Step 1). The new log event name `identity.ambiguous_skip` matches between emitter (Step 6) and test (Step 1).

**5. Open questions (resolved per the approved defaults):** self tiebreak → always split (no resolver self-prior); primary label → longest multi-token alias; live-graph confirmation → proceeding on the code-grounded diagnosis.
