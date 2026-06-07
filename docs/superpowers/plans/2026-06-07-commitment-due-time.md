# Commitment Due Time + Timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a commitment's due date an optional time-of-day + IANA timezone, stored as human truth (`{ dueTime, timeZone }` in the `DUE_ON` claim's `metadata`) plus a derived, indexed UTC instant (`claims.object_instant`), surfaced on every read model and queryable at instant precision.

**Architecture:** The `DUE_ON` claim keeps pointing at the shared `YYYY-MM-DD` day node (date unchanged). Time + zone live in `claims.metadata` (jsonb, previously unused); the resolved UTC instant lives in a new nullable `claims.object_instant` column with a partial index. Time is optional and fully backward-compatible — absent ⇒ today's date-only behavior, no data backfill. All additions are additive.

**Tech Stack:** TypeScript (strict), Zod v4, Drizzle ORM + Postgres, Nitro routes, Vitest against a real Postgres on `:5431`. Timezone math uses the repo's own `Intl`-based helper (no `date-fns-tz`).

**Reference spec:** `docs/superpowers/specs/2026-06-07-commitment-due-time-design.md`

---

## Conventions used in every test in this repo

- Tests connect to a real Postgres on `localhost:5431` (override via `TEST_PG_*`). CI does **not** run vitest — run locally.
- Each suite creates a throwaway database, hand-provisions tables with a local `provisionSchema`/inline `CREATE TABLE`, and mocks `~/utils/db` to return a Drizzle client bound to that DB.
- `setSkipEmbeddingPersistence(true)` short-circuits Jina embedding calls.
- Run a single file: `pnpm run test -- src/path/to/file.test.ts`
- Run the whole suite: `pnpm run test`
- Typecheck + structured-output check: `pnpm run build:check`
- Lint / format: `pnpm run lint` / `pnpm run format`

> **Important — `object_instant` provisioning:** After Task 6, the open-commitments and list read queries `SELECT` `dueClaim.object_instant` **and** `dueClaim.metadata`. Any test whose provisioned `claims` table lacks either column will fail with `column "object_instant" does not exist` (or `metadata`). Tasks 6–9 update the directly-affected files; **Task 12 runs the full suite and fixes any stragglers** — the error names the exact missing column, so this is deterministic.

---

## Task 1: Add `object_instant` column + partial index (schema & migration)

**Files:**

- Modify: `src/db/schema.ts` (claims table, ~`src/db/schema.ts:107-146` and the index block `:147-221`)
- Create: `drizzle/0018_*.sql` (generated) + `drizzle/meta/*` (generated)

- [ ] **Step 1: Add the column to the `claims` table definition**

In `src/db/schema.ts`, inside the `claims` `pgTable` columns, add `objectInstant` immediately after the `metadata: jsonb(),` line (around line 111):

```ts
    metadata: jsonb(),
    /**
     * Resolved UTC instant of a time-qualified temporal-object claim — currently
     * a `DUE_ON` whose `metadata` carries a wall-clock `dueTime` + IANA `timeZone`.
     * NULL for date-only and non-temporal claims. Denormalized from
     * (day-node date, dueTime, timeZone) for indexed instant-range queries.
     */
    objectInstant: timestamp("object_instant", { withTimezone: true }),
```

- [ ] **Step 2: Add the partial index**

In the same table's index array (the `(table) => [ ... ]` block), add after `claims_task_metadata_lookup_idx` (around line 206):

```ts
    index("claims_due_instant_idx")
      .on(table.userId, table.objectInstant)
      .where(
        sql`${table.predicate} = 'DUE_ON' AND ${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.objectInstant} IS NOT NULL`,
      ),
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm run drizzle:generate`
Expected: a new `drizzle/0018_<random-name>.sql` is created, `drizzle/meta/_journal.json` gains an `idx: 18` entry, and a new snapshot appears. No DB connection is needed for `generate`.

- [ ] **Step 4: Verify the generated SQL**

Run: `cat drizzle/0018_*.sql`
Expected: it contains an `ALTER TABLE "claims" ADD COLUMN "object_instant" timestamp with time zone;` and a `CREATE INDEX ... "claims_due_instant_idx" ... WHERE ...` matching the predicate above. If the index predicate is missing, hand-edit the generated file to add the `WHERE` clause exactly as in Step 2.

- [ ] **Step 5: Typecheck**

Run: `pnpm run build:check`
Expected: PASS (no type errors).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "✨ feat(claims): add object_instant column + partial index for due times"
```

---

## Task 2: Promote the timezone helper and add `instantFromLocalTime`

**Files:**

- Create: `src/lib/time-zone.ts` (moved from `src/lib/digest/time-zone.ts`)
- Delete: `src/lib/digest/time-zone.ts`
- Modify: `src/lib/digest/get-digest.ts:10` (import path), `src/lib/schemas/digest.ts:11` (import path)
- Create: `src/lib/time-zone.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/time-zone.test.ts`:

```ts
import {
  instantFromLocalTime,
  startOfDayInTimeZone,
  isValidTimeZone,
} from "./time-zone";
import { describe, expect, it } from "vitest";

