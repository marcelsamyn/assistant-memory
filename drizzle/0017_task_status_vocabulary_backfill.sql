-- Repair HAS_TASK_STATUS claims whose objectValue drifted off the canonical
-- TaskStatusEnum vocabulary ('pending' | 'in_progress' | 'done' | 'abandoned').
--
-- These reached the store via the extraction pipeline's bulk insert, which —
-- unlike `createClaim` — did not validate the value against the enum. The
-- open-commitments read model parses every active status with that enum, so a
-- single off-vocabulary row 500s the whole /commitments/open endpoint
-- (the ZodError that surfaced this).
--
-- This is the SQL twin of `coerceTaskStatus` in src/lib/claims/task-status.ts:
--   1. normalize: trim + lowercase + collapse runs of whitespace/hyphens to '_'
--   2. map the normalized form onto a canonical value (the four canonical
--      values are included so casing/spacing variants like 'Done' or
--      'In Progress' are repaired alongside synonyms like 'completed').
-- Genuinely unmappable values (e.g. 'blocked') are left untouched; the hardened
-- read path now skips them instead of throwing.
--
-- Idempotent: rows already on an exact canonical value don't match (guarded by
-- object_value <> canonical) and are left alone. Scoped strictly to
-- predicate = 'HAS_TASK_STATUS'. Keep this map in sync with task-status.ts.

UPDATE "claims" c
SET "object_value" = m.canonical,
    "updated_at" = now()
FROM (
  VALUES
    ('pending',     'pending'),
    ('in_progress', 'in_progress'),
    ('done',        'done'),
    ('abandoned',   'abandoned'),
    ('completed',   'done'),
    ('complete',    'done'),
    ('finished',    'done'),
    ('cancelled',   'abandoned'),
    ('canceled',    'abandoned'),
    ('dropped',     'abandoned'),
    ('todo',        'pending'),
    ('to_do',       'pending'),
    ('not_started', 'pending'),
    ('doing',       'in_progress'),
    ('started',     'in_progress'),
    ('wip',         'in_progress')
) AS m(synonym, canonical)
WHERE c."predicate" = 'HAS_TASK_STATUS'
  AND c."object_value" IS NOT NULL
  AND regexp_replace(lower(btrim(c."object_value")), '[[:space:]-]+', '_', 'g') = m.synonym
  AND c."object_value" <> m.canonical;
