-- Legacy soft deletes created before the lifecycle command existed must become
-- private at migration commit, not when a later maintenance worker happens to
-- run. The temporary sets keep this migration idempotent and let every delete
-- share one recursive containment expansion.
LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

CREATE TEMP TABLE legacy_retraction_sources ON COMMIT DROP AS
WITH RECURSIVE source_tree(user_id, source_id) AS (
  SELECT tombstone.user_id, tombstone.source_id
  FROM source_tombstones tombstone
  JOIN sources root
    ON root.user_id = tombstone.user_id
   AND root.id = tombstone.source_id
  WHERE tombstone.read_model_cleanup_state = 'pending'
  UNION
  SELECT child.user_id, child.id
  FROM sources child
  JOIN source_tree parent
    ON parent.user_id = child.user_id
   AND parent.source_id = child.parent_source
)
SELECT DISTINCT user_id, source_id FROM source_tree;--> statement-breakpoint

-- Evidence writers lock the same source rows in their liveness trigger. This
-- makes them either commit before the retraction deletes their output or wait
-- until the tombstones are visible and fail closed.
SELECT source.id
FROM sources source
JOIN legacy_retraction_sources cleanup
  ON cleanup.user_id = source.user_id
 AND cleanup.source_id = source.id
ORDER BY source.id
FOR UPDATE OF source;--> statement-breakpoint

CREATE TEMP TABLE legacy_retraction_nodes ON COMMIT DROP AS
WITH RECURSIVE affected_nodes(user_id, node_id) AS (
  SELECT cleanup.user_id, link.node_id
  FROM legacy_retraction_sources cleanup
  JOIN source_links link ON link.source_id = cleanup.source_id
  UNION
  -- Source-owned claims can project their source text onto an otherwise
  -- unlinked/shared subject, object, or asserting node. Include all three
  -- roles before deleting the claim itself so retrieval cannot retain it.
  SELECT cleanup.user_id, claim_node.node_id
  FROM legacy_retraction_sources cleanup
  JOIN claims claim
    ON claim.user_id = cleanup.user_id
   AND claim.source_id = cleanup.source_id
  CROSS JOIN LATERAL (
    VALUES (claim.subject_node_id), (claim.object_node_id), (claim.asserted_by_node_id)
  ) AS claim_node(node_id)
  WHERE claim_node.node_id IS NOT NULL
  UNION
  SELECT mapping.user_id, dependent.node_id
  FROM partition_node_mappings mapping
  JOIN affected_nodes affected
    ON affected.user_id = mapping.user_id
   AND (mapping.source_node_id = affected.node_id OR mapping.replacement_node_id = affected.node_id)
  CROSS JOIN LATERAL (
    VALUES (mapping.source_node_id), (mapping.replacement_node_id)
  ) AS dependent(node_id)
  WHERE dependent.node_id IS NOT NULL
)
SELECT DISTINCT user_id, node_id FROM affected_nodes;--> statement-breakpoint

-- Partition recovery artifacts can otherwise recreate a copied label after
-- the source evidence has gone. Remove every mapping/receipt/command touching
-- this source tree or one of its source/replacement nodes first.
DELETE FROM source_partition_commands command
USING legacy_retraction_sources cleanup
WHERE command.user_id = cleanup.user_id
  AND (
    command.source_id = cleanup.source_id
    OR command.source_ids @> jsonb_build_array(to_jsonb(cleanup.source_id))
    OR EXISTS (
      SELECT 1
      FROM legacy_retraction_nodes affected
      WHERE affected.user_id = command.user_id
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(command.node_mappings) mapping
          WHERE mapping->>'sourceNodeId' = affected.node_id
             OR mapping->>'replacementNodeId' = affected.node_id
        )
    )
  );--> statement-breakpoint

DELETE FROM partition_node_mappings mapping
USING legacy_retraction_nodes affected
WHERE mapping.user_id = affected.user_id
  AND (mapping.source_node_id = affected.node_id OR mapping.replacement_node_id = affected.node_id);--> statement-breakpoint

DELETE FROM partition_artifact_receipts receipt
USING legacy_retraction_nodes affected
WHERE receipt.user_id = affected.user_id
  AND receipt.source_node_id = affected.node_id;--> statement-breakpoint

DELETE FROM claims claim
USING legacy_retraction_sources cleanup
WHERE claim.user_id = cleanup.user_id
  AND claim.source_id = cleanup.source_id;--> statement-breakpoint

-- Remember definitions before their source observations disappear. A
-- definition survives only if another live observation still supports it;
-- otherwise it is source-derived retrieval content too.
CREATE TEMP TABLE legacy_retraction_metric_definitions ON COMMIT DROP AS
SELECT DISTINCT observation.user_id, observation.metric_definition_id
FROM metric_observations observation
JOIN legacy_retraction_sources cleanup
  ON cleanup.user_id = observation.user_id
 AND cleanup.source_id = observation.source_id;--> statement-breakpoint