describe("instantFromLocalTime", () => {
  it("resolves a winter (standard-offset) wall-clock time", () => {
    // America/New_York is UTC-5 (EST) in January.
    expect(
      instantFromLocalTime(
        "2026-01-15",
        "09:00",
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-01-15T14:00:00.000Z");
  });

  it("resolves a summer (DST-offset) wall-clock time", () => {
    // America/New_York is UTC-4 (EDT) in July.
    expect(
      instantFromLocalTime(
        "2026-07-15",
        "09:00",
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-07-15T13:00:00.000Z");
  });

  it("resolves a half-hour offset zone", () => {
    // Asia/Kolkata is UTC+5:30 year-round.
    expect(
      instantFromLocalTime("2026-03-01", "09:00", "Asia/Kolkata").toISOString(),
    ).toBe("2026-03-01T03:30:00.000Z");
  });

  it("round-trips: formatting the instant back in the zone reproduces the input", () => {
    const tz = "Europe/Paris";
    const instant = instantFromLocalTime("2026-06-10", "17:30", tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    expect(`${get("year")}-${get("month")}-${get("day")}`).toBe("2026-06-10");
    expect(`${get("hour")}:${get("minute")}`).toBe("17:30");
  });

  it("is deterministic on a spring-forward non-existent local time", () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00→03:00).
    const a = instantFromLocalTime("2026-03-08", "02:30", "America/New_York");
    const b = instantFromLocalTime("2026-03-08", "02:30", "America/New_York");
    expect(Number.isNaN(a.getTime())).toBe(false);
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("startOfDayInTimeZone equals instantFromLocalTime at 00:00", () => {
    expect(
      startOfDayInTimeZone("2026-07-15", "America/New_York").toISOString(),
    ).toBe(
      instantFromLocalTime(
        "2026-07-15",
        "00:00",
        "America/New_York",
      ).toISOString(),
    );
  });

  it("validates IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/time-zone.test.ts`
Expected: FAIL — cannot resolve `./time-zone` (module does not exist yet).

- [ ] **Step 3: Move the helper and add `instantFromLocalTime`**

Move `src/lib/digest/time-zone.ts` → `src/lib/time-zone.ts`. Update the file's top doc comment to drop the digest-specific framing, keep `isValidTimeZone` and `zoneOffsetMs` unchanged, and replace `startOfDayInTimeZone` with the generalized pair:

```ts
/** UTC instant for `time` (HH:mm) local on `date` (YYYY-MM-DD) in `timeZone`. */
export function instantFromLocalTime(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0);
  const offset = zoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

/** UTC instant for 00:00:00 local time on `date` (YYYY-MM-DD) in `timeZone`. */
export function startOfDayInTimeZone(date: string, timeZone: string): Date {
  return instantFromLocalTime(date, "00:00", timeZone);
}
```

- [ ] **Step 4: Update the two importers**

In `src/lib/digest/get-digest.ts` change `import { startOfDayInTimeZone } from "./time-zone";` to `import { startOfDayInTimeZone } from "~/lib/time-zone";`.

In `src/lib/schemas/digest.ts` change `import { isValidTimeZone } from "~/lib/digest/time-zone.js";` to `import { isValidTimeZone } from "~/lib/time-zone.js";`.

- [ ] **Step 5: Confirm no other importers remain**

Run: `grep -rn "digest/time-zone" src`
Expected: no output.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/time-zone.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/time-zone.ts src/lib/time-zone.test.ts src/lib/digest/get-digest.ts src/lib/schemas/digest.ts
git rm src/lib/digest/time-zone.ts
git commit -m "♻️ refactor(time-zone): promote helper to lib + add instantFromLocalTime"
```

---

## Task 3: Shared `DUE_ON` metadata schema

**Files:**

- Create: `src/lib/schemas/due-claim-metadata.ts`
- Create: `src/lib/schemas/due-claim-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/schemas/due-claim-metadata.test.ts`:

```ts
import { dueClaimMetadataSchema, DUE_TIME_PATTERN } from "./due-claim-metadata";
import { describe, expect, it } from "vitest";

describe("dueClaimMetadataSchema", () => {
  it("accepts a valid HH:mm + IANA zone", () => {
    const parsed = dueClaimMetadataSchema.parse({
      dueTime: "17:00",
      timeZone: "America/New_York",
    });
    expect(parsed).toEqual({ dueTime: "17:00", timeZone: "America/New_York" });
  });

  it("rejects a bad time", () => {
    expect(
      dueClaimMetadataSchema.safeParse({ dueTime: "25:00", timeZone: "UTC" })
        .success,
    ).toBe(false);
    expect(
      dueClaimMetadataSchema.safeParse({ dueTime: "9:5", timeZone: "UTC" })
        .success,
    ).toBe(false);
  });

  it("rejects a bad zone", () => {
    expect(
      dueClaimMetadataSchema.safeParse({
        dueTime: "09:00",
        timeZone: "Not/AZone",
      }).success,
    ).toBe(false);
  });

  it("DUE_TIME_PATTERN matches 24h HH:mm only", () => {
    expect(DUE_TIME_PATTERN.test("00:00")).toBe(true);
    expect(DUE_TIME_PATTERN.test("23:59")).toBe(true);
    expect(DUE_TIME_PATTERN.test("24:00")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/schemas/due-claim-metadata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schema**

Create `src/lib/schemas/due-claim-metadata.ts`:

```ts
import { z } from "zod";
import { isValidTimeZone } from "~/lib/time-zone.js";

/** 24-hour wall-clock time, `HH:mm`. Common aliases: due time, time of day. */
export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Shape of a time-qualified `DUE_ON` claim's `metadata` jsonb: the canonical
 * human truth (local wall-clock time + IANA zone). The resolved UTC instant is
 * stored separately in `claims.object_instant`. Parsed defensively on read; a
 * claim with absent/invalid metadata is treated as date-only.
 */
export const dueClaimMetadataSchema = z.object({
  dueTime: z.string().regex(DUE_TIME_PATTERN, "dueTime must be HH:mm"),
  timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone"),
});

export type DueClaimMetadata = z.infer<typeof dueClaimMetadataSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/schemas/due-claim-metadata.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/due-claim-metadata.ts src/lib/schemas/due-claim-metadata.test.ts
git commit -m "✨ feat(commitments): add DUE_ON claim metadata schema (dueTime + timeZone)"
```

---

## Task 4: Thread `metadata` + `objectInstant` through `createClaim` and `createNode`

**Files:**

- Modify: `src/lib/claim.ts` (`CreateClaimInput` `:73-104`, insert `:201-220`)
- Modify: `src/lib/node.ts` (`CreateNodeInitialClaimInput` `:401-409`, initial-claims loop `:490-503`)
- Modify: `src/lib/claim.test.ts` (provisioning + new test)

- [ ] **Step 1: Write the failing test**

In `src/lib/claim.test.ts`, first ensure the provisioned `claims` table has the new column: find the `CREATE TABLE`/`CREATE TABLE IF NOT EXISTS "claims"` block and add `"object_instant" timestamp with time zone,` immediately after the `"metadata" jsonb,` line.

Then add this test inside the existing top-level `describeIfServer(...)` for createClaim (mirror the file's existing setup: a fresh DB, `vi.doMock("~/utils/db", ...)`, `setSkipEmbeddingPersistence(true)`). Use the file's existing helpers for DB/user setup; the assertion body is:

```ts
it("persists metadata and objectInstant when provided", async () => {
  // ... file's standard per-test DB + user + a subject node setup ...
  const { createClaim } = await import("./claim");
  const subjectId = newTypeId("node");
  await client.query(
    `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Entity')`,
    [subjectId, userId],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id","node_id","label","canonical_label") VALUES ($1,$2,'Subj','subj')`,
    [newTypeId("node_metadata"), subjectId],
  );

  const created = await createClaim({
    userId,
    subjectNodeId: subjectId,
    predicate: "DUE_ON",
    statement: "test due",
    objectValue: "2026-06-10", // any object; XOR satisfied
    metadata: { dueTime: "17:00", timeZone: "America/New_York" },
    objectInstant: new Date("2026-06-10T21:00:00.000Z"),
  });

  const { rows } = await client.query(
    `SELECT metadata, object_instant FROM claims WHERE id = $1`,
    [created.id],
  );
  expect(rows[0].metadata).toEqual({
    dueTime: "17:00",
    timeZone: "America/New_York",
  });
  expect(new Date(rows[0].object_instant).toISOString()).toBe(
    "2026-06-10T21:00:00.000Z",
  );
});
```

> Note: match this file's exact per-test boilerplate (it varies slightly across the repo). Reuse whatever `provisionSchema`/client/mocking pattern the surrounding tests in `claim.test.ts` already use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/claim.test.ts -t "persists metadata and objectInstant"`
Expected: FAIL — `createClaim` ignores `metadata`/`objectInstant` (unknown option / not persisted), so the assertion on the row fails (or TS errors that the options don't exist).

- [ ] **Step 3: Extend `CreateClaimInput`**

In `src/lib/claim.ts`, add to the `CreateClaimInput` type (after `scope?`):

```ts
  /**
   * Optional jsonb payload stored on the claim. Used for predicate-specific
   * qualifiers (e.g. a `DUE_ON` claim's `{ dueTime, timeZone }`). Opaque here —
   * callers own the shape and validate it at their boundary.
   */
  metadata?: Record<string, unknown> | undefined;
  /**
   * Optional resolved UTC instant for a time-qualified temporal-object claim
   * (persisted to `claims.object_instant`). NULL/undefined for date-only claims.
   */
  objectInstant?: Date | undefined;
```

- [ ] **Step 4: Persist them in the insert**

In `createClaim`'s `db.insert(claims).values({ ... })` (around `:203`), add after `description: input.description,`:

```ts
      metadata: input.metadata,
      objectInstant: input.objectInstant,
```

- [ ] **Step 5: Extend `createNode`'s initial-claim passthrough**

In `src/lib/node.ts`, add to `CreateNodeInitialClaimInput` (after `assertedByNodeId?`):

```ts
  metadata?: Record<string, unknown> | undefined;
  objectInstant?: Date | undefined;
```

Then in the `for (const claim of initialClaims)` loop's `createClaim({ ... })` call (around `:491`), add after `assertedByNodeId: claim.assertedByNodeId,`:

```ts
          metadata: claim.metadata,
          objectInstant: claim.objectInstant,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/claim.test.ts -t "persists metadata and objectInstant"`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/claim.ts src/lib/node.ts src/lib/claim.test.ts
git commit -m "✨ feat(claim): persist claim metadata + objectInstant via createClaim/createNode"
```

---

## Task 5: Write path — `dueTime` + `timeZone` on `setCommitmentDue` and `createCommitment`

**Files:**

- Modify: `src/lib/schemas/set-commitment-due.ts`
- Modify: `src/lib/schemas/create-commitment.ts`
- Modify: `src/lib/commitments.ts` (`setCommitmentDue` `:89-149`, `createCommitment` `:165-250`, imports)
- Modify: `src/lib/commitments.test.ts` (provisioning + new tests)

- [ ] **Step 1: Update the request/response schemas**

In `src/lib/schemas/set-commitment-due.ts`:

Add imports at top:

```ts
import { DUE_TIME_PATTERN } from "./due-claim-metadata.js";
import { isValidTimeZone } from "~/lib/time-zone.js";
```

Add to `setCommitmentDueRequestSchema` (after `dueOn`):

```ts
  /** Optional wall-clock time `HH:mm` to qualify the date. Requires `timeZone`. */
  dueTime: z
    .string()
    .regex(DUE_TIME_PATTERN, "dueTime must be HH:mm")
    .nullish(),
  /** IANA zone for `dueTime`. Required iff `dueTime` is set. */
  timeZone: z
    .string()
    .refine(isValidTimeZone, "Invalid IANA time zone")
    .nullish(),
```

Wrap the object with a refinement (replace `export const setCommitmentDueRequestSchema = z.object({ ... });` so the `.superRefine` is chained after the closing `})`):

```ts
  .superRefine((v, ctx) => {
    const hasTime = v.dueTime != null;
    const hasZone = v.timeZone != null;
    if (hasTime !== hasZone) {
      ctx.addIssue({ code: "custom", message: "dueTime and timeZone must be set together" });
    }
    if (v.dueOn === null && (hasTime || hasZone)) {
      ctx.addIssue({ code: "custom", message: "dueTime/timeZone require a dueOn date" });
    }
  });
```

Add to `setCommitmentDueResponseSchema` (after `dueOn`):

```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
```

In `src/lib/schemas/create-commitment.ts`, the same imports, and add to `createCommitmentRequestSchema` (after `dueOn`):

```ts
  dueTime: z
    .string()
    .regex(DUE_TIME_PATTERN, "dueTime must be HH:mm")
    .nullish(),
  timeZone: z
    .string()
    .refine(isValidTimeZone, "Invalid IANA time zone")
    .nullish(),
```

Chain after the object close:

```ts
  .superRefine((v, ctx) => {
    const hasTime = v.dueTime != null;
    const hasZone = v.timeZone != null;
    if (hasTime !== hasZone) {
      ctx.addIssue({ code: "custom", message: "dueTime and timeZone must be set together" });
    }
    if (v.dueOn === undefined && (hasTime || hasZone)) {
      ctx.addIssue({ code: "custom", message: "dueTime/timeZone require a dueOn date" });
    }
  });
```

Add to `createCommitmentResponseSchema` (after `dueOn`):

```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/commitments.test.ts`, add `"object_instant" timestamp with time zone,` after the `"metadata" jsonb,` line in `provisionSchema`.

Add a new `describeIfServer("commitment due time", () => { ... })` block (copy the create/drop-DB `beforeAll`/`afterAll` boilerplate from the existing `createCommitment` block in the same file). Tests:

```ts
it("createCommitment stores dueTime + timeZone + object_instant and echoes them", async () => {
  const userId = "user_due_time_create";
  // ... standard per-test client + drizzle + vi.doMock("~/utils/db") + provisionSchema + insert user ...
  // ... setSkipEmbeddingPersistence(true) ...
  const { createCommitment } = await import("./commitments");
  const { getOpenCommitments } = await import("./query/open-commitments");

  const created = await createCommitment(
    createCommitmentRequestSchema.parse({
      userId,
      label: "Call the bank",
      dueOn: "2026-06-10",
      dueTime: "17:00",
      timeZone: "America/New_York",
    }),
  );
  expect(created.dueOn).toBe("2026-06-10");
  expect(created.dueTime).toBe("17:00");
  expect(created.timeZone).toBe("America/New_York");
  expect(created.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z"); // 17:00 EDT = 21:00Z

  const { rows } = await client.query(
    `SELECT metadata, object_instant FROM claims WHERE id = $1`,
    [created.dueClaimId],
  );
  expect(rows[0].metadata).toEqual({
    dueTime: "17:00",
    timeZone: "America/New_York",
  });
  expect(new Date(rows[0].object_instant).toISOString()).toBe(
    "2026-06-10T21:00:00.000Z",
  );

  const open = await getOpenCommitments({ userId });
  expect(open[0]).toMatchObject({
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
  });
  expect(open[0]!.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z");
});

it("setCommitmentDue sets a time, then a date-only call clears it", async () => {
  // ... setup, create a date-only commitment first ...
  const { createCommitment, setCommitmentDue } = await import("./commitments");
  const { setCommitmentDueRequestSchema } = await import(
    "./schemas/set-commitment-due"
  );
  const created = await createCommitment(
    createCommitmentRequestSchema.parse({
      userId,
      label: "Ship it",
      dueOn: "2026-06-10",
    }),
  );

  const timed = await setCommitmentDue(
    setCommitmentDueRequestSchema.parse({
      userId,
      taskId: created.taskId,
      dueOn: "2026-06-10",
      dueTime: "09:30",
      timeZone: "Europe/Paris",
    }),
  );
  expect(timed.dueTime).toBe("09:30");
  expect(timed.timeZone).toBe("Europe/Paris");
  expect(timed.dueAt?.toISOString()).toBe("2026-06-10T07:30:00.000Z"); // 09:30 CEST = 07:30Z

  const cleared = await setCommitmentDue(
    setCommitmentDueRequestSchema.parse({
      userId,
      taskId: created.taskId,
      dueOn: "2026-06-10",
    }),
  );
  expect(cleared.dueTime).toBeNull();
  expect(cleared.timeZone).toBeNull();
  expect(cleared.dueAt).toBeNull();

  const { rows } = await client.query(
    `SELECT metadata, object_instant FROM claims WHERE id = $1`,
    [cleared.claimId],
  );
  expect(rows[0].metadata).toBeNull();
  expect(rows[0].object_instant).toBeNull();
});

it("rejects dueTime without timeZone at the schema boundary", () => {
  expect(
    setCommitmentDueRequestSchema.safeParse({
      userId: "u",
      taskId: newTypeId("node"),
      dueOn: "2026-06-10",
      dueTime: "09:00",
    }).success,
  ).toBe(false);
});
```

Add `import { setCommitmentDueRequestSchema } from "~/lib/schemas/set-commitment-due";` to the test file's imports (alongside the existing schema imports).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm run test -- src/lib/commitments.test.ts -t "due time"`
Expected: FAIL — `createCommitment`/`setCommitmentDue` don't accept or persist the new fields yet.

- [ ] **Step 4: Implement the write logic**

In `src/lib/commitments.ts`:

Add imports:

```ts
import type { CreateNodeInitialClaimInput } from "~/lib/node";
import { instantFromLocalTime } from "~/lib/time-zone";
```

Change `import { createNode, updateNode } from "~/lib/node";` to also import the type if not already, and **remove** the now-unused `import type { CreateNodeInitialClaim } from "~/lib/schemas/node";` (replaced by `CreateNodeInitialClaimInput`).

Add a private helper near the top (after `requireOwnedTask`):

```ts
/**
 * Resolve a date + optional time/zone into the claim qualifiers. Returns the
 * `metadata` jsonb and resolved UTC `objectInstant` when a time is supplied, or
 * an empty object for a date-only due. The caller's schema guarantees
 * `dueTime`/`timeZone` are both present or both absent.
 */
function resolveDueQualifier(
  dueOn: string,
  dueTime: string | null | undefined,
  timeZone: string | null | undefined,
): { metadata?: Record<string, unknown>; objectInstant?: Date } {
  if (dueTime == null || timeZone == null) return {};
  return {
    metadata: { dueTime, timeZone },
    objectInstant: instantFromLocalTime(dueOn, dueTime, timeZone),
  };
}
```

In `setCommitmentDue`, destructure the new fields: `const { userId, taskId, dueOn, dueTime, timeZone, note, assertedByKind } = input;`

In the `dueOn === null` clear branch, change the return to:

```ts
    return { taskId, dueOn: null, dueTime: null, timeZone: null, dueAt: null, claimId: null, retractedClaimIds };
```

In the assert branch (after `ensureDayNode`):

```ts
  const { metadata, objectInstant } = resolveDueQualifier(dueOn, dueTime, timeZone);
  const created = await createClaim({
    userId,
    subjectNodeId: taskId,
    predicate: "DUE_ON",
    statement: objectInstant
      ? `Task due on ${dueOn} at ${dueTime} (${timeZone})`
      : `Task due on ${dueOn}`,
    objectNodeId: dayNodeId,
    description: note,
    assertedByKind,
    statedAt: new Date(),
    metadata,
    objectInstant,
  });

  return {
    taskId,
    dueOn: format(targetDate, "yyyy-MM-dd"),
    dueTime: dueTime ?? null,
    timeZone: timeZone ?? null,
    dueAt: objectInstant ?? null,
    claimId: created.id,
    retractedClaimIds: [],
  };
```

Update the function's inline return type annotation to include `dueTime: string | null; timeZone: string | null; dueAt: Date | null;`.

In `createCommitment`, destructure new fields: `const { userId, label, description, status, dueOn, dueTime, timeZone, ownedBy, assertedByKind } = input;`

Change `const initialClaims: CreateNodeInitialClaim[] = [` to `const initialClaims: CreateNodeInitialClaimInput[] = [`.

In the `if (dueOn !== undefined)` block, build the claim with qualifiers:

```ts
let dueIndex: number | null = null;
let dueQualifier: { metadata?: Record<string, unknown>; objectInstant?: Date } =
  {};
if (dueOn !== undefined) {
  const dueNodeId = await ensureDayNode(db, userId, parseISO(dueOn));
  dueQualifier = resolveDueQualifier(dueOn, dueTime, timeZone);
  dueIndex =
    initialClaims.push({
      predicate: "DUE_ON",
      statement: dueQualifier.objectInstant
        ? `${label} is due on ${dueOn} at ${dueTime} (${timeZone}).`
        : `${label} is due on ${dueOn}.`,
      objectNodeId: dueNodeId,
      assertedByKind,
      metadata: dueQualifier.metadata,
      objectInstant: dueQualifier.objectInstant,
    }) - 1;
}
```

In the response object add after `dueOn: dueOn ?? null,`:

```ts
    dueTime: dueTime ?? null,
    timeZone: timeZone ?? null,
    dueAt: dueQualifier.objectInstant ?? null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm run test -- src/lib/commitments.test.ts`
Expected: PASS (existing commitment tests + the 3 new due-time tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/commitments.ts src/lib/schemas/set-commitment-due.ts src/lib/schemas/create-commitment.ts src/lib/commitments.test.ts
git commit -m "✨ feat(commitments): accept dueTime + timeZone on create/setDue"
```

---

## Task 6: Read — open/candidate commitments expose `dueTime`/`timeZone`/`dueAt`

**Files:**

- Modify: `src/lib/schemas/open-commitments.ts` (item schema)
- Modify: `src/lib/query/open-commitments.ts` (row type, select, mapping)
- Create: `src/lib/query/due-qualifier.ts` (shared read mapper)
- Modify: `src/lib/query/open-commitments.test.ts` (provisioning + new assertions)

- [ ] **Step 1: Create the shared read mapper**

Create `src/lib/query/due-qualifier.ts`:

```ts
/** Map a joined DUE_ON claim's metadata + object_instant into read-model fields. */
import { dueClaimMetadataSchema } from "~/lib/schemas/due-claim-metadata";

export interface DueQualifierFields {
  dueTime: string | null;
  timeZone: string | null;
  dueAt: Date | null;
}

/**
 * Parse a DUE_ON claim's `metadata` jsonb defensively. Malformed/absent metadata
 * degrades to date-only (`dueTime`/`timeZone` null) — a single bad row must not
 * 500 a read (mirrors `coerceTaskStatus`). `dueAt` comes straight from the
 * indexed `object_instant` column.
 */
export function readDueQualifier(
  metadata: unknown,
  objectInstant: Date | null,
): DueQualifierFields {
  const parsed = dueClaimMetadataSchema.safeParse(metadata ?? undefined);
  if (!parsed.success) {
    if (metadata != null) {
      console.warn(
        `Ignoring malformed DUE_ON metadata: ${JSON.stringify(metadata)}`,
      );
    }
    return { dueTime: null, timeZone: null, dueAt: objectInstant ?? null };
  }
  return {
    dueTime: parsed.data.dueTime,
    timeZone: parsed.data.timeZone,
    dueAt: objectInstant ?? null,
  };
}
```

- [ ] **Step 2: Add fields to the open-commitments item schema**

In `src/lib/schemas/open-commitments.ts`, add to `openCommitmentSchema` (after `dueOn`):

```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
```

- [ ] **Step 3: Add the new columns to the test's claims provisioning**

This file seeds via direct `INSERT` (it does not provision `source_links`, so the writer can't be used here). In the inline `CREATE TABLE "claims"` block, add two columns after `"object_value" text,`:

```sql
          "metadata" jsonb,
          "object_instant" timestamp with time zone,
```

- [ ] **Step 4: Add a reusable seed helper + write the failing tests**

Add this module-level helper near the top of the test file (after the imports — `newTypeId` and `Client` are already imported):

```ts
async function seedTask(
  client: import("pg").Client,
  userId: string,
  opts: {
    label: string;
    dueOn?: string;
    dueTime?: string;
    timeZone?: string;
    dueAt?: string;
  },
): Promise<string> {
  const taskId = newTypeId("node");
  const sourceId = newTypeId("source");
  await client.query(
    `INSERT INTO "sources" ("id","user_id","type","external_id") VALUES ($1,$2,'manual',$3)`,
    [sourceId, userId, `manual:${taskId}`],
  );
  await client.query(
    `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Task')`,
    [taskId, userId],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id","node_id","label","canonical_label") VALUES ($1,$2,$3,$3)`,
    [newTypeId("node_metadata"), taskId, opts.label],
  );
  await client.query(
    `INSERT INTO "claims" ("id","user_id","subject_node_id","object_value","predicate","statement","source_id","asserted_by_kind","stated_at","status")
     VALUES ($1,$2,$3,'pending','HAS_TASK_STATUS','status',$4,'user',now(),'active')`,
    [newTypeId("claim"), userId, taskId, sourceId],
  );
  if (opts.dueOn) {
    const dayId = newTypeId("node");
    await client.query(
      `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Temporal')`,
      [dayId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id","node_id","label","canonical_label") VALUES ($1,$2,$3,$3)`,
      [newTypeId("node_metadata"), dayId, opts.dueOn],
    );
    const metadata =
      opts.dueTime && opts.timeZone
        ? JSON.stringify({ dueTime: opts.dueTime, timeZone: opts.timeZone })
        : null;
    await client.query(
      `INSERT INTO "claims" ("id","user_id","subject_node_id","object_node_id","predicate","statement","source_id","asserted_by_kind","stated_at","status","metadata","object_instant")
       VALUES ($1,$2,$3,$4,'DUE_ON','due',$5,'user',now(),'active',$6::jsonb,$7)`,
      [
        newTypeId("claim"),
        userId,
        taskId,
        dayId,
        sourceId,
        metadata,
        opts.dueAt ?? null,
      ],
    );
  }
  return taskId;
}
```

Then add two tests (reuse the file's per-test client/drizzle/`vi.doMock("~/utils/db")` setup and the inline `CREATE TABLE` provisioning the existing tests use; insert the user, then call `seedTask`):

```ts
it("returns dueTime, timeZone, and dueAt for a timed commitment", async () => {
  // ... per-test client + drizzle + vi.doMock + run the CREATE TABLE block + insert user ...
  await seedTask(client, userId, {
    label: "Timed task",
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T21:00:00Z",
  });
  const { getOpenCommitments } = await import("./open-commitments");
  const open = await getOpenCommitments({ userId });
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
  });
  expect(open[0]!.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z");
});

it("returns null due fields for a date-only commitment", async () => {
  // ... setup ...
  await seedTask(client, userId, { label: "Date only", dueOn: "2026-06-10" });
  const { getOpenCommitments } = await import("./open-commitments");
  const open = await getOpenCommitments({ userId });
  expect(open[0]).toMatchObject({
    dueOn: "2026-06-10",
    dueTime: null,
    timeZone: null,
    dueAt: null,
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/query/open-commitments.test.ts -t "dueTime"`
Expected: FAIL — query doesn't select/return the new fields.

- [ ] **Step 6: Update the query**

In `src/lib/query/open-commitments.ts`:

Add import: `import { readDueQualifier } from "./due-qualifier";`

Extend `OpenCommitmentRow` with:

```ts
dueMetadata: unknown;
dueInstant: Date | null;
```

In the `.select({ ... })`, after `dueOn: dueMetadata.label,` add:

```ts
      dueMetadata: dueClaim.metadata,
      dueInstant: dueClaim.objectInstant,
```

In the row-mapping loop, where it pushes a commitment, replace the `dueOn: row.dueOn,` line region with:

```ts
const due = readDueQualifier(row.dueMetadata, row.dueInstant);
commitments.push({
  taskId: row.taskId,
  label: row.label,
  status,
  owner:
    row.ownerNodeId === null
      ? null
      : { nodeId: row.ownerNodeId, label: row.ownerLabel },
  dueOn: row.dueOn,
  dueTime: due.dueTime,
  timeZone: due.timeZone,
  dueAt: due.dueAt,
  statedAt: row.statedAt,
  sourceId: row.sourceId,
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/query/open-commitments.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/query/due-qualifier.ts src/lib/query/open-commitments.ts src/lib/schemas/open-commitments.ts src/lib/query/open-commitments.test.ts
git commit -m "✨ feat(commitments): surface dueTime/timeZone/dueAt in open-commitments read"
```

---

## Task 7: Read — `listCommitments` instant filters + `dueAt` sort + fields

**Files:**

- Modify: `src/lib/schemas/list-commitments.ts`
- Modify: `src/lib/query/commitments-list.ts`
- Modify: `src/lib/query/commitments-list.test.ts` (provisioning + tests)

- [ ] **Step 1: Update the schema**

In `src/lib/schemas/list-commitments.ts`:

Add `"dueAt"` to the sort enum:

```ts
export const commitmentSortEnum = z.enum([
  "statusChangedAt",
  "dueOn",
  "dueAt",
  "createdAt",
  "label",
]);
```

Add request fields (after `dueAfter`):

```ts
    /** ISO instant, inclusive upper bound on `object_instant` (timed tasks only). */
    dueBeforeInstant: z.string().datetime().pipe(z.coerce.date()).optional(),
    /** ISO instant, inclusive lower bound on `object_instant` (timed tasks only). */
    dueAfterInstant: z.string().datetime().pipe(z.coerce.date()).optional(),
```

Add to `commitmentListItemSchema` (after `dueOn`):

```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
```

- [ ] **Step 2: Add the new columns + a seed helper**

In `src/lib/query/commitments-list.test.ts`: add `"metadata" jsonb,` and `"object_instant" timestamp with time zone,` to the inline `CREATE TABLE "claims"` block (after `"object_value" text,`).

This file also seeds via direct `INSERT`. Add this module-level helper near the imports (`newTypeId` is already imported):

```ts
async function seedTask(
  client: import("pg").Client,
  userId: string,
  opts: {
    label: string;
    dueOn?: string;
    dueTime?: string;
    timeZone?: string;
    dueAt?: string;
  },
): Promise<string> {
  const taskId = newTypeId("node");
  const sourceId = newTypeId("source");
  await client.query(
    `INSERT INTO "sources" ("id","user_id","type","external_id") VALUES ($1,$2,'manual',$3)`,
    [sourceId, userId, `manual:${taskId}`],
  );
  await client.query(
    `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Task')`,
    [taskId, userId],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id","node_id","label","canonical_label") VALUES ($1,$2,$3,$3)`,
    [newTypeId("node_metadata"), taskId, opts.label],
  );
  await client.query(
    `INSERT INTO "claims" ("id","user_id","subject_node_id","object_value","predicate","statement","source_id","asserted_by_kind","stated_at","status")
     VALUES ($1,$2,$3,'pending','HAS_TASK_STATUS','status',$4,'user',now(),'active')`,
    [newTypeId("claim"), userId, taskId, sourceId],
  );
  if (opts.dueOn) {
    const dayId = newTypeId("node");
    await client.query(
      `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Temporal')`,
      [dayId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id","node_id","label","canonical_label") VALUES ($1,$2,$3,$3)`,
      [newTypeId("node_metadata"), dayId, opts.dueOn],
    );
    const metadata =
      opts.dueTime && opts.timeZone
        ? JSON.stringify({ dueTime: opts.dueTime, timeZone: opts.timeZone })
        : null;
    await client.query(
      `INSERT INTO "claims" ("id","user_id","subject_node_id","object_node_id","predicate","statement","source_id","asserted_by_kind","stated_at","status","metadata","object_instant")
       VALUES ($1,$2,$3,$4,'DUE_ON','due',$5,'user',now(),'active',$6::jsonb,$7)`,
      [
        newTypeId("claim"),
        userId,
        taskId,
        dayId,
        sourceId,
        metadata,
        opts.dueAt ?? null,
      ],
    );
  }
  return taskId;
}
```

- [ ] **Step 3: Write the failing tests**

Add tests (reuse the file's per-test client/drizzle/`vi.doMock`/`CREATE TABLE` setup; insert the user, then seed via `seedTask`):

```ts
it("sorts by dueAt ascending with timed tasks first, nulls last", async () => {
  // ... per-test setup + insert user ...
  await seedTask(client, userId, {
    label: "A",
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T21:00:00Z",
  });
  await seedTask(client, userId, {
    label: "B",
    dueOn: "2026-06-10",
    dueTime: "09:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T13:00:00Z",
  });
  await seedTask(client, userId, { label: "C", dueOn: "2026-06-11" }); // date-only, null instant
  const { listCommitments } = await import("./commitments-list");
  const { listCommitmentsRequestSchema } = await import(
    "~/lib/schemas/list-commitments"
  );
  const page = await listCommitments(
    listCommitmentsRequestSchema.parse({
      userId,
      sort: "dueAt",
      order: "asc",
      limit: 50,
    }),
  );
  const labels = page.commitments.map((c) => c.label);
  expect(labels.slice(0, 2)).toEqual(["B", "A"]); // 13:00Z before 21:00Z
  expect(labels[2]).toBe("C"); // date-only (null instant) last
});

it("filters by dueBeforeInstant (timed tasks only)", async () => {
  // ... setup ...
  await seedTask(client, userId, {
    label: "A",
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T21:00:00Z",
  });
  await seedTask(client, userId, {
    label: "B",
    dueOn: "2026-06-10",
    dueTime: "09:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T13:00:00Z",
  });
  await seedTask(client, userId, { label: "C", dueOn: "2026-06-11" });
  const { listCommitments } = await import("./commitments-list");
  const { listCommitmentsRequestSchema } = await import(
    "~/lib/schemas/list-commitments"
  );
  const page = await listCommitments(
    listCommitmentsRequestSchema.parse({
      userId,
      dueBeforeInstant: "2026-06-10T15:00:00.000Z",
      limit: 50,
    }),
  );
  expect(page.commitments.map((c) => c.label)).toEqual(["B"]); // only 13:00Z ≤ 15:00Z; date-only excluded
});

it("includes dueTime/timeZone/dueAt on items", async () => {
  // ... setup ...
  await seedTask(client, userId, {
    label: "A",
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
    dueAt: "2026-06-10T21:00:00Z",
  });
  const { listCommitments } = await import("./commitments-list");
  const { listCommitmentsRequestSchema } = await import(
    "~/lib/schemas/list-commitments"
  );
  const page = await listCommitments(
    listCommitmentsRequestSchema.parse({ userId, limit: 50 }),
  );
  const a = page.commitments.find((c) => c.label === "A")!;
  expect(a).toMatchObject({ dueTime: "17:00", timeZone: "America/New_York" });
  expect(a.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm run test -- src/lib/query/commitments-list.test.ts -t "due"`
Expected: FAIL — sort key `dueAt` unknown / fields absent / filters unsupported.

- [ ] **Step 5: Update the query**

In `src/lib/query/commitments-list.ts`:

Add import: `import { readDueQualifier } from "./due-qualifier";`

Extend `ListRow` with:

```ts
dueMetadata: unknown;
dueInstant: Date | null;
```

Destructure the new params: add `dueBeforeInstant, dueAfterInstant` to the `const { ... } = params;`.

Add `dueAt` to `sortColumns`:

```ts
    dueAt: sql`${dueClaim.objectInstant}`,
```

Add the instant filters to `whereClauses` (after the `dueAfter` clause):

```ts
    dueBeforeInstant === undefined
      ? undefined
      : sql`${dueClaim.objectInstant} <= ${dueBeforeInstant.toISOString()}`,
    dueAfterInstant === undefined
      ? undefined
      : sql`${dueClaim.objectInstant} >= ${dueAfterInstant.toISOString()}`,
```

Handle `dueAt` ordering like `dueOn` (nulls last). Change the `nullFlag` + `orderBy` to treat both date-style sorts:

```ts
const nullFlag =
  sort === "dueAt"
    ? sql<boolean>`(${dueClaim.objectInstant} IS NULL)`
    : sql<boolean>`(${dueMetadata.label} IS NULL)`;
```

and:

```ts
const orderBy: SQL[] =
  sort === "dueOn" || sort === "dueAt"
    ? [asc(nullFlag), dir(sortColumn), dir(nodes.id)]
    : [dir(sortColumn), dir(nodes.id)];
```

In `keysetClause`, extend the nulls-last branch to cover `dueAt` as well — change `if (sort === "dueOn") {` to `if (sort === "dueOn" || sort === "dueAt") {`.

In `sortValueOf`, add a `dueAt` case:

```ts
    case "dueAt":
      return row.dueInstant === null ? null : row.dueInstant.toISOString();
```

and update the `nextCursor` null flag: change `n: sort === "dueOn" && last.dueOn === null,` to:

```ts
      n:
        (sort === "dueOn" && last.dueOn === null) ||
        (sort === "dueAt" && last.dueInstant === null),
```

In the `.select({ ... })`, after `dueOn: dueMetadata.label,` add:

```ts
      dueMetadata: dueClaim.metadata,
      dueInstant: dueClaim.objectInstant,
```

In the row→item mapping (the `commitments.push({ ... })`), replace `dueOn: row.dueOn,` region with:

```ts
const due = readDueQualifier(row.dueMetadata, row.dueInstant);
commitments.push({
  taskId: row.taskId,
  label: row.label,
  status,
  owner:
    row.ownerNodeId === null
      ? null
      : { nodeId: row.ownerNodeId, label: row.ownerLabel },
  dueOn: row.dueOn,
  dueTime: due.dueTime,
  timeZone: due.timeZone,
  dueAt: due.dueAt,
  statusChangedAt: row.statusChangedAt,
  createdAt: row.createdAt,
  sourceId: row.sourceId,
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm run test -- src/lib/query/commitments-list.test.ts`
Expected: PASS (existing list tests + 3 new).

- [ ] **Step 7: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/query/commitments-list.ts src/lib/schemas/list-commitments.ts src/lib/query/commitments-list.test.ts
git commit -m "✨ feat(commitments): dueAt sort + instant-range filters in listCommitments"
```

---

## Task 8: Read — `getCommitment` detail exposes due time/zone/instant

**Files:**

- Modify: `src/lib/schemas/get-commitment.ts` (response)
- Modify: `src/lib/query/commitment-detail.ts`
- Modify: `src/lib/query/commitment-detail.test.ts` (provisioning + test)

- [ ] **Step 1: Update the response schema**

In `src/lib/schemas/get-commitment.ts`, add to `getCommitmentResponseSchema` (after `dueOn`):

```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
```

- [ ] **Step 2: Write the failing test**

In `src/lib/query/commitment-detail.test.ts`: add `"object_instant" timestamp with time zone,` after `"metadata" jsonb,` in **both** inline `CREATE TABLE "claims"` blocks (this file has two).

Add a test (reuse the file's setup; create via the writer):

```ts
it("returns dueTime, timeZone and dueAt for a timed commitment", async () => {
  // ... per-test setup ...
  const { createCommitment } = await import("~/lib/commitments");
  const { getCommitment } = await import("./commitment-detail");
  const { createCommitmentRequestSchema } = await import(
    "~/lib/schemas/create-commitment"
  );
  const created = await createCommitment(
    createCommitmentRequestSchema.parse({
      userId,
      label: "Timed",
      dueOn: "2026-06-10",
      dueTime: "17:00",
      timeZone: "America/New_York",
    }),
  );
  const detail = await getCommitment({
    userId,
    taskId: created.taskId,
    includeHistory: false,
    includeSources: false,
  });
  expect(detail).toMatchObject({
    dueOn: "2026-06-10",
    dueTime: "17:00",
    timeZone: "America/New_York",
  });
  expect(detail.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/query/commitment-detail.test.ts -t "timed"`
Expected: FAIL — detail doesn't return the new fields.

- [ ] **Step 4: Implement via a targeted side lookup**

`getNodeById` selects a fixed column set (no `metadata`/`object_instant`) and is shared by many callers, so we do **not** touch it. Instead, after `getCommitment` computes `activeDue`, fetch just that claim's qualifier.

In `src/lib/query/commitment-detail.ts`:

The file already imports `and, eq, inArray` from `drizzle-orm` and `useDatabase` from `~/utils/db`. Make two import changes only:

- Change `import { sources } from "~/db/schema";` → `import { claims, sources } from "~/db/schema";`
- Add `import { readDueQualifier } from "./due-qualifier";`

`getCommitment` does not currently hold a `db` handle (it calls `getNodeById`, and `loadSources` opens its own). Add one near the top of `getCommitment` (right after destructuring `params`):

```ts
const db = await useDatabase();
```

Then, just before the final `return { ... }`, resolve the due qualifier from the active claim with a single indexed PK lookup:

```ts
let due = {
  dueTime: null as string | null,
  timeZone: null as string | null,
  dueAt: null as Date | null,
};
if (activeDue) {
  const [dueRow] = await db
    .select({ metadata: claims.metadata, objectInstant: claims.objectInstant })
    .from(claims)
    .where(and(eq(claims.id, activeDue.id), eq(claims.userId, userId)))
    .limit(1);
  if (dueRow) due = readDueQualifier(dueRow.metadata, dueRow.objectInstant);
}
```

Then in the returned object add after `dueOn: activeDue ? activeDue.objectLabel : null,`:

```ts
    dueTime: due.dueTime,
    timeZone: due.timeZone,
    dueAt: due.dueAt,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/query/commitment-detail.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/query/commitment-detail.ts src/lib/schemas/get-commitment.ts src/lib/query/commitment-detail.test.ts
git commit -m "✨ feat(commitments): expose due time/zone/instant in commitment detail"
```

---

## Task 9: Digest — instant-aware overdue/due-today bucketing

**Files:**

- Modify: `src/lib/digest/get-digest.ts` (`bucketCommitments` `:36-52`, call site `:100`)
- Modify: `src/lib/digest/get-digest.test.ts` (add a pure unit test block)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/digest/get-digest.test.ts` a server-independent block (no DB):

```ts
import { bucketCommitments } from "./get-digest";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

function commitment(
  partial: Partial<OpenCommitment> & { label: string },
): OpenCommitment {
  return {
    taskId: "node_x" as OpenCommitment["taskId"],
    status: "pending",
    owner: null,
    dueOn: null,
    dueTime: null,
    timeZone: null,
    dueAt: null,
    statedAt: new Date("2026-06-10T00:00:00Z"),
    sourceId: "source_x" as OpenCommitment["sourceId"],
    ...partial,
  };
}

describe("bucketCommitments (instant-aware)", () => {
  const date = "2026-06-10";
  const tz = "America/New_York";

  it("moves a timed task to overdue once its instant passes now", () => {
    const due9am = commitment({
      label: "9am",
      dueOn: "2026-06-10",
      dueTime: "09:00",
      timeZone: tz,
      dueAt: new Date("2026-06-10T13:00:00Z"),
    });
    // now = 10:00 ET = 14:00Z → 9am task is overdue
    const after = bucketCommitments(
      [due9am],
      date,
      tz,
      7,
      new Date("2026-06-10T14:00:00Z"),
    );
    expect(after.overdue.map((c) => c.label)).toEqual(["9am"]);
    expect(after.dueToday).toEqual([]);
    // now = 08:00 ET = 12:00Z → still due today
    const before = bucketCommitments(
      [due9am],
      date,
      tz,
      7,
      new Date("2026-06-10T12:00:00Z"),
    );
    expect(before.dueToday.map((c) => c.label)).toEqual(["9am"]);
    expect(before.overdue).toEqual([]);
  });

  it("keeps date-only tasks on calendar-day comparison", () => {
    const today = commitment({ label: "today", dueOn: "2026-06-10" });
    const yesterday = commitment({ label: "yest", dueOn: "2026-06-09" });
    const soon = commitment({ label: "soon", dueOn: "2026-06-12" });
    const res = bucketCommitments(
      [today, yesterday, soon],
      date,
      tz,
      7,
      new Date("2026-06-10T14:00:00Z"),
    );
    expect(res.dueToday.map((c) => c.label)).toEqual(["today"]);
    expect(res.overdue.map((c) => c.label)).toEqual(["yest"]);
    expect(res.upcoming.map((c) => c.label)).toEqual(["soon"]);
  });

  it("buckets a future timed task as upcoming", () => {
    const tomorrow = commitment({
      label: "tom",
      dueOn: "2026-06-11",
      dueTime: "09:00",
      timeZone: tz,
      dueAt: new Date("2026-06-11T13:00:00Z"),
    });
    const res = bucketCommitments(
      [tomorrow],
      date,
      tz,
      7,
      new Date("2026-06-10T14:00:00Z"),
    );
    expect(res.upcoming.map((c) => c.label)).toEqual(["tom"]);
  });
});
```

Ensure `describe`/`it`/`expect` are imported at the top of the file (they are, for the existing tests).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/digest/get-digest.test.ts -t "instant-aware"`
Expected: FAIL — `bucketCommitments` is not exported and signature differs.

- [ ] **Step 3: Rewrite `bucketCommitments` (exported, instant-aware)**

In `src/lib/digest/get-digest.ts`, replace the existing `bucketCommitments` with:

```ts
/**
 * Bucket dated commitments relative to the digest day. Timed tasks (those with
 * a resolved `dueAt` instant) bucket by comparing the instant to `now` and the
 * caller-zone day boundaries; date-only tasks keep calendar-day string
 * comparison. Undated tasks are omitted. Exported for direct unit testing.
 */
export function bucketCommitments(
  commitments: OpenCommitment[],
  date: string,
  timeZone: string,
  upcomingWithinDays: number,
  now: Date,
): DigestCommitments {
  const upcomingUntil = shiftIsoDate(date, upcomingWithinDays);
  const todayEnd = startOfDayInTimeZone(shiftIsoDate(date, 1), timeZone);
  const upcomingEndExcl = startOfDayInTimeZone(
    shiftIsoDate(date, upcomingWithinDays + 1),
    timeZone,
  );

  const dueToday: OpenCommitment[] = [];
  const overdue: OpenCommitment[] = [];
  const upcoming: OpenCommitment[] = [];

  for (const commitment of commitments) {
    if (commitment.dueAt !== null) {
      const at = commitment.dueAt.getTime();
      if (at < now.getTime()) overdue.push(commitment);
      else if (at < todayEnd.getTime()) dueToday.push(commitment);
      else if (at < upcomingEndExcl.getTime()) upcoming.push(commitment);
      continue;
    }
    const { dueOn } = commitment;
    if (dueOn === null) continue;
    if (dueOn < date) overdue.push(commitment);
    else if (dueOn === date) dueToday.push(commitment);
    else if (dueOn <= upcomingUntil) upcoming.push(commitment);
  }
  return { dueToday, overdue, upcoming };
}
```

- [ ] **Step 4: Update the call site**

In `getDigest`, the `commitments:` field currently calls `bucketCommitments(commitments, date, upcomingUntil)`. Replace with:

```ts
    commitments: bucketCommitments(commitments, date, timeZone, upcomingWithinDays, new Date()),
```

Remove the now-unused `const upcomingUntil = shiftIsoDate(date, upcomingWithinDays);` line (the bucketer computes it internally). Keep `shiftIsoDate` and `startOfDayInTimeZone` imports — both are used inside the bucketer now. `startOfDayInTimeZone` is already imported (Task 2 updated its path).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/digest/get-digest.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/digest/get-digest.ts src/lib/digest/get-digest.test.ts
git commit -m "✨ feat(digest): instant-aware overdue/due-today bucketing"
```

---

## Task 10: Context section renders time + zone

**Files:**

- Modify: `src/lib/context/sections/open-commitments.ts` (`renderLine` `:21-31`)
- Create: `src/lib/context/sections/open-commitments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/context/sections/open-commitments.test.ts`:

```ts
import { renderLine } from "./open-commitments";
import { describe, expect, it } from "vitest";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

function c(
  partial: Partial<OpenCommitment> & { label: string },
): OpenCommitment {
  return {
    taskId: "node_x" as OpenCommitment["taskId"],
    status: "pending",
    owner: null,
    dueOn: null,
    dueTime: null,
    timeZone: null,
    dueAt: null,
    statedAt: new Date(),
    sourceId: "source_x" as OpenCommitment["sourceId"],
    ...partial,
  };
}

describe("renderLine", () => {
  it("renders date only when no time", () => {
    expect(renderLine(c({ label: "A", dueOn: "2026-06-10" }))).toContain(
      "due=2026-06-10",
    );
  });
  it("renders date + time + zone when timed", () => {
    const line = renderLine(
      c({
        label: "A",
        dueOn: "2026-06-10",
        dueTime: "17:00",
        timeZone: "America/New_York",
      }),
    );
    expect(line).toContain("due=2026-06-10 17:00 America/New_York");
  });
  it("omits due entirely when undated", () => {
    expect(renderLine(c({ label: "A" }))).not.toContain("due=");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm run test -- src/lib/context/sections/open-commitments.test.ts`
Expected: FAIL — `renderLine` is not exported / does not render time.

- [ ] **Step 3: Export and update `renderLine`**

In `src/lib/context/sections/open-commitments.ts`, change `function renderLine(` to `export function renderLine(` and replace the due block:

```ts
if (commitment.dueOn !== null) {
  const due =
    commitment.dueTime !== null && commitment.timeZone !== null
      ? `${commitment.dueOn} ${commitment.dueTime} ${commitment.timeZone}`
      : commitment.dueOn;
  parts.push(`due=${due}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm run test -- src/lib/context/sections/open-commitments.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/context/sections/open-commitments.ts src/lib/context/sections/open-commitments.test.ts
git commit -m "✨ feat(context): render due time + zone in open-commitments section"
```

---

## Task 11: SDK doc comments, SDK docs, CHANGELOG, version bump

**Files:**

- Modify: `src/sdk/memory-client.ts` (doc comments on `setCommitmentDue`/`createCommitment`, ~`:731-755`)
- Modify: `docs/sdk/commitments.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version)

- [ ] **Step 1: Update SDK doc comments**

In `src/sdk/memory-client.ts`, update the JSDoc above `setCommitmentDue` and `createCommitment` to mention the optional `dueTime` (`HH:mm`) + `timeZone` (IANA), that they are mutually required, and that responses include `dueTime`/`timeZone`/`dueAt`. (No signature changes — types flow from the schemas.)

- [ ] **Step 2: Update `docs/sdk/commitments.md`**

Document on the create/setDue sections: the new `dueTime`/`timeZone` request fields and rules (mutually required; time requires a date), the new `dueTime`/`timeZone`/`dueAt` response/read fields across open/list/detail, and the new `listCommitments` `dueBeforeInstant`/`dueAfterInstant` filters and `dueAt` sort. Note the digest's intraday-overdue behavior. Read the file first and match its existing structure/tone.

- [ ] **Step 3: Update `CHANGELOG.md` and bump version**

Add a new entry at the top of `CHANGELOG.md` describing due time + timezone for commitments (read the file to match its format and the latest version `1.16.0`). Bump `package.json` `version` to `1.17.0`.

- [ ] **Step 4: Build the SDK to confirm it still emits**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/memory-client.ts docs/sdk/commitments.md CHANGELOG.md package.json
git commit -m "📚 docs(commitments): document due time + timezone; bump to 1.17.0"
```

---

## Task 12: Full verification + provisioning sweep

**Files:**

- Possibly modify: any remaining `*.test.ts` whose provisioned `claims` table lacks `object_instant` (and `metadata`).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm run test`
Expected: PASS. If you see `column "object_instant" does not exist` or `column "metadata" does not exist` in any suite, that test provisions a `claims` table missing the column. Open the named test file, find its `CREATE TABLE ... "claims"` block, and add `"metadata" jsonb,` (if missing) and `"object_instant" timestamp with time zone,` (after metadata). Re-run that file, then the full suite again.

Candidate files that provision a `claims` table (add the column only if the suite actually fails — most never select it):
`src/lib/commitment-curation.test.ts`, `src/lib/context/assemble-bootstrap-context.test.ts`, `src/digest-route.test.ts`, `src/sdk/index.test.ts`, `src/lib/jobs/*.test.ts`, `src/lib/claims/lifecycle.test.ts`.

- [ ] **Step 2: Typecheck + structured-output check**

Run: `pnpm run build:check`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm run lint`
Expected: PASS (no new errors).

- [ ] **Step 4: Format**

Run: `pnpm run format`
Expected: PASS. If it reports issues, run `pnpm run format:fix` and review the diff.

- [ ] **Step 5: Apply the migration locally and smoke-test (optional but recommended)**

If a local dev DB is available, run `pnpm run drizzle:migrate` and confirm it applies `0018` cleanly and is idempotent on a second run.

- [ ] **Step 6: Final commit (only if Step 1 required provisioning edits)**

```bash
git add -A
git commit -m "✅ test(commitments): provision object_instant column where needed"
```

---

## Self-review notes (for the implementer)

- **Mutual requirement of `dueTime`/`timeZone`** is enforced in both write schemas (Task 5) via `superRefine`; the read mapper (`readDueQualifier`, Task 6) degrades malformed metadata to date-only rather than throwing.
- **Naming consistency:** `object_instant` (DB column) ↔ `objectInstant` (Drizzle/TS) ↔ `dueAt` (read-model/API field, the user-facing name for the resolved instant). `readDueQualifier` is the single mapper used by both open-commitments and list reads; detail uses it via a side lookup.
- **Backward compatibility:** every new request field is optional/nullish; every new response field is `null` for existing date-only data; no data backfill; the migration is additive.
- **No `getNodeById` change** — detail uses a targeted side query, avoiding ripple across the many `getNodeById` callers/tests.
