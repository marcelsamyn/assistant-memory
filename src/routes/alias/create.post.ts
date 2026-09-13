import { defineEventHandler, createError } from "h3";
import { createAlias } from "~/lib/alias";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  createAliasRequestSchema,
  createAliasResponseSchema,
} from "~/lib/schemas/alias";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const aliasInput = {
    ...createAliasRequestSchema.parse(await readBody(event)),
    accessScope,
  };
  const db = await useDatabase();
  try {
    const alias = await createAlias(db, aliasInput);
    return createAliasResponseSchema.parse({ alias });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: error.message });
    }
    throw error;
  }
});
