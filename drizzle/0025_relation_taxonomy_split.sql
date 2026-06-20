-- Split overloaded OWNED_BY into task assignment and active ownership.
--
-- Canonical forms after this migration:
--   * Task ASSIGNED_TO Person
--   * Owner OWNS owned thing
--
-- Ambiguous legacy leftovers become RELATED_TO rather than forcing false
-- ownership semantics.

DROP INDEX IF EXISTS "claims_task_metadata_lookup_idx";--> statement-breakpoint

UPDATE "claims" c
SET "predicate" = 'ASSIGNED_TO',
    "updated_at" = now()
FROM "nodes" subject_node,
     "nodes" object_node
WHERE c."predicate" = 'OWNED_BY'
  AND c."subject_node_id" = subject_node."id"
  AND c."object_node_id" = object_node."id"
  AND subject_node."node_type" = 'Task'
  AND object_node."node_type" = 'Person';--> statement-breakpoint

UPDATE "claims" c
SET "predicate" = 'ASSIGNED_TO',
    "subject_node_id" = c."object_node_id",
    "object_node_id" = c."subject_node_id",
    "updated_at" = now()
FROM "nodes" object_node,
     "nodes" subject_node
WHERE c."predicate" = 'OWNED_BY'
  AND c."object_node_id" = object_node."id"
  AND c."subject_node_id" = subject_node."id"
  AND object_node."node_type" = 'Task'
  AND subject_node."node_type" = 'Person';--> statement-breakpoint

UPDATE "claims" c
SET "predicate" = 'OWNS',
    "subject_node_id" = c."object_node_id",
    "object_node_id" = c."subject_node_id",
    "updated_at" = now()
FROM "nodes" subject_node,
     "nodes" object_node
WHERE c."predicate" = 'OWNED_BY'
  AND c."subject_node_id" = subject_node."id"
  AND c."object_node_id" = object_node."id"
  AND subject_node."node_type" IN ('Location', 'Object', 'Concept', 'Media', 'Atlas')
  AND object_node."node_type" IN ('Person', 'Concept', 'Object');--> statement-breakpoint

UPDATE "claims" c
SET "predicate" = 'OWNS',
    "updated_at" = now()
FROM "nodes" subject_node,
     "nodes" object_node
WHERE c."predicate" = 'OWNED_BY'
  AND c."subject_node_id" = subject_node."id"
  AND c."object_node_id" = object_node."id"
  AND subject_node."node_type" IN ('Person', 'Concept', 'Object')
  AND object_node."node_type" IN ('Location', 'Object', 'Concept', 'Media', 'Atlas');--> statement-breakpoint

UPDATE "claims"
SET "predicate" = 'RELATED_TO',
    "updated_at" = now()
WHERE "predicate" = 'OWNED_BY';--> statement-breakpoint

CREATE INDEX "claims_task_metadata_lookup_idx"
  ON "claims" USING btree ("user_id","subject_node_id","predicate","stated_at" DESC NULLS LAST)
  WHERE "claims"."status" = 'active'
    AND "claims"."scope" = 'personal'
    AND "claims"."predicate" IN ('ASSIGNED_TO', 'DUE_ON')
    AND "claims"."object_node_id" IS NOT NULL;
