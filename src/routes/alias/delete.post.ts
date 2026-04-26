import { defineEventHandler, createError } from "h3";
import { deleteAlias } from "~/lib/alias";
import {
  deleteAliasRequestSchema,
  deleteAliasResponseSchema,
} from "~/lib/schemas/alias";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, aliasId } = deleteAliasRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const deleted = await deleteAlias(db, userId, aliasId);
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Alias not found" });
  }
  return deleteAliasResponseSchema.parse({ deleted: true });
});
