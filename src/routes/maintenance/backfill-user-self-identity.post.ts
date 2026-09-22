import { defineEventHandler, readBody } from "h3";
import { backfillUserSelfIdentity } from "~/lib/jobs/backfill-user-self-identity";
import { parseRequestBody } from "~/lib/request-body";
import {
  backfillUserSelfIdentityRequestSchema,
  backfillUserSelfIdentityResponseSchema,
} from "~/lib/schemas/backfill-user-self-identity";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, aliases } = parseRequestBody(
    backfillUserSelfIdentityRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await backfillUserSelfIdentity({
    db,
    userId,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
  });
  return backfillUserSelfIdentityResponseSchema.parse(result);
});
