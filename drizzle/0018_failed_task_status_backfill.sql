-- Repair HAS_TASK_STATUS claims whose objectValue is 'failed' (in any casing)
-- onto the canonical TaskStatusEnum value 'abandoned'.
--
-- 'failed' is the only synonym not covered by 0017's seed map. It reaches the
-- store the same way: the extraction pipeline's bulk insert bypasses
-- `createClaim`'s enum validation, so the LLM's off-vocabulary status lands
-- verbatim. The open-commitments / commitments-list read models then skip the
-- row and log `Skipping Task … with off-vocabulary HAS_TASK_STATUS: "failed"`
-- on every read, and the task silently drops out of the commitment views.
--
-- 'abandoned' is the only terminal "closed but not completed" value in the
-- enum, which is what 'failed' means here (a task the user gave up on or could
-- not finish). This is the SQL twin of the `failed -> abandoned` entry added to
-- `coerceTaskStatus` in src/lib/claims/task-status.ts — keep the two in sync.
--
-- Idempotent and scoped strictly to predicate = 'HAS_TASK_STATUS'. Rows already
-- on a canonical value don't match (guarded by object_value <> 'abandoned').
--
-- Unlike 0017, this match needs no regexp_replace: 'failed' is a single token
-- with no whitespace or hyphens, so `lower(btrim(...))` already covers every
-- casing/padding variant `coerceTaskStatus` maps (e.g. 'Failed', ' failed ').

UPDATE "claims"
SET "object_value" = 'abandoned',
    "updated_at" = now()
WHERE "predicate" = 'HAS_TASK_STATUS'
  AND "object_value" IS NOT NULL
  AND lower(btrim("object_value")) = 'failed'
  AND "object_value" <> 'abandoned';
