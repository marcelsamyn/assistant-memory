import { defineEventHandler, readBody } from "h3";
import { resolveCitations } from "~/lib/resolve-citations";
import {
  resolveCitationsRequestSchema,
  resolveCitationsResponseSchema,
} from "~/lib/schemas/resolve-citations";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, ids } = resolveCitationsRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const citations = await resolveCitations(db, userId, ids);
  return resolveCitationsResponseSchema.parse({ citations });
});
