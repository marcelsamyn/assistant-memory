-- Introduce Organization as a first-class node type and retype
-- high-confidence historical organization nodes across all users.
--
-- Strong signal:
--   * an org-ish active WORKS_AT object is an employer organization.
--
-- Secondary signal:
--   * org-ish label/description plus an organization-compatible predicate
--     position (founded entity, affiliation endpoint, located/owning/using/
--     creating entity). This catches named friend groups and companies that
--     were previously squeezed into Person, Concept, or Object while avoiding
--     broad label-only rewrites.

WITH node_text AS (
  SELECT
    n."id",
    n."node_type",
    coalesce(nm."label", '') || ' ' ||
      coalesce(nm."canonical_label", '') AS "label_text",
    coalesce(nm."label", '') || ' ' ||
      coalesce(nm."canonical_label", '') || ' ' ||
      coalesce(nm."description", '') AS "search_text"
  FROM "nodes" n
  LEFT JOIN "node_metadata" nm ON nm."node_id" = n."id"
),
organization_candidates AS (
  SELECT DISTINCT nt."id"
  FROM node_text nt
  WHERE nt."node_type" IN ('Person', 'Concept', 'Object')
    AND nt."search_text" ~* '(^|[^[:alnum:]])(agency|association|bank|b\.?v\.?|business|chapter|club|collective|college|committee|community|company|cooperative|corp\.?|corporation|council|crew|department|employer|firm|foundation|gmbh|group|guild|inc\.?|institution|institute|labs?|llc|ltd\.?|ngo|non-?profit|office|org|organisation|organization|partnership|school|society|startup|studio|team|university)([^[:alnum:]]|$)'
    AND (
      nt."node_type" <> 'Person'
      OR (
        nt."label_text" ~* '(^|[^[:alnum:]])(agency|association|bank|b\.?v\.?|business|chapter|club|collective|college|committee|community|company|cooperative|corp\.?|corporation|council|crew|department|employer|firm|foundation|gmbh|group|guild|inc\.?|institution|institute|labs?|llc|ltd\.?|ngo|non-?profit|office|org|organisation|organization|partnership|school|society|startup|studio|team|university)([^[:alnum:]]|$)'
        AND NOT EXISTS (
          SELECT 1
          FROM "claims" c
          WHERE c."status" = 'active'
            AND c."subject_node_id" = nt."id"
            AND c."predicate" IN (
              'EXHIBITED_EMOTION',
              'FOUNDED',
              'HAS_GOAL',
              'HAS_PREFERENCE',
              'PARTICIPATED_IN',
              'WORKS_AT'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "claims" c
          WHERE c."status" = 'active'
            AND c."object_node_id" = nt."id"
            AND c."predicate" = 'ASSIGNED_TO'
        )
      )
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "claims" c
        WHERE c."status" = 'active'
          AND c."predicate" = 'WORKS_AT'
          AND c."object_node_id" = nt."id"
      )
      OR (
        EXISTS (
          SELECT 1
          FROM "claims" c
          WHERE c."status" = 'active'
            AND c."object_node_id" = nt."id"
            AND (
              c."predicate" IN ('FOUNDED', 'AFFILIATED_WITH')
              OR (
                c."predicate" = 'OWNS'
                AND nt."label_text" ~* '(^|[^[:alnum:]])(agency|association|bank|b\.?v\.?|business|chapter|club|collective|college|committee|community|company|cooperative|corp\.?|corporation|council|crew|department|employer|firm|foundation|gmbh|group|guild|inc\.?|institution|institute|labs?|llc|ltd\.?|ngo|non-?profit|office|org|organisation|organization|partnership|school|society|startup|studio|team|university)([^[:alnum:]]|$)'
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "claims" c
          WHERE c."status" = 'active'
            AND c."subject_node_id" = nt."id"
            AND c."predicate" IN (
              'AFFILIATED_WITH',
              'CREATED',
              'LOCATED_IN',
              'OWNS',
              'USES'
            )
            AND nt."label_text" ~* '(^|[^[:alnum:]])(agency|association|bank|b\.?v\.?|business|chapter|club|collective|college|committee|community|company|cooperative|corp\.?|corporation|council|crew|department|employer|firm|foundation|gmbh|group|guild|inc\.?|institution|institute|labs?|llc|ltd\.?|ngo|non-?profit|office|org|organisation|organization|partnership|school|society|startup|studio|team|university)([^[:alnum:]]|$)'
            AND NOT EXISTS (
              SELECT 1
              FROM "claims" event_claim
              WHERE event_claim."status" = 'active'
                AND event_claim."predicate" = 'PARTICIPATED_IN'
                AND event_claim."object_node_id" = nt."id"
            )
        )
      )
    )
)
UPDATE "nodes" n
SET "node_type" = 'Organization'
FROM organization_candidates oc
WHERE n."id" = oc."id";