-- A concurrent tombstone can remove another last supporting observation for
-- this same definition. Acquire every candidate definition in one stable
-- order before either deletion, then re-read the locked set. That gives the
-- later transaction a fresh support check after the earlier one commits.
SELECT definition.id
FROM metric_definitions definition
JOIN legacy_retraction_metric_definitions affected
  ON affected.user_id = definition.user_id
 AND affected.metric_definition_id = definition.id
ORDER BY definition.id
FOR UPDATE OF definition;--> statement-breakpoint

CREATE TEMP TABLE legacy_retraction_locked_metric_definitions ON COMMIT DROP AS
SELECT definition.user_id, definition.id, definition.review_task_node_id
FROM metric_definitions definition
JOIN legacy_retraction_metric_definitions affected
  ON affected.user_id = definition.user_id
 AND affected.metric_definition_id = definition.id;--> statement-breakpoint

DELETE FROM metric_observations observation
USING legacy_retraction_sources cleanup
WHERE observation.user_id = cleanup.user_id
  AND observation.source_id = cleanup.source_id;--> statement-breakpoint

CREATE TEMP TABLE legacy_retraction_unsupported_metric_definitions ON COMMIT DROP AS
SELECT definition.user_id, definition.id, definition.review_task_node_id
FROM metric_definitions definition
JOIN legacy_retraction_locked_metric_definitions affected
  ON affected.user_id = definition.user_id
 AND affected.id = definition.id
WHERE NOT EXISTS (
  SELECT 1
  FROM metric_observations observation
  WHERE observation.user_id = definition.user_id
    AND observation.metric_definition_id = definition.id
);--> statement-breakpoint

DELETE FROM metric_definition_embeddings embedding
USING legacy_retraction_unsupported_metric_definitions definition
WHERE embedding.metric_definition_id = definition.id;--> statement-breakpoint

DELETE FROM metric_definitions definition
USING legacy_retraction_unsupported_metric_definitions erased
WHERE definition.user_id = erased.user_id
  AND definition.id = erased.id;--> statement-breakpoint

-- A duplicate-review task belongs only to the erased definition. It may have
-- its own graph/claim projections, so remove it once no live definition or
-- non-manual source link can still own it. Generated review tasks receive the
-- generic manual source link from createNode; that is creation provenance, not
-- independent evidence for the metric proposal.
CREATE TEMP TABLE legacy_retraction_metric_review_nodes ON COMMIT DROP AS
SELECT DISTINCT erased.user_id, erased.review_task_node_id AS node_id
FROM legacy_retraction_unsupported_metric_definitions erased
JOIN nodes node
  ON node.user_id = erased.user_id
 AND node.id = erased.review_task_node_id
WHERE erased.review_task_node_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM metric_definitions definition
    WHERE definition.review_task_node_id = node.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM source_links link
    JOIN sources source ON source.id = link.source_id
    WHERE link.node_id = node.id
      AND source.type <> 'manual'
  );--> statement-breakpoint

-- Preserve the identifiers before DELETE triggers append their old payloads
-- to the feed. A live generic manual source cannot be redacted wholesale.
CREATE TEMP TABLE legacy_retraction_metric_review_claims ON COMMIT DROP AS
SELECT DISTINCT claim.user_id, claim.id
FROM claims claim
JOIN legacy_retraction_metric_review_nodes review
  ON review.user_id = claim.user_id
 AND (
   claim.subject_node_id = review.node_id
   OR claim.object_node_id = review.node_id
   OR claim.asserted_by_node_id = review.node_id
 );--> statement-breakpoint

CREATE TEMP TABLE legacy_retraction_metric_review_links ON COMMIT DROP AS
SELECT DISTINCT link.id
FROM source_links link
JOIN legacy_retraction_metric_review_nodes review
  ON review.node_id = link.node_id;--> statement-breakpoint

DELETE FROM claims claim
USING legacy_retraction_metric_review_nodes review
WHERE claim.user_id = review.user_id
  AND (
    claim.subject_node_id = review.node_id
    OR claim.object_node_id = review.node_id
    OR claim.asserted_by_node_id = review.node_id
  );--> statement-breakpoint

DELETE FROM node_metadata metadata
USING legacy_retraction_metric_review_nodes review
WHERE metadata.node_id = review.node_id;--> statement-breakpoint

DELETE FROM node_embeddings embedding
USING legacy_retraction_metric_review_nodes review
WHERE embedding.node_id = review.node_id;--> statement-breakpoint

DELETE FROM aliases alias
USING legacy_retraction_metric_review_nodes review
WHERE alias.user_id = review.user_id
  AND alias.canonical_node_id = review.node_id;--> statement-breakpoint

