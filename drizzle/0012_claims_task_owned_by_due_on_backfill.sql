-- Phase 3 prerequisite — supersession backfill for OWNED_BY / DUE_ON on Task subjects.
--
-- The predicate-policy registry now resolves OWNED_BY and DUE_ON to
-- single_current_value + supersede_previous when the subject is a Task.
-- Existing rows from before this change are uniformly status='active' (no
-- supersession ever ran). The lifecycle engine only re-runs on the next
-- insert/delete event for a given (user, subject, predicate) triple, so we
-- recompute once here.
--
-- Idempotent — running it again is a no-op for any subject already in the
-- terminal shape this script writes. Scoped strictly to:
--   * predicate IN ('OWNED_BY', 'DUE_ON')
--   * subject node type = 'Task'
--   * status IN ('active', 'superseded')
-- so contradicted/retracted claims and other predicates are untouched.
--
-- Matches lifecycle.ts ordering: (statedAt ASC, createdAt ASC, trust_rank ASC, id ASC).
-- Trust rule: if the latest claim is assistant_inferred AND any prior is
-- user/user_confirmed, the assistant_inferred claim is demoted and the
-- latest non-inferred trusted candidate becomes active.

-- Drizzle wraps the file in a transaction.

WITH eligible AS (
  SELECT c."id",
         c."user_id",
         c."subject_node_id",
         c."predicate",
         c."stated_at",
         c."created_at",
         c."asserted_by_kind",
         c."valid_from",
         c."status",
         CASE c."asserted_by_kind"
           WHEN 'user' THEN 5
           WHEN 'user_confirmed' THEN 5
           WHEN 'participant' THEN 4
           WHEN 'document_author' THEN 3
           WHEN 'assistant_inferred' THEN 2
           WHEN 'system' THEN 1
           ELSE 0
         END AS trust_rank
  FROM "claims" c
  JOIN "nodes" n ON n."id" = c."subject_node_id"
  WHERE c."predicate" IN ('OWNED_BY', 'DUE_ON')
    AND n."node_type" = 'Task'
    AND c."status" IN ('active', 'superseded')
),
trust_demotion AS (
  -- Latest by stated_at within each (user, subject, predicate) group.
  SELECT DISTINCT ON ("user_id", "subject_node_id", "predicate")
         "user_id", "subject_node_id", "predicate",
         "id" AS latest_id,
         "asserted_by_kind" AS latest_kind
  FROM eligible
  ORDER BY "user_id", "subject_node_id", "predicate",
           "stated_at" DESC, "created_at" DESC, trust_rank DESC, "id" DESC
),
group_has_trusted AS (
  SELECT "user_id", "subject_node_id", "predicate"
  FROM eligible
  WHERE "asserted_by_kind" IN ('user', 'user_confirmed')
  GROUP BY "user_id", "subject_node_id", "predicate"
),
demoted AS (
  -- The trust-demoted claim id (if any) per group.
  SELECT t.latest_id AS demoted_id,
         t."user_id", t."subject_node_id", t."predicate"
  FROM trust_demotion t
  JOIN group_has_trusted g
    ON g."user_id" = t."user_id"
   AND g."subject_node_id" = t."subject_node_id"
   AND g."predicate" = t."predicate"
  WHERE t.latest_kind = 'assistant_inferred'
),
chain AS (
  -- Claims that participate in the normal supersession chain (i.e. excluding
  -- any trust-demoted claim).
  SELECT e.*
  FROM eligible e
  LEFT JOIN demoted d ON d.demoted_id = e."id"
  WHERE d.demoted_id IS NULL
),
chain_ordered AS (
  SELECT
    "id", "user_id", "subject_node_id", "predicate",
    "stated_at", "valid_from",
    LEAD("id") OVER w AS next_id,
    LEAD("stated_at") OVER w AS next_stated_at,
    ROW_NUMBER() OVER w AS rn,
    COUNT(*) OVER (PARTITION BY "user_id", "subject_node_id", "predicate") AS group_size
  FROM chain
  WINDOW w AS (
    PARTITION BY "user_id", "subject_node_id", "predicate"
    ORDER BY "stated_at" ASC, "created_at" ASC,
             (CASE "asserted_by_kind"
                WHEN 'user' THEN 5
                WHEN 'user_confirmed' THEN 5
                WHEN 'participant' THEN 4
                WHEN 'document_author' THEN 3
                WHEN 'assistant_inferred' THEN 2
                WHEN 'system' THEN 1
                ELSE 0
              END) ASC,
             "id" ASC
  )
),
chain_target AS (
  SELECT
    "id",
    CASE WHEN rn = group_size THEN 'active' ELSE 'superseded' END AS new_status,
    COALESCE("valid_from", "stated_at") AS new_valid_from,
    CASE WHEN rn = group_size THEN NULL ELSE next_stated_at END AS new_valid_to,
    CASE WHEN rn = group_size THEN NULL ELSE next_id END AS new_superseded_by
  FROM chain_ordered
),
latest_active_per_group AS (
  -- Used as the supersedor for the demoted claim.
  SELECT "user_id", "subject_node_id", "predicate", "id" AS latest_active_id
  FROM chain_ordered
  WHERE rn = group_size
),
demoted_target AS (
  SELECT
    e."id",
    'superseded'::text AS new_status,
    COALESCE(e."valid_from", e."stated_at") AS new_valid_from,
    e."stated_at" AS new_valid_to,
    la.latest_active_id AS new_superseded_by
  FROM eligible e
  JOIN demoted d ON d.demoted_id = e."id"
  LEFT JOIN latest_active_per_group la
    ON la."user_id" = e."user_id"
   AND la."subject_node_id" = e."subject_node_id"
   AND la."predicate" = e."predicate"
),
all_targets AS (
  SELECT * FROM chain_target
  UNION ALL
  SELECT * FROM demoted_target
)
UPDATE "claims" c
SET "status" = t.new_status,
    "valid_from" = t.new_valid_from,
    "valid_to" = t.new_valid_to,
    "superseded_by_claim_id" = t.new_superseded_by,
    "updated_at" = now()
FROM all_targets t
WHERE c."id" = t."id"
  AND (
    c."status" IS DISTINCT FROM t.new_status OR
    c."valid_from" IS DISTINCT FROM t.new_valid_from OR
    c."valid_to" IS DISTINCT FROM t.new_valid_to OR
    c."superseded_by_claim_id" IS DISTINCT FROM t.new_superseded_by
  );
