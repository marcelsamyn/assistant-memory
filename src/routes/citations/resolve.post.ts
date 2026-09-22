import { defineEventHandler, readBody } from "h3";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import { resolveCitations } from "~/lib/resolve-citations";
import {
  resolveCitationsRequestSchema,
  resolveCitationsResponseSchema,
} from "~/lib/schemas/resolve-citations";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, ids } = parseRequestBody(
    resolveCitationsRequestSchema,
    await readBody(event),
  );
  const accessScope = getRequestAccessScope(event);
  const db = await useDatabase();
  const citations = await resolveCitations(
    db,
    userId,
    ids,
    partitionKey,
    accessScope,
  );
  return resolveCitationsResponseSchema.parse({ citations });
});
