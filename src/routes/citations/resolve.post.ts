import { defineEventHandler, readBody } from "h3";
import { resolveCitations } from "~/lib/resolve-citations";
import {
  resolveCitationsRequestSchema,
  resolveCitationsResponseSchema,
} from "~/lib/schemas/resolve-citations";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, ids } = resolveCitationsRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const citations = await resolveCitations(db, userId, ids, partitionKey);
  return resolveCitationsResponseSchema.parse({ citations });
});
