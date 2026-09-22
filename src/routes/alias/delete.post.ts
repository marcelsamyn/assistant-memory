import { defineEventHandler, createError } from "h3";
import { deleteAlias } from "~/lib/alias";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  deleteAliasRequestSchema,
  deleteAliasResponseSchema,
} from "~/lib/schemas/alias";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, aliasId } = parseRequestBody(
    deleteAliasRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const deleted = await deleteAlias(
    db,
    userId,
    aliasId,
    partitionKey,
    accessScope,
  );
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Alias not found" });
  }
  return deleteAliasResponseSchema.parse({ deleted: true });
});
