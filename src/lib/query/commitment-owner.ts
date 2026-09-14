import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Apply only after checking assignment endpoint access; labels never prove self identity. */
export function commitmentOwnerIsSelf(
  ownerNodeId: SQLWrapper,
  userId: string,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
      FROM nodes AS commitment_owner_node
      JOIN node_metadata AS commitment_owner_metadata
        ON commitment_owner_metadata.node_id = commitment_owner_node.id
     WHERE commitment_owner_node.id = ${ownerNodeId}
       AND commitment_owner_node.user_id = ${userId}
       AND commitment_owner_node.node_type = 'Person'
       AND commitment_owner_metadata.additional_data->'isUserSelf' = 'true'::jsonb
  )`;
}
