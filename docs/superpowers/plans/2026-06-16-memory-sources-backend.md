# assistant-memory: text-blob content + source titles (Parts B+C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sources rendering empty/untitled at the source: (B) decode text/markdown blobs in `/sources/get` so text docs >1KB stop showing empty; (C) generate concise LLM titles for container sources on ingestion (idempotent, async) + a one-time backfill, and derive cheap "Role: first line" labels for individual chat messages.

**Architecture:** Pure, env-free helper modules carry the testable logic (`source-content.ts`, `source-label.ts`, `source-title.ts`); the env/DB/MinIO-coupled orchestration (`jobs/generate-source-title.ts`, route handlers, queue wiring) composes them. Title-gen runs as a fire-and-forget BullMQ job enqueued from the single container-ingest choke point (`insertNewSources`), guarded so it never clobbers a real title.

**Tech Stack:** Nitro/h3 routes, Drizzle (Postgres), BullMQ, OpenAI SDK via `parseStructuredCompletion` + `zodResponseFormat`, MinIO, Vitest.

**Repo:** `/Users/marcel/code/assistant-memory`. Create a branch first: `git checkout -b feat/memory-source-titles-and-blobs`.

**Commands:** `pnpm build:check` or `pnpm typecheck` (match package.json), `pnpm test` / `pnpm test --run`, `pnpm lint`. Run a single test file: `pnpm test <file>`.