DELETE FROM node_redirects redirect
USING legacy_retraction_metric_review_nodes review
WHERE redirect.user_id = review.user_id
  AND (redirect.from_node_id = review.node_id OR redirect.to_node_id = review.node_id);--> statement-breakpoint

DELETE FROM nodes node
USING legacy_retraction_metric_review_nodes review
WHERE node.user_id = review.user_id
  AND node.id = review.node_id;--> statement-breakpoint

UPDATE memory_change_feed_events event
SET payload = jsonb_build_object('redacted', true, 'sourceDerivedReviewArtifact', true),
    provenance = NULL,
    freshness = NULL,
    status = 'tombstoned'
WHERE EXISTS (
  SELECT 1
  FROM legacy_retraction_metric_review_nodes review
  WHERE review.user_id = event.user_id
    AND event.entity_type IN ('node', 'commitment')
    AND event.entity_id = review.node_id
)
OR EXISTS (
  SELECT 1
  FROM legacy_retraction_metric_review_claims claim
  WHERE claim.user_id = event.user_id
    AND event.entity_type = 'claim'
    AND event.entity_id = claim.id
)
OR (
  event.entity_type = 'source_link'
  AND EXISTS (
    SELECT 1
    FROM legacy_retraction_metric_review_links link
    WHERE event.entity_id = link.id
  )
);--> statement-breakpoint

DELETE FROM commitment_presentations presentation
USING legacy_retraction_sources cleanup
WHERE presentation.user_id = cleanup.user_id
  AND presentation.source_id = cleanup.source_id;--> statement-breakpoint

DELETE FROM source_links link
USING legacy_retraction_sources cleanup
WHERE link.source_id = cleanup.source_id;--> statement-breakpoint

DELETE FROM node_metadata metadata
USING legacy_retraction_nodes affected
WHERE metadata.node_id = affected.node_id;--> statement-breakpoint

DELETE FROM node_embeddings embedding
USING legacy_retraction_nodes affected
WHERE embedding.node_id = affected.node_id;--> statement-breakpoint

DELETE FROM aliases alias
USING legacy_retraction_nodes affected
WHERE alias.user_id = affected.user_id
  AND alias.canonical_node_id = affected.node_id;--> statement-breakpoint

DELETE FROM node_redirects redirect
USING legacy_retraction_nodes affected
WHERE redirect.user_id = affected.user_id
  AND (redirect.from_node_id = affected.node_id OR redirect.to_node_id = affected.node_id);--> statement-breakpoint

DELETE FROM nodes node
USING legacy_retraction_nodes affected
WHERE node.user_id = affected.user_id
  AND node.id = affected.node_id
  AND NOT EXISTS (SELECT 1 FROM source_links link WHERE link.node_id = node.id)
  AND NOT EXISTS (
    SELECT 1 FROM claims claim
    WHERE claim.subject_node_id = node.id
       OR claim.object_node_id = node.id
       OR claim.asserted_by_node_id = node.id
  );--> statement-breakpoint

DELETE FROM user_profiles profile
USING (SELECT DISTINCT user_id FROM legacy_retraction_sources) cleanup
WHERE profile.user_id = cleanup.user_id;--> statement-breakpoint

DELETE FROM rollup_state rollup
USING (SELECT DISTINCT user_id FROM legacy_retraction_sources) cleanup
WHERE rollup.user_id = cleanup.user_id;--> statement-breakpoint

-- A legacy root can have live-looking descendants. Mark the whole containment
-- tree terminal and receipt each child so no retrieval or future maintenance
-- path can treat it as independent live evidence.
UPDATE sources source
SET metadata = '{}'::jsonb,
    content_type = NULL,
    content_length = NULL,
    deleted_at = COALESCE(source.deleted_at, now())
FROM legacy_retraction_sources cleanup
WHERE source.user_id = cleanup.user_id
  AND source.id = cleanup.source_id
  -- 0031 correctly forbids mutating an identity once its tombstone exists.
  -- The root already has its terminal deleted_at; only descendants need this
  -- descriptor scrub before receiving their own tombstone below.
  AND NOT EXISTS (
    SELECT 1
    FROM source_tombstones tombstone
    WHERE tombstone.user_id = source.user_id
      AND tombstone.source_id = source.id
  );--> statement-breakpoint

INSERT INTO source_tombstones (
  user_id, source_id, partition_key, state,
  storage_cleanup_state, storage_object_key, read_model_cleanup_state,
  erased_at, finalized_at
)
SELECT source.user_id, source.id, source.partition_key, 'purged',
       'pending', source.user_id || '/' || source.id, 'completed',
       COALESCE(source.deleted_at, now()), COALESCE(source.deleted_at, now())
FROM sources source
JOIN legacy_retraction_sources cleanup
  ON cleanup.user_id = source.user_id
 AND cleanup.source_id = source.id
ON CONFLICT (user_id, source_id) DO UPDATE
SET read_model_cleanup_state = 'completed', updated_at = now();--> statement-breakpoint
