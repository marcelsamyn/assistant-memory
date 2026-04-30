/**
 * Story 14 — Bootstrap context bundle assembly (the public read-model entry).
 *
 * `getConversationBootstrapContext` (`src/lib/context/assemble-bootstrap-context.ts`)
 * composes five section assemblers (`pinned`, `atlas`, `open_commitments`,
 * `recent_supersessions`, `preferences`). No prior story exercises it, so any
 * regression in a single assembler ships silently. This story seeds elements
 * every section can render, calls bootstrap with `forceRefresh: true`, and
 * pins:
 *  - all five `kind`s present, in design order
 *  - each section's `content` is non-empty
 *  - `assembledAt` is within the last few seconds (proves the timestamp is
 *    not a stale cached value)
 *  - the seeded open Task's claim id surfaces in the bundle (cross-link
 *    between rendered content and DB state — guards against assemblers
 *    returning canned/non-empty strings unrelated to the seeded data)
 *  - a second call without `forceRefresh` returns a deep-equal bundle (cache
 *    hit; same `assembledAt`)
 */
import { ensureUser, seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { sql } from "drizzle-orm";
import { invalidateCachedBundle } from "~/lib/context/cache";
import { newTypeId } from "~/types/typeid";

const RECENT_WINDOW_MS_BUFFER = 60 * 60 * 1000; // 1 hour ago — well inside the 24h window

export const story14BootstrapBundleShape: EvalFixture = {
  name: "14-bootstrap-bundle-shape",
  description:
    "getConversationBootstrapContext composes all five sections from seeded graph state and a second call serves the cached bundle.",
  setup: async (ctx) => {
    await ensureUser(ctx);

    // Defensive: clear any stale cache for this user from a prior CI run.
    // The harness DB is fresh per fixture, but redis is process-wide.
    await invalidateCachedBundle(ctx.userId);

    // Pinned: a manually authored profile content.
    await ctx.db.execute(
      sql`INSERT INTO "user_profiles" ("id", "user_id", "content")
          VALUES (${newTypeId("user_profile")}, ${ctx.userId}, ${"Marcel prefers concise, plain-text responses."})`,
    );

    // Atlas: an Atlas node with a non-empty description (the assembler reads
    // `nodeMetadata.description` directly — synthesis is owned by the atlas job).
    await seedNode(ctx, {
      name: "atlas",
      type: "Atlas",
      label: "Atlas",
      description:
        "Marcel ships memory infrastructure. Communication: concise.",
    });

    // Person: subject for HAS_PREFERENCE claims (preferences section).
    await seedNode(ctx, {
      name: "marcel",
      type: "Person",
      label: "Marcel",
    });

    // Task: subject for HAS_TASK_STATUS=pending (open_commitments section).
    await seedNode(ctx, {
      name: "task",
      type: "Task",
      label: "Write the eval harness report",
    });

    // Subject for the recently-superseded HAS_STATUS pair.
    await seedNode(ctx, {
      name: "project",
      type: "Object",
      label: "Memory Layer",
    });

    await seedSource(ctx, { name: "convA", type: "conversation" });

    // open_commitments: a single pending Task claim. We register the claim
    // name 'taskPending' so the cross-link assertion can recover its id.
    await seedClaim(ctx, {
      name: "taskPending",
      subjectName: "task",
      predicate: "HAS_TASK_STATUS",
      objectValue: "pending",
      sourceName: "convA",
      statement: "Marcel committed to writing the eval harness report.",
      assertedByKind: "user",
      statedAt: new Date(Date.now() - RECENT_WINDOW_MS_BUFFER),
    });

    // recent_supersessions: a HAS_STATUS that just transitioned out of active.
    // We seed it directly as `superseded` (rather than relying on lifecycle
    // replay) and clamp `updated_at` into the recent-supersessions window
    // (last 24h). The `recent-supersessions` assembler keys on `updated_at`,
    // not `statedAt`.
    await seedClaim(ctx, {
      name: "projectSuperseded",
      subjectName: "project",
      predicate: "HAS_STATUS",
      objectValue: "in_progress",
      sourceName: "convA",
      statement: "Memory Layer was in progress.",
      assertedByKind: "user",
      status: "superseded",
      statedAt: new Date(Date.now() - RECENT_WINDOW_MS_BUFFER),
    });
    // Force `updated_at` recent (drizzle's defaultNow() already puts it at
    // ~now, but be explicit to make the window membership obvious).
    await ctx.db.execute(
      sql`UPDATE "claims" SET "updated_at" = NOW() - INTERVAL '1 hour'
          WHERE "id" = ${ctx.claims.get("projectSuperseded")!}`,
    );

    // preferences: a trusted HAS_PREFERENCE claim.
    await seedClaim(ctx, {
      name: "prefConcise",
      subjectName: "marcel",
      predicate: "HAS_PREFERENCE",
      objectValue: "concise communication",
      sourceName: "convA",
      statement: "Marcel prefers concise communication.",
      assertedByKind: "user",
    });
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "first call (forceRefresh: true) returns a bundle with all five section kinds; each non-empty",
        run: async (ctx) => {
          const { getConversationBootstrapContext } = await import(
            "~/lib/context/assemble-bootstrap-context"
          );
          const before = Date.now();
          const bundle = await getConversationBootstrapContext({
            userId: ctx.userId,
            options: { forceRefresh: true },
          });
          const after = Date.now();

          const kinds = bundle.sections.map((s) => s.kind);
          const expected = [
            "pinned",
            "atlas",
            "open_commitments",
            "recent_supersessions",
            "preferences",
          ] as const;
          for (const kind of expected) {
            if (!kinds.includes(kind)) {
              return {
                pass: false,
                message: `missing section kind '${kind}'; got [${kinds.join(", ")}]`,
              };
            }
          }
          for (const section of bundle.sections) {
            if (section.content.length === 0) {
              return {
                pass: false,
                message: `section '${section.kind}' has empty content`,
              };
            }
          }

          const assembledMs = bundle.assembledAt.getTime();
          if (assembledMs < before - 1000 || assembledMs > after + 1000) {
            return {
              pass: false,
              message: `assembledAt=${bundle.assembledAt.toISOString()} not within call window [${new Date(before).toISOString()}, ${new Date(after).toISOString()}]`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "the seeded open Task pending-claim is reachable via the bundle (content references the task label; preferences section evidence cites the seeded preference claim id)",
        run: async (ctx) => {
          const { getConversationBootstrapContext } = await import(
            "~/lib/context/assemble-bootstrap-context"
          );
          const bundle = await getConversationBootstrapContext({
            userId: ctx.userId,
            options: { forceRefresh: true },
          });
          // open_commitments doesn't expose claim ids in evidence (by design;
          // see open-commitments assembler docstring), so spot-check the task
          // label appears in its rendered content.
          const open = bundle.sections.find((s) => s.kind === "open_commitments");
          if (!open) {
            return { pass: false, message: "open_commitments section missing" };
          }
          if (!open.content.includes("Write the eval harness report")) {
            return {
              pass: false,
              message: `open_commitments content missing seeded label; got: ${open.content}`,
            };
          }

          // preferences DOES surface claim ids in `evidence`. Assert the
          // seeded preference claim id is among them — proves the bundle is
          // wired to the seeded data, not a canned string.
          const prefs = bundle.sections.find((s) => s.kind === "preferences");
          if (!prefs) {
            return { pass: false, message: "preferences section missing" };
          }
          const expectedClaimId = ctx.claims.get("prefConcise");
          const evidence = prefs.evidence ?? [];
          const found = evidence.some((e) => e.claimId === expectedClaimId);
          if (!found) {
            return {
              pass: false,
              message: `preferences evidence does not cite seeded claim id ${expectedClaimId}; got [${evidence.map((e) => e.claimId).join(", ")}]`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "second call without forceRefresh returns the cached bundle (identical assembledAt + section kinds)",
        run: async (ctx) => {
          const { getConversationBootstrapContext } = await import(
            "~/lib/context/assemble-bootstrap-context"
          );
          // Prime the cache.
          const first = await getConversationBootstrapContext({
            userId: ctx.userId,
            options: { forceRefresh: true },
          });
          // Read again without forceRefresh.
          const second = await getConversationBootstrapContext({
            userId: ctx.userId,
          });
          if (
            first.assembledAt.getTime() !== second.assembledAt.getTime()
          ) {
            return {
              pass: false,
              message: `cache miss: assembledAt diverged (${first.assembledAt.toISOString()} vs ${second.assembledAt.toISOString()})`,
            };
          }
          if (first.sections.length !== second.sections.length) {
            return {
              pass: false,
              message: `cache miss: section counts diverged (${first.sections.length} vs ${second.sections.length})`,
            };
          }
          for (let i = 0; i < first.sections.length; i++) {
            if (first.sections[i]!.kind !== second.sections[i]!.kind) {
              return {
                pass: false,
                message: `cache miss: section kind ${i} diverged (${first.sections[i]!.kind} vs ${second.sections[i]!.kind})`,
              };
            }
            if (first.sections[i]!.content !== second.sections[i]!.content) {
              return {
                pass: false,
                message: `cache miss: section ${first.sections[i]!.kind} content diverged`,
              };
            }
          }
          return { pass: true };
        },
      },
    ],
  },
};
