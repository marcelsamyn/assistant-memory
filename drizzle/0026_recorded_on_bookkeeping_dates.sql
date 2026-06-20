-- Split system bookkeeping dates from real-world occurrence dates.
--
-- Before RECORDED_ON existed, createNode/ensureSourceNode wrote generated
-- system claims shaped as:
--   * "<NodeType> node occurred on YYYY-MM-DD"
--   * "<NodeType> source occurred on YYYY-MM-DD"
--
-- Only those generated statement forms move to RECORDED_ON. User-authored
-- OCCURRED_ON facts, and system-authored facts with non-generated statements,
-- remain untouched.

UPDATE "claims" c
SET "predicate" = 'RECORDED_ON',
    "statement" = CASE
      WHEN c."statement" LIKE '% node occurred on %'
        THEN replace(c."statement", ' node occurred on ', ' node recorded on ')
      WHEN c."statement" LIKE '% source occurred on %'
        THEN replace(c."statement", ' source occurred on ', ' source recorded on ')
      ELSE c."statement"
    END,
    "updated_at" = now()
FROM "nodes" object_node
WHERE c."predicate" = 'OCCURRED_ON'
  AND c."asserted_by_kind" = 'system'
  AND c."object_node_id" = object_node."id"
  AND object_node."node_type" = 'Temporal'
  AND (
    c."statement" LIKE '% node occurred on %'
    OR c."statement" LIKE '% source occurred on %'
  );