**Key facts from recon (cite, don't re-derive):**

- `sources.ts:118` `inlineThreshold = 1024`; text docs >1KB become MinIO blobs.
- `sources.ts:86-89` `RawResult = { kind:"inline"; content } | { kind:"blob"; buffer; contentType }`.
- `routes/sources/get.post.ts:26-37` builds `content` and returns `null` for every blob.
- `lib/sources-read.ts:55-65` `deriveTitle(metadata)`; summary `title` set at `:136-146` (list) and `:189-199` (detail) via `deriveTitle(row.metadata)`.
- `lib/schemas/sources.ts` `sourceContentSchema = { text: string, format: "text"|"markdown" }`.
- Container source types: `conversation`, `meeting_transcript`, `external_conversation` (the only `parentSourceType` values passed to `insertNewSources`). `insertNewSources` returns `{ sourceId, newSourceSourceIds, sourceRefs }` where `sourceId` is the parent.
- `sources.ts` `sourceMetadataSchema` has `rawContent?`, `title?`, `.catchall(z.unknown())` (so `role` is accessible as unknown).
- `db/schema.ts` `sources` has `parentSource` (typeId ref), `metadata` jsonb (nullable), `deletedAt`, `type`.
- jsonb merge idiom (from `jobs/ingest-document.ts`): `metadata: sql\`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('title', ${value}::text)\``.
- LLM: `parseStructuredCompletion(client, body, opts)` + `createCompletionClient(userId, { task })` in `lib/ai.ts`; `modelForTask(task)` in `utils/models.ts` (falls back to `MODEL_ID_GRAPH_EXTRACTION`). Tests override the client via `setExtractionClientOverride(mock)` (`utils/test-overrides.ts`).
- BullMQ: `batchQueue` (`lib/queues.ts:32`), worker `else if (job.name === ...)` switch (`:98+`), `db = await useDatabase()` available in the worker.
- Maintenance route pattern: `routes/maintenance/recover-statusless-commitments.post.ts` (parse → call → return; no extra auth gating).

---

## Part B — decode text blobs

### Task 1: `sourceContentFromRaw` helper + wire into `/sources/get`

**Files:**

- Create: `src/lib/source-content.ts`
- Test: `src/lib/source-content.test.ts`
- Modify: `src/routes/sources/get.post.ts`
- Modify: `src/sources-get-route.test.ts` (add a text-blob case)

`source-content.ts` uses a **type-only** import of `RawResult`, so it never evaluates the env/MinIO-heavy `sources.ts` module — keeping the unit test env-free.

- [ ] **Step 1: Write the failing test**

Create `src/lib/source-content.test.ts`:

```ts
import { sourceContentFromRaw, TEXT_BLOB_MAX_BYTES } from "./source-content";
import { describe, expect, it } from "vitest";

describe("sourceContentFromRaw", () => {
  it("returns inline content with markdown format for documents", () => {
    expect(
      sourceContentFromRaw(
        { kind: "inline", sourceId: "src_x", content: "hi" },
        "document",
      ),
    ).toEqual({ text: "hi", format: "markdown" });
  });

  it("returns inline content with text format for non-documents", () => {
    expect(
      sourceContentFromRaw(
        { kind: "inline", sourceId: "src_x", content: "hi" },
        "conversation_message",
      ),
    ).toEqual({ text: "hi", format: "text" });
  });

  it("decodes a text/markdown blob within the size cap", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.from("# Heading\nbody", "utf-8"),
          contentType: "text/markdown",
        },
        "document",
      ),
    ).toEqual({ text: "# Heading\nbody", format: "markdown" });
  });

  it("returns null for a binary blob", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.from([0, 1, 2]),
          contentType: "application/pdf",
        },
        "document",
      ),
    ).toBeNull();
  });

  it("returns null for a text blob over the size cap", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.alloc(TEXT_BLOB_MAX_BYTES + 1, 0x61),
          contentType: "text/plain",
        },
        "document",
      ),
    ).toBeNull();
  });

  it("returns null when there is no payload", () => {
    expect(sourceContentFromRaw(undefined, "document")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/source-content.test.ts`
Expected: FAIL — module `./source-content` not found.

- [ ] **Step 3: Create the helper**

Create `src/lib/source-content.ts`:

```ts
import type { RawResult } from "./sources";

/** Max bytes of a text blob we decode inline in source-detail responses. */
export const TEXT_BLOB_MAX_BYTES = 256 * 1024;

/**
 * Convert a raw source payload into the `content` shape of the detail
 * response. Inline content is always returned; text blobs are decoded up to
 * `TEXT_BLOB_MAX_BYTES`; binary or over-cap blobs return `null` (no inline
 * preview).
 */
export function sourceContentFromRaw(
  raw: RawResult | undefined,
  sourceType: string,
): { text: string; format: "text" | "markdown" } | null {
  if (!raw) return null;
  const format: "text" | "markdown" =
    sourceType === "document" ? "markdown" : "text";
  if (raw.kind === "inline") return { text: raw.content, format };
  if (
    raw.contentType.startsWith("text/") &&
    raw.buffer.length <= TEXT_BLOB_MAX_BYTES
  ) {
    return { text: raw.buffer.toString("utf-8"), format };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/source-content.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire into the route**

In `src/routes/sources/get.post.ts`, add the import (next to the `sourceService` import):

```ts
import { sourceContentFromRaw } from "~/lib/source-content";
```

Replace the content-building block (currently lines 26–37):

```ts
  const [raw] = await sourceService.fetchRaw(userId, [sourceId]);
  const content =
    raw?.kind === "inline"
      ? {
          text: raw.content,
          format: source.type === "document" ? "markdown" : "text",
        }
      : null;

  return getSourceResponseSchema.parse({
    source: { ...source, content },
  });
```

with:

```ts
  const [raw] = await sourceService.fetchRaw(userId, [sourceId]);
  const content = sourceContentFromRaw(raw, source.type);

  return getSourceResponseSchema.parse({
    source: { ...source, content },
  });
```

- [ ] **Step 6: Add a route-level text-blob test**

In `src/sources-get-route.test.ts`, mirror the existing blob test (which mocks `sourceService.fetchRaw` and asserts `content` is `null` for an `application/pdf` blob — that test stays valid). Add a case where `fetchRaw` resolves to a text blob and the source type is `"document"`, asserting the text is decoded. Using the file's existing mock mechanism for `~/lib/sources`, add:

```ts
it("decodes a text/markdown blob into content", async () => {
  // Arrange: getSourceSummary returns a document source; fetchRaw returns a
  // text blob. (Match the mock setup already used by the pdf-blob test.)
  // fetchRaw mock return:
  //   [{ kind: "blob", sourceId, buffer: Buffer.from("# Notes\nbody"), contentType: "text/markdown" }]
  // includeContent: true in the request body.
  const response = await handler({} as H3Event);
  expect(response.source.content).toEqual({
    text: "# Notes\nbody",
    format: "markdown",
  });
});
```

Adapt the arrange section to the file's existing `vi.mock("~/lib/sources", ...)` / `vi.stubGlobal("readBody", ...)` helpers (read the top of the file).

- [ ] **Step 7: Verify + commit**

```bash
pnpm test src/sources-get-route.test.ts src/lib/source-content.test.ts
pnpm build:check   # or: pnpm typecheck
git add src/lib/source-content.ts src/lib/source-content.test.ts \
        src/routes/sources/get.post.ts src/sources-get-route.test.ts
git commit -m "✨ feat(sources): decode text/markdown blobs in source detail (256KB cap)"
```

---

## Part C — titles & labels

### Task 2: `deriveSourceLabel` for chat messages + use in summaries

**Files:**

- Create: `src/lib/source-label.ts`
- Test: `src/lib/source-label.test.ts`
- Modify: `src/lib/sources-read.ts` (both summary builders)

`source-label.ts` defines its own minimal, env-free metadata schema (so the unit test never loads `sources.ts`). It intentionally re-states the title/filename precedence from `deriveTitle` and extends it with a message-only "Role: first line" fallback.

- [ ] **Step 1: Write the failing test**

Create `src/lib/source-label.test.ts`:

```ts
import { deriveSourceLabel } from "./source-label";
import { describe, expect, it } from "vitest";

describe("deriveSourceLabel", () => {
  it("uses an explicit title", () => {
    expect(
      deriveSourceLabel({ type: "document", metadata: { title: "Plan" } }),
    ).toBe("Plan");
  });

  it("falls back to filename when no title", () => {
    expect(
      deriveSourceLabel({
        type: "document",
        metadata: { filename: "notes.md" },
      }),
    ).toBe("notes.md");
  });

  it("labels a chat message with role + first line", () => {
    expect(
      deriveSourceLabel({
        type: "conversation_message",
        metadata: {
          rawContent: "I'll send the report Friday\n(more)",
          role: "user",
        },
      }),
    ).toBe("User: I'll send the report Friday");
  });

  it("labels a chat message without a role using just the first line", () => {
    expect(
      deriveSourceLabel({
        type: "conversation_message",
        metadata: { rawContent: "hello there" },
      }),
    ).toBe("hello there");
  });

  it("returns null for a container source with no title", () => {
    expect(
      deriveSourceLabel({ type: "conversation", metadata: {} }),
    ).toBeNull();
  });

  it("returns null for a message with empty content", () => {
    expect(
      deriveSourceLabel({
        type: "conversation_message",
        metadata: { rawContent: "   " },
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/source-label.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the helper**

Create `src/lib/source-label.ts`:

```ts
import { z } from "zod";

const labelMetaSchema = z
  .object({
    title: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    rawContent: z.string().optional(),
    role: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

const MAX_SNIPPET = 80;

function firstNonEmptyLine(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

/**
 * Display label for a source. Mirrors `deriveTitle` (title ?? filename) and,
 * for individual chat messages (which never carry a title), falls back to
 * "Role: first line" of the message body. Returns null when nothing usable
 * exists. Populates the summary `title` field so lists never show a bare id.
 */
export function deriveSourceLabel({
  type,
  metadata,
}: {
  type: string;
  metadata: unknown;
}): string | null {
  const parsed = labelMetaSchema.safeParse(metadata ?? {});
  if (!parsed.success) return null;
  if (parsed.data.title) return parsed.data.title;
  if (parsed.data.filename) return parsed.data.filename;

  if (type === "conversation_message") {
    const raw = parsed.data.rawContent;
    if (typeof raw !== "string") return null;
    const line = firstNonEmptyLine(raw);
    if (!line) return null;
    const snippet = line.slice(0, MAX_SNIPPET);
    const role = parsed.data.role;
    return role
      ? `${role[0]!.toUpperCase()}${role.slice(1)}: ${snippet}`
      : snippet;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/source-label.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Use it in the summary builders**

In `src/lib/sources-read.ts`, add the import near the top:

```ts
import { deriveSourceLabel } from "./source-label";
```

In BOTH the list builder (~`:136-146`) and the detail builder (~`:189-199`), change:

```ts
    title: deriveTitle(row.metadata),
```

to:

```ts
    title: deriveSourceLabel({ type: row.type, metadata: row.metadata }),
```

(Leave `deriveTitle` exported and in place — it's still used by the title-gen idempotency guard in Task 4.)

- [ ] **Step 6: Verify + commit**

```bash
pnpm test src/lib/source-label.test.ts
pnpm build:check
git add src/lib/source-label.ts src/lib/source-label.test.ts src/lib/sources-read.ts
git commit -m "✨ feat(sources): derive Role:first-line labels for chat-message sources"
```

---

### Task 3: register the `source_title` model task

**Files:**

- Modify: `src/utils/models.ts` (ModelTask union + TASK_MODEL_OVERRIDES map)
- Modify: `src/utils/env.ts` (add `MODEL_ID_SOURCE_TITLE`)

- [ ] **Step 1: Add the env override**

In `src/utils/env.ts`, in the "Per-task model overrides" block (beside `MODEL_ID_CONVERSATION_SUMMARY` etc.), add:

```ts
  MODEL_ID_SOURCE_TITLE: z.string().min(1).optional(),
```

- [ ] **Step 2: Add the task to the union + override map**

In `src/utils/models.ts`, add `"source_title"` to the `ModelTask` union:

```ts
export type ModelTask =
  | "graph_extraction"
  | "document_spine"
  | "transcript_segmentation"
  | "conversation_summary"
  | "graph_cleanup"
  | "atlas"
  | "profile_synthesis"
  | "dream"
  | "deep_research"
  | "temporal_summary"
  | "commitment_presentation"
  | "source_title";
```

Then add the mapping to the `TASK_MODEL_OVERRIDES` object, mirroring the existing per-task entries (e.g. `conversation_summary: env.MODEL_ID_CONVERSATION_SUMMARY`):

```ts
  source_title: env.MODEL_ID_SOURCE_TITLE,
```

(Unset → `modelForTask("source_title")` falls back to `MODEL_ID_GRAPH_EXTRACTION`, so this works with no env change in dev.)

- [ ] **Step 3: Verify + commit**

```bash
pnpm build:check
git add src/utils/models.ts src/utils/env.ts
git commit -m "🔧 chore(models): add source_title model task"
```

---

### Task 4: title generation (prompt + LLM call + DB orchestration)

**Files:**

- Create: `src/lib/source-title.ts` (env-free top level: pure prompt + LLM-call helper using dynamic imports)
- Test: `src/lib/source-title.test.ts` (unit-tests the pure prompt builder)
- Create: `src/lib/jobs/generate-source-title.ts` (DB/queue orchestration)
- Test: `src/lib/jobs/generate-source-title.test.ts` (integration, via the repo's job-test harness)

- [ ] **Step 1: Write the failing prompt test**

Create `src/lib/source-title.test.ts`:

```ts
import { buildSourceTitlePrompt } from "./source-title";
import { describe, expect, it } from "vitest";

describe("buildSourceTitlePrompt", () => {
  it("includes the source type and content preview", () => {
    const prompt = buildSourceTitlePrompt({
      type: "conversation",
      contentPreview: "Let's plan the Q3 offsite in Lisbon",
    });
    expect(prompt).toContain("conversation");
    expect(prompt).toContain("Q3 offsite in Lisbon");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/source-title.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `source-title.ts`**

Heavy deps (`./ai`, `../utils/models`) are imported dynamically inside the async function so the module's top level stays env-free and the prompt builder is unit-testable in isolation.

```ts
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

/** Prompt for a concise, specific source title. */
export function buildSourceTitlePrompt({
  type,
  contentPreview,
}: {
  type: string;
  contentPreview: string;
}): string {
  return `You are titling a source in a personal knowledge graph.

Source type: ${type}
Content preview:
"""
${contentPreview}
"""

Write a single, specific title (max ~60 characters) capturing what this is about. No quotes, no trailing punctuation, no generic filler like "Conversation about". Return only the title.`;
}

/**
 * Generate a title from a content preview using the cheap `source_title`
 * model. Returns a trimmed title (≤255 chars) or null when the model produced
 * nothing usable. The OpenAI client is resolved via `createCompletionClient`,
 * which returns the test override when one is set.
 */
export async function generateTitleFromContent({
  userId,
  type,
  contentPreview,
}: {
  userId: string;
  type: string;
  contentPreview: string;
}): Promise<string | null> {
  const { createCompletionClient, parseStructuredCompletion } = await import(
    "./ai"
  );
  const { modelForTask } = await import("../utils/models");
  const client = await createCompletionClient(userId, { task: "source_title" });
  const completion = await parseStructuredCompletion(
    client,
    {
      messages: [
        {
          role: "user",
          content: buildSourceTitlePrompt({ type, contentPreview }),
        },
      ],
      model: modelForTask("source_title"),
      max_tokens: 64,
      response_format: zodResponseFormat(
        z.object({ title: z.string() }),
        "source_title",
      ),
    },
    { task: "source_title", userId },
  );
  const title = completion.choices[0]?.message.parsed?.title?.trim();
  return title && title.length > 0 ? title.slice(0, 255) : null;
}
```

- [ ] **Step 4: Run prompt test to verify it passes**

Run: `pnpm test src/lib/source-title.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Create the DB orchestration**

Create `src/lib/jobs/generate-source-title.ts`:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { TypeId } from "typeid-js";
import { sources } from "~/db/schema";
import { generateTitleFromContent } from "~/lib/source-title";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { deriveTitle } from "~/lib/sources-read";
import type { DrizzleDB } from "~/utils/db";

const PREVIEW_MAX_CHARS = 2000;
const MAX_CHILDREN = 40;

/**
 * Best-effort content preview for titling. Documents use their own inline /
 * text-blob body; containers (conversation, meeting_transcript,
 * external_conversation) have no body of their own, so we concatenate their
 * child sources' `rawContent`.
 */
async function gatherContentPreview(
  db: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<string | null> {
  const [own] = await sourceService.fetchRaw(userId, [sourceId]);
  if (own?.kind === "inline") return own.content.slice(0, PREVIEW_MAX_CHARS);
  if (own?.kind === "blob" && own.contentType.startsWith("text/")) {
    return own.buffer.toString("utf-8").slice(0, PREVIEW_MAX_CHARS);
  }

  const children = await db.query.sources.findMany({
    where: (s, { and: a, eq: e }) =>
      a(e(s.userId, userId), e(s.parentSource, sourceId)),
    orderBy: (s, { asc: ascFn }) => ascFn(s.createdAt),
    limit: MAX_CHILDREN,
  });
  const parts: string[] = [];
  for (const child of children) {
    const meta = sourceMetadataSchema.safeParse(child.metadata ?? {});
    const raw = meta.success ? meta.data.rawContent : undefined;
    if (typeof raw === "string" && raw.trim().length > 0) {
      parts.push(raw.trim());
      if (parts.join("\n").length >= PREVIEW_MAX_CHARS) break;
    }
  }
  const joined = parts.join("\n").slice(0, PREVIEW_MAX_CHARS);
  return joined.length > 0 ? joined : null;
}

/**
 * Generate and persist a title for a source that lacks one. Idempotent: a
 * no-op when the source already has a title (so re-enqueues and user-supplied
 * titles are safe). The UPDATE guards on the title still being absent.
 */
export async function generateSourceTitle(
  db: DrizzleDB,
  { userId, sourceId }: { userId: string; sourceId: TypeId<"source"> },
): Promise<{ generated: boolean }> {
  const [row] = await db
    .select({ type: sources.type, metadata: sources.metadata })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);
  if (!row) return { generated: false };
  if (deriveTitle(row.metadata)) return { generated: false };

  const preview = await gatherContentPreview(db, userId, sourceId);
  if (!preview) return { generated: false };

  const title = await generateTitleFromContent({
    userId,
    type: row.type,
    contentPreview: preview,
  });
  if (!title) return { generated: false };

  await db
    .update(sources)
    .set({
      metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('title', ${title}::text)`,
    })
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.userId, userId),
        sql`NOT (COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title')`,
      ),
    );
  return { generated: true };
}
```

Notes for the implementer: confirm the exact import paths/names by reading the file headers of `sources.ts` (for `sourceMetadataSchema`, `sourceService`), `sources-read.ts` (for `deriveTitle`), and `db/schema.ts` (for `sources`, and that the parent column is `parentSource`). Adjust `DrizzleDB`/`TypeId` import sources to match how other job files type them (e.g. `jobs/identity-reeval.ts`). The unused `asc` import may need removing if `orderBy` uses the callback form above — let lint guide you.

- [ ] **Step 6: Write the integration test**

Create `src/lib/jobs/generate-source-title.test.ts` following the **exact** ephemeral-Postgres + module-reset harness used by `src/lib/jobs/identity-reeval.test.ts` (read it for the `TEST_PG_*` env, drizzle migrate, and `vi.doMock("~/utils/db", …)` setup — reuse it verbatim). The test body:

```ts
// (after the same beforeAll/afterAll DB harness as identity-reeval.test.ts)
it("generates and stores a title for an untitled conversation", async () => {
  const { setExtractionClientOverride, clearExtractionClientOverride } =
    await import("~/utils/test-overrides");
  setExtractionClientOverride({
    chat: {
      completions: {
        parse: async () => ({
          choices: [{ message: { parsed: { title: "Q3 offsite planning" } } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      },
    },
  } as never);
  try {
    // Arrange: insert a `conversation` parent + a `conversation_message` child
    // with metadata.rawContent (use insertNewSources or direct inserts).
    // Act:
    const { generateSourceTitle } = await import("./generate-source-title");
    const result = await generateSourceTitle(db, {
      userId,
      sourceId: parentId,
    });
    // Assert:
    expect(result.generated).toBe(true);
    const [row] = await db
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(eq(sources.id, parentId));
    expect((row!.metadata as { title?: string }).title).toBe(
      "Q3 offsite planning",
    );
  } finally {
    clearExtractionClientOverride();
  }
});

it("is a no-op when the source already has a title", async () => {
  // Insert a source whose metadata.title is set; expect generated === false
  // and the title unchanged (no LLM override needed — guard returns early).
});
```

If `clearExtractionClientOverride` isn't the exact export name, read `src/utils/test-overrides.ts` and use the real teardown.

- [ ] **Step 7: Run integration test, verify, commit**

```bash
pnpm test src/lib/source-title.test.ts src/lib/jobs/generate-source-title.test.ts
pnpm build:check
git add src/lib/source-title.ts src/lib/source-title.test.ts \
        src/lib/jobs/generate-source-title.ts src/lib/jobs/generate-source-title.test.ts
git commit -m "✨ feat(sources): LLM title generation for container sources"
```

---

### Task 5: enqueue title-gen on container ingestion + worker handler

**Files:**

- Modify: `src/lib/queues.ts` (add `generate-source-title` worker branch)
- Modify: `src/lib/ingestion/insert-new-sources.ts` (enqueue after parent+children inserted)

- [ ] **Step 1: Add the worker branch**

In `src/lib/queues.ts`, inside the worker's `if/else if` chain (after an existing branch, before the final `else { … Unknown job type }`), add:

```ts
      } else if (job.name === "generate-source-title") {
        const { userId, sourceId } = z
          .object({ userId: z.string().min(1), sourceId: z.string().min(1) })
          .parse(job.data);
        const { generateSourceTitle } = await import(
          "./jobs/generate-source-title"
        );
        await generateSourceTitle(db, {
          userId,
          sourceId: sourceId as never,
        });
```

Ensure `z` is imported at the top of `queues.ts` (it likely already is; if not, add `import { z } from "zod";`). The `as never` keeps the `TypeId<"source">` param happy without importing typeid here; if the file already imports a source TypeId helper, prefer casting with that.

- [ ] **Step 2: Enqueue from the container choke point**

In `src/lib/ingestion/insert-new-sources.ts`, immediately **before** the function's `return { sourceId, … }` statement (where `sourceId` is the parent container source id), add:

```ts
// Best-effort, fire-and-forget container titling. Guarded inside the job, so
// enqueuing unconditionally is safe and idempotent. Dynamic import avoids a
// queues ⇄ ingestion import cycle.
const { batchQueue } = await import("../queues");
await batchQueue.add(
  "generate-source-title",
  { userId, sourceId },
  {
    attempts: 2,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: 20,
  },
);
```

Confirm by reading the file that the parent id variable is named `sourceId` (per the function's `{ sourceId, newSourceSourceIds, sourceRefs }` return) and that `userId` is in scope. This covers all containers — conversation, meeting_transcript, external_conversation — in one place.

- [ ] **Step 3: Verify + commit**

```bash
pnpm build:check
pnpm test --run
git add src/lib/queues.ts src/lib/ingestion/insert-new-sources.ts
git commit -m "✨ feat(sources): enqueue title-gen on container ingestion"
```

---

### Task 6: backfill endpoint for existing untitled containers

**Files:**

- Create: `src/routes/maintenance/backfill-source-titles.post.ts`

- [ ] **Step 1: Create the route**

Follow the maintenance-route pattern (`recover-statusless-commitments.post.ts`):

```ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { sources } from "~/db/schema";
import { batchQueue } from "~/lib/queues";
import { useDatabase } from "~/utils/db";

const requestSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().positive().max(5000).default(500),
});

/**
 * Enqueue title generation for the user's existing untitled container sources.
 * Idempotent: the job is a no-op for sources that already have a title, and a
 * deterministic jobId de-dupes concurrent runs.
 */
export default defineEventHandler(async (event) => {
  const { userId, limit } = requestSchema.parse(await readBody(event));
  const db = await useDatabase();
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        inArray(sources.type, [
          "conversation",
          "meeting_transcript",
          "external_conversation",
        ]),
        isNull(sources.deletedAt),
        sql`NOT (COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title')`,
      ),
    )
    .limit(limit);

  for (const row of rows) {
    await batchQueue.add(
      "generate-source-title",
      { userId, sourceId: row.id },
      {
        jobId: `source-title:${row.id}`,
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  return { enqueued: rows.length };
});
```

Confirm the `sources` import path (`~/db/schema`) and the `deletedAt` column name by reading `db/schema.ts`.

- [ ] **Step 2: Verify + commit**

```bash
pnpm build:check
git add src/routes/maintenance/backfill-source-titles.post.ts
git commit -m "✨ feat(maintenance): backfill titles for untitled container sources"
```

---

### Task 7: full verification

- [ ] **Step 1:** Run the whole suite + typecheck + lint:

```bash
pnpm build:check
pnpm test --run
pnpm lint
```

Expected: all green.

- [ ] **Step 2: Manual smoke (optional but recommended).** With Postgres + Redis + MinIO + the worker running and `MEMORY_OPENAI_*` set: ingest a short conversation, confirm a `generate-source-title` job runs and `metadata.title` gets populated; then `POST /sources/get` with `includeContent: true` for a >1KB text document and confirm `content.text` is returned (not null).

---

## Self-review notes

- **Spec coverage:** Part B → Task 1. Part C: message labels → Task 2; model task → Task 3; title-gen (containers, idempotent, content-from-children) → Task 4; ingestion enqueue → Task 5; backfill → Task 6. Part E (n8n node) → no new end-user endpoint, no node change (the backfill route is maintenance/admin).
- **Env-free testability:** `source-content.ts`, `source-label.ts`, and `source-title.ts`'s top level avoid importing the env/MinIO-coupled `sources.ts`/`models.ts` at module scope (type-only imports + dynamic imports), so their unit tests run without env. DB orchestration is integration-tested via the existing harness.
- **Idempotency:** title-gen guards on `deriveTitle` + a `NOT (… ? 'title')` UPDATE predicate; backfill uses deterministic `jobId`s. Safe to re-run.
- **Type consistency:** job payload is `{ userId, sourceId }` everywhere (worker, `insertNewSources` enqueue, backfill); `generateSourceTitle(db, { userId, sourceId })`; `generateTitleFromContent({ userId, type, contentPreview })`; `deriveSourceLabel({ type, metadata })`; `sourceContentFromRaw(raw, sourceType)`.
- **No DB migration / no SDK type change:** titles write to existing `metadata` jsonb; `content`/`title` response fields already exist.

## Implementation deviations (post-review)

- **On-ingest titling covers `conversation` + `meeting_transcript` only.** The enqueue lives at the single `insertNewSources` choke point, whose only two call sites are conversation and transcript ingestion. `document` sources are created elsewhere (`save-document.ts`, `routes/ingest/file.post.ts`) and are **not** titled on ingest — they keep the existing `deriveTitle` filename/title fallback, and the backfill endpoint covers any genuinely untitled ones. `external_conversation` has no ingestion path in the repo, so it's only ever reached by backfill. **Accepted** per the "containers only" scope: conversations/transcripts are the always-untitled pain point, documents almost always carry a filename, and the backfill closes the gap for existing rows — not worth editing the document-ingest paths for the rare new untitled document. Revisit by adding a guarded enqueue at the document choke point if untitled documents become common.
- **Prettier landed as one `🎨 style(sources)` commit** (the unformatted files spanned three earlier commits and interactive rebase is unavailable in this environment), rather than amending each.
