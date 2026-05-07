import { defineEventHandler } from "h3";
import {
  listSourcesRequestSchema,
  listSourcesResponseSchema,
} from "~/lib/schemas/sources";
import { listSourcesPage } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, type, limit, cursor } = listSourcesRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await listSourcesPage({ db, userId, type, limit, cursor });
  return listSourcesResponseSchema.parse(result);
});
